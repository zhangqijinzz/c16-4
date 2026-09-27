import { useState, useSyncExternalStore } from 'react';
import { cropForRatio, makeVariant, moveCrop, resizeCrop } from './domain';
import { EMPTY_DOCUMENT, type FrameDocument, type GuideKey, type PendingImport, type Ratio, type ViewState } from './model';
import type { FrameRepository } from './repository';
import type { ImageService } from './service';
import {
  MAX_IMPORT_BYTES,
  exportFileName,
  parseWorkspace,
  serializeWorkspace,
  type ChecksumService,
  type FileTransferService,
  type TransferFailureReason,
} from './transfer';

type Listener = () => void;

const IMPORT_ERROR_MESSAGES: Record<TransferFailureReason, string> = {
  'too-large': '文件超过 30MB 上限，无法导入。',
  'not-json': '这不是有效的 JSON 文件，请确认选择的是 FrameSense 导出的工作区文件。',
  'not-envelope': '文件不是 FrameSense 工作区导出文件，当前工作区保持不变。',
  'future-version': '该文件由更新版本的 FrameSense 导出，当前版本无法读取，请升级后再试。',
  'checksum-mismatch': '文件校验未通过，可能已损坏或被修改过，当前工作区保持不变。',
  'invalid-document': '文件内容结构不完整或含非法数据，当前工作区保持不变。',
  'empty-document': '文件里没有任何图片与构图内容，无法导入。',
};

export class FrameSenseViewModel {
  private state: ViewState = { phase: 'loading', document: structuredClone(EMPTY_DOCUMENT), compareOpen: false, notice: '', error: null, pendingImport: null };
  private readonly listeners = new Set<Listener>();

  constructor(
    private readonly repository: FrameRepository,
    private readonly imageService: ImageService,
    private readonly transferFiles: FileTransferService,
    private readonly checksum: ChecksumService,
    private readonly appVersion = '1.0.0',
  ) {}

  getSnapshot = (): ViewState => this.state;

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  private patch(next: Partial<ViewState>): void {
    this.state = { ...this.state, ...next };
    this.listeners.forEach((listener) => listener());
  }

  private persist(document: FrameDocument, notice: string): void {
    this.patch({ document, phase: 'editing', notice, error: null });
    try {
      this.repository.save(document);
    } catch {
      this.patch({ phase: 'error', error: '本地保存失败，但当前编辑仍保留在页面中。请检查浏览器存储权限。' });
    }
  }

  async initialize(): Promise<void> {
    this.patch({ phase: 'loading', notice: '正在恢复上次工作状态…', error: null });
    try {
      const document = this.repository.load();
      this.patch({ document, phase: document.image ? 'editing' : 'ready', notice: document.image ? '已恢复上次工作状态' : '欢迎来到 FrameSense，先载入示例或导入图片。' });
    } catch {
      this.patch({ phase: 'error', notice: '未能读取历史状态，可继续新建工作。', error: '本地数据读取失败。' });
    }
  }

  async importImage(file: File): Promise<void> {
    this.patch({ phase: 'loading', notice: '正在载入图片…', error: null });
    try {
      const image = await this.imageService.readFile(file);
      const document: FrameDocument = { ...structuredClone(EMPTY_DOCUMENT), image };
      this.persist(document, '图片已载入，可以开始构图。');
    } catch (error) {
      this.patch({ phase: 'error', error: error instanceof Error ? error.message : '图片载入失败。' });
    }
  }

  loadDemo(): void {
    this.persist({ ...structuredClone(EMPTY_DOCUMENT), image: this.imageService.demo() }, '示例图片已载入。');
  }

  toggleGuide(guide: GuideKey): void {
    const document = { ...this.state.document, guides: { ...this.state.document.guides, [guide]: !this.state.document.guides[guide] } };
    this.persist(document, '辅助层已更新。');
  }

  setRatio(ratio: Ratio): void {
    const image = this.state.document.image;
    if (!image) return;
    const crop = cropForRatio(ratio, image.width / image.height, this.state.document.crop);
    this.persist({ ...this.state.document, crop }, `${ratio === 'free' ? '自由' : ratio} 裁切已应用。`);
  }

  moveCrop(dx: number, dy: number): void {
    this.persist({ ...this.state.document, crop: moveCrop(this.state.document.crop, dx, dy) }, '裁切位置已调整。');
  }

  resizeCrop(width: number, height: number): void {
    this.persist({ ...this.state.document, crop: resizeCrop(this.state.document.crop, width, height) }, '裁切范围已调整。');
  }

