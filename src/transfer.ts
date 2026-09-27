import { normalizeCrop } from './domain';
import type { FrameDocument, GuideKey } from './model';

export const TRANSFER_FORMAT = 'framesense.workspace';
export const TRANSFER_KIND = 1;
export const DOCUMENT_VERSION = 1;

const GUIDE_KEYS: GuideKey[] = ['thirds', 'center', 'diagonal', 'golden'];
const VALID_RATIOS = new Set(['free', '1:1', '4:5', '16:9']);
const MAX_VARIANTS = 8;
const BOUND_EPS = 1e-6;

export interface WorkspaceEnvelope {
  format: string;
  kind: number;
  exportedAt: string;
  checksum: string;
  document: unknown;
}

export interface WorkspaceSummary {
  imageName: string;
  imageWidth: number;
  imageHeight: number;
  variants: number;
  guidesEnabled: number;
  hasSubject: boolean;
  exportedAt: string;
}

export interface PendingWorkspaceImport {
  document: FrameDocument;
  summary: WorkspaceSummary;
}

export type ImportFailureReason = 'unreadable' | 'format' | 'version' | 'checksum' | 'content';

export interface ImportFailure {
  ok: false;
  reason: ImportFailureReason;
  message: string;
}

export interface ImportSuccess {
  ok: true;
  document: FrameDocument;
  summary: WorkspaceSummary;
}

export type ImportResult = ImportSuccess | ImportFailure;

export type ChecksumFn = (text: string) => Promise<string>;

export const sha256Hex: ChecksumFn = async (text) => {
  const data = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
};

const failure = (reason: ImportFailureReason, message: string): ImportFailure => ({ ok: false, reason, message });

/**
 * 校验和只覆盖业务内容，信封里的 checksum 字段自身不参与计算。
 * 两侧都用固定的键顺序重新序列化，文件里任何字节级改动都会导致对不上。
 */
function canonicalPayload(parts: { format: string; kind: number; exportedAt: string; document: unknown }): string {
  return JSON.stringify({ format: parts.format, kind: parts.kind, exportedAt: parts.exportedAt, document: parts.document });
}

export async function serializeWorkspace(
  document: FrameDocument,
  now: Date = new Date(),
  checksum: ChecksumFn = sha256Hex,
): Promise<string> {
  if (!document.image) throw new Error('当前工作台还没有图片，没有可导出的内容。');
  const exportedAt = now.toISOString();
  const checksumValue = await checksum(canonicalPayload({ format: TRANSFER_FORMAT, kind: TRANSFER_KIND, exportedAt, document }));
  const envelope: WorkspaceEnvelope = { format: TRANSFER_FORMAT, kind: TRANSFER_KIND, exportedAt, checksum: checksumValue, document };
  return JSON.stringify(envelope, null, 2);
}

const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const isFiniteNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const isUnitInterval = (value: unknown): boolean => isFiniteNumber(value) && value >= 0 && value <= 1;

function validateImage(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return typeof value.src === 'string'
    && value.src.startsWith('data:image/')
    && typeof value.name === 'string'
    && value.name.length > 0
    && isFiniteNumber(value.width) && value.width > 0
    && isFiniteNumber(value.height) && value.height > 0;
}

function validateGuides(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const keys = Object.keys(value);
  return keys.length === GUIDE_KEYS.length && GUIDE_KEYS.every((key) => typeof value[key] === 'boolean');
}

function validateCrop(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return typeof value.id === 'string' && value.id.length > 0
    && typeof value.ratio === 'string' && VALID_RATIOS.has(value.ratio)
    && isUnitInterval(value.x) && isUnitInterval(value.y)
    && isFiniteNumber(value.width) && value.width >= 0.12 && value.width <= 1
    && isFiniteNumber(value.height) && value.height >= 0.12 && value.height <= 1
    && (value.x as number) + (value.width as number) <= 1 + BOUND_EPS
    && (value.y as number) + (value.height as number) <= 1 + BOUND_EPS;
}

