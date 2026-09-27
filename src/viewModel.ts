import { useState, useSyncExternalStore } from 'react';
import { cropForRatio, makeVariant, moveCrop, resizeCrop } from './domain';
import { EMPTY_DOCUMENT, type FrameDocument, type GuideKey, type Ratio, type ViewState } from './model';
import type { FrameRepository } from './repository';
import type { ImageService, WorkspaceFileService } from './service';
import { parseWorkspaceFile, serializeWorkspace, workspaceFileName } from './transfer';

type Listener = () => void;

export class FrameSenseViewModel {
  private state: ViewState = { phase: 'loading', document: structuredClone(EMPTY_DOCUMENT), compareOpen: false, notice: '', error: null, pendingImport: null };
  private readonly listeners = new Set<Listener>();
  // 待确认的导入文档只存在这里；用户确认前不会进入 state，更不会写进存储。
  private pendingDocument: FrameDocument | null = null;

  constructor(
    private readonly repository: FrameRepository,
    private readonly imageService: ImageService,
    private readonly fileService: WorkspaceFileService,
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

  async exportWorkspace(): Promise<void> {
    if (!this.state.document.image) return;
    this.patch({ notice: '正在导出工作台文件…', error: null });
    try {
      const contents = await serializeWorkspace(this.state.document);
      await this.fileService.save(workspaceFileName(), contents);
      this.patch({ notice: '工作台已导出为文件，可发送给他人或在其他设备上导入还原。' });
    } catch (error) {
      this.patch({ error: error instanceof Error ? error.message : '工作台导出失败，请稍后重试。' });
    }
  }

  async importWorkspaceFile(file: File): Promise<void> {
    if (this.pendingDocument) return;
    this.patch({ phase: 'loading', notice: '正在核验工作台文件…', error: null });
    let text: string;
    try {
      text = await this.fileService.read(file);
    } catch {
      this.restorePhase('文件读取失败，浏览器无法访问该文件，请重试。');
      return;
    }
    try {
      const result = await parseWorkspaceFile(text);
      if (!result.ok) {
        // 校验失败：明确报错，工作台与存储一律不动。
        this.restorePhase(result.message);
        return;
      }
      const { document, summary } = result;
      if (!this.state.document.image) {
        this.persist(document, '工作台已从文件还原。');
        return;
      }
      // 当前已有内容：先停下来让用户确认冲突如何处理，不直接覆盖。
      this.pendingDocument = document;
      this.patch({
        phase: 'editing',
        error: null,
        notice: '已读取工作台文件，请确认是否用文件内容替换当前工作台。',
        pendingImport: {
          imageName: summary.imageName,
          variants: summary.variants,
          guidesEnabled: summary.guidesEnabled,
          hasSubject: summary.hasSubject,
          exportedAt: summary.exportedAt,
          replacing: true,
        },
      });
    } catch {
      this.restorePhase('当前环境无法完成文件校验（可能需要在 HTTPS 下打开页面），已取消导入。');
    }
  }

  confirmWorkspaceImport(): void {
    const incoming = this.pendingDocument;
    if (!incoming) return;
    this.pendingDocument = null;
    this.patch({ pendingImport: null });
    this.persist(incoming, '工作台已从文件还原，之前的内容已被文件中的版本替换。');
  }

  cancelWorkspaceImport(): void {
    if (!this.pendingDocument) return;
    this.pendingDocument = null;
    this.patch({ pendingImport: null, phase: 'editing', notice: '已取消导入，当前工作台保持不变。' });
  }

  private restorePhase(message: string): void {
    this.patch({ phase: this.state.document.image ? 'editing' : 'ready', error: message });
  }
}

export function useFrameSenseViewModel(repository: FrameRepository, imageService: ImageService, fileService: WorkspaceFileService): [FrameSenseViewModel, ViewState] {
  const [viewModel] = useState(() => new FrameSenseViewModel(repository, imageService, fileService));
  const state = useSyncExternalStore(viewModel.subscribe, viewModel.getSnapshot, viewModel.getSnapshot);
  return [viewModel, state];
}