  markSubject(x: number, y: number): void {
    this.persist({ ...this.state.document, subject: { x: Math.min(1, Math.max(0, x)), y: Math.min(1, Math.max(0, y)) } }, '主体标记已更新。');
  }

  saveVariant(): void {
    const id = `variant-${Date.now()}`;
    const variant = makeVariant(this.state.document.crop, id);
    const document = { ...this.state.document, variants: [...this.state.document.variants, variant].slice(-8) };
    this.persist(document, `已保存裁切方案 ${document.variants.length}。`);
  }

  selectVariant(id: string): void {
    const variant = this.state.document.variants.find((item) => item.id === id);
    if (!variant) return;
    this.persist({ ...this.state.document, crop: { ...variant, id: 'current' } }, '已切换到保存的裁切方案。');
  }

  toggleCompare(): void {
    this.patch({ compareOpen: !this.state.compareOpen });
  }

  /** 导出当前工作区为自包含文件（图片以 data URL 内嵌）。 */
  async exportWorkspace(): Promise<void> {
    if (!this.state.document.image) return;
    this.patch({ notice: '正在导出工作区文件…', error: null });
    try {
      const exportedAt = new Date();
      const content = await serializeWorkspace(this.state.document, this.checksum, this.appVersion, exportedAt);
      this.transferFiles.download(exportFileName(exportedAt), content);
      this.patch({ notice: `工作区已导出（${exportedAt.toLocaleDateString()} 的构图状态），可在其它设备上导入还原。` });
    } catch {
      this.patch({ phase: 'error', error: '工作区导出失败，请重试。' });
    }
  }

  /**
   * 读取并校验不可信来源的工作区文件。校验失败：明确报错且不碰当前工作区；
   * 校验成功且当前已有内容：挂起待确认，由用户决定是否整体替换。
   */
  async importWorkspace(file: File): Promise<void> {
    if (this.state.pendingImport) return;
    if (file.size > MAX_IMPORT_BYTES) {
      this.patch({ error: IMPORT_ERROR_MESSAGES['too-large'], notice: '导入已取消，当前工作区保持不变。' });
      return;
    }
    this.patch({ phase: 'loading', notice: '正在校验工作区文件…', error: null });
    let text: string;
    try {
      text = await this.transferFiles.read(file);
    } catch {
      this.patch({ phase: this.state.document.image ? 'editing' : 'ready', error: '文件读取失败，请重试。' });
      return;
    }
    let result;
    try {
      result = await parseWorkspace(text, this.checksum);
    } catch {
      result = { ok: false as const, reason: 'not-json' as const };
    }
    if (!result.ok) {
      this.patch({
        phase: this.state.document.image ? 'editing' : 'ready',
        error: IMPORT_ERROR_MESSAGES[result.reason],
        notice: '导入已取消，当前工作区保持不变。',
      });
      return;
    }

    const pending: PendingImport = { document: result.document, fileName: file.name, exportedAt: result.exportedAt };
    if (this.state.document.image) {
      // 有未保存/正在编辑的内容：先讲清冲突处理方式，等待用户确认，不直接覆盖。
      this.patch({ phase: 'editing', pendingImport: pending, notice: '已读取工作区文件，等待确认是否替换当前内容。', error: null });
    } else {
      this.applyPendingImport(pending, '工作区已导入，构图状态已还原。');
    }
  }

  /** 用户在冲突对话框中确认：整体替换为导入的工作区。 */
  confirmImport(): void {
    const pending = this.state.pendingImport;
    if (!pending) return;
    this.applyPendingImport(pending, `已导入「${pending.fileName}」，工作台还原为导出当天的样子。`);
  }

  /** 用户取消导入：关闭对话框，当前工作区原样保留。 */
  cancelImport(): void {
    if (!this.state.pendingImport) return;
    this.patch({ pendingImport: null, notice: '已取消导入，当前工作区保持不变。' });
  }

  private applyPendingImport(pending: PendingImport, notice: string): void {
    this.patch({ compareOpen: false, pendingImport: null });
    this.persist(structuredClone(pending.document), notice);
  }
}

export function useFrameSenseViewModel(
  repository: FrameRepository,
  imageService: ImageService,
  transferFiles: FileTransferService,
  checksum: ChecksumService,
): [FrameSenseViewModel, ViewState] {
  const [viewModel] = useState(() => new FrameSenseViewModel(repository, imageService, transferFiles, checksum));
  const state = useSyncExternalStore(viewModel.subscribe, viewModel.getSnapshot, viewModel.getSnapshot);
  return [viewModel, state];
}