function validateDocument(value: unknown): value is FrameDocument {
  if (!isRecord(value)) return false;
  if (value.version !== DOCUMENT_VERSION) return false;
  if (!validateImage(value.image)) return false;
  if (!validateGuides(value.guides)) return false;
  if (value.subject !== null && !(isRecord(value.subject) && isUnitInterval(value.subject.x) && isUnitInterval(value.subject.y))) return false;
  if (!validateCrop(value.crop)) return false;
  if (!Array.isArray(value.variants) || value.variants.length > MAX_VARIANTS) return false;
  return value.variants.every((variant) => validateCrop(variant));
}

function summarize(document: FrameDocument, exportedAt: string): WorkspaceSummary {
  return {
    imageName: document.image?.name ?? '',
    imageWidth: document.image?.width ?? 0,
    imageHeight: document.image?.height ?? 0,
    variants: document.variants.length,
    guidesEnabled: GUIDE_KEYS.filter((key) => document.guides[key]).length,
    hasSubject: document.subject !== null,
    exportedAt,
  };
}

/**
 * 解析并核验工作台导出文件。
 * 任何一步失败都返回明确原因，绝不抛出、绝不返回半成品文档。
 */
export async function parseWorkspaceFile(text: string, checksum: ChecksumFn = sha256Hex): Promise<ImportResult> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return failure('format', '文件不是有效的 JSON，无法识别为 FrameSense 工作台文件。');
  }
  if (!isRecord(parsed) || parsed.format !== TRANSFER_FORMAT) {
    return failure('format', '文件格式无法识别：不是 FrameSense 工作台导出文件。');
  }
  if (!isFiniteNumber(parsed.kind) || parsed.kind < 1) {
    return failure('format', '文件缺少有效的格式版本信息，无法打开。');
  }
  if (parsed.kind > TRANSFER_KIND) {
    return failure('version', '该文件由更新版本的 FrameSense 导出，当前版本无法打开，请先升级 FrameSense。');
  }
  if (typeof parsed.exportedAt !== 'string' || typeof parsed.checksum !== 'string' || !isRecord(parsed.document)) {
    return failure('format', '文件结构不完整，缺少导出时间、校验和或工作台数据。');
  }
  if (Number.isNaN(Date.parse(parsed.exportedAt))) {
    return failure('content', '文件记录的导出时间无效，无法安全还原。');
  }

  const expected = await checksum(canonicalPayload({ format: parsed.format, kind: parsed.kind, exportedAt: parsed.exportedAt, document: parsed.document }));
  if (expected !== parsed.checksum) {
    return failure('checksum', '文件校验未通过：内容可能已损坏或被修改，已取消导入，当前工作台保持不变。');
  }

  if (!validateDocument(parsed.document)) {
    // 内部文档版本比当前新：归类为版本问题，提示升级而不是笼统的内容损坏。
    const innerVersion = (parsed.document as Record<string, unknown>).version;
    if (typeof innerVersion === 'number' && innerVersion > DOCUMENT_VERSION) {
      return failure('version', '该文件来自更新版本的 FrameSense，当前版本无法打开，请先升级 FrameSense。');
    }
    return failure('content', '文件内容不完整或不符合规范，无法安全还原工作台，当前工作台保持不变。');
  }

  // 校验通过后再统一走一遍领域归一化，保证脏值进不了运行时状态。
  const source = parsed.document;
  const document: FrameDocument = {
    version: DOCUMENT_VERSION,
    image: source.image,
    guides: {
      thirds: source.guides.thirds === true,
      center: source.guides.center === true,
      diagonal: source.guides.diagonal === true,
      golden: source.guides.golden === true,
    },
    subject: source.subject ? { x: source.subject.x, y: source.subject.y } : null,
    crop: { ...normalizeCrop(source.crop), id: 'current' },
    variants: source.variants.map((variant, index) => {
      const normalized = normalizeCrop(variant);
      return { ...normalized, id: variant.id || `variant-${index}` };
    }),
  };
  return { ok: true, document, summary: summarize(document, parsed.exportedAt) };
}

export function workspaceFileName(now: Date = new Date()): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`;
  return `framesense-${stamp}.framesense.json`;
}
