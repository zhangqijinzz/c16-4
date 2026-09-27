import { parseFrameDocument } from './domain';
import type { FrameDocument } from './model';

/** 传输文件格式版本：结构不兼容的未来版本会被识别并拒绝。 */
export const FORMAT_VERSION = 1;
export const FORMAT_APP = 'framesense';
/** 单个工作区文件大小上限（约 30MB），防止载入异常巨大的文件拖垮页面。 */
export const MAX_IMPORT_BYTES = 30 * 1024 * 1024;

export interface ExportEnvelope {
  format: typeof FORMAT_APP;
  formatVersion: number;
  appVersion: string;
  exportedAt: string;
  payload: FrameDocument;
  /** 对 payload 规范化 JSON 计算的 SHA-256，十六进制小写。 */
  checksum: string;
}

export type TransferFailureReason =
  | 'too-large'
  | 'not-json'
  | 'not-envelope'
  | 'future-version'
  | 'checksum-mismatch'
  | 'invalid-document'
  | 'empty-document';

export interface TransferFailure {
  ok: false;
  reason: TransferFailureReason;
}

export interface TransferSuccess {
  ok: true;
  document: FrameDocument;
  exportedAt: string | null;
}

export type TransferResult = TransferSuccess | TransferFailure;

export interface ChecksumService {
  sha256(value: string): Promise<string>;
}

export class WebCryptoChecksumService implements ChecksumService {
  async sha256(value: string): Promise<string> {
    const bytes = new TextEncoder().encode(value);
    const digest = await window.crypto.subtle.digest('SHA-256', bytes);
    return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
  }
}

/** 校验和只覆盖文档载荷；键按固定顺序输出，避免对象键顺序造成误报。 */
function canonicalPayload(document: FrameDocument): string {
  return JSON.stringify({
    version: document.version,
    image: document.image,
    guides: document.guides,
    subject: document.subject,
    crop: document.crop,
    variants: document.variants,
  });
}

export async function serializeWorkspace(
  document: FrameDocument,
  checksumService: ChecksumService,
  appVersion = '1.0.0',
  exportedAt = new Date(),
): Promise<string> {
  const payload = structuredClone(document);
  const checksum = await checksumService.sha256(canonicalPayload(payload));
  const envelope: ExportEnvelope = {
    format: FORMAT_APP,
    formatVersion: FORMAT_VERSION,
    appVersion,
    exportedAt: exportedAt.toISOString(),
    payload,
    checksum,
  };
  return JSON.stringify(envelope, null, 2);
}

export function exportFileName(exportedAt = new Date()): string {
  const stamp = exportedAt.toISOString().slice(0, 19).replace(/[:T]/g, '-');
  return `framesense-workspace-${stamp}.json`;
}

function isEnvelopeShape(value: unknown): value is { format: typeof FORMAT_APP; formatVersion: number; payload: unknown; checksum: unknown; exportedAt: unknown } {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Record<string, unknown>;
  return candidate.format === FORMAT_APP && typeof candidate.formatVersion === 'number';
}

function hashesEqual(actual: string, expected: string): boolean {
  if (actual.length !== expected.length) return false;
  let mismatch = 0;
  for (let i = 0; i < actual.length; i += 1) {
    mismatch |= actual.charCodeAt(i) ^ expected.charCodeAt(i);
  }
  return mismatch === 0;
}

/**
 * 解析不可信来源的工作区文件。任何一环不通过都返回明确的失败原因，
 * 调用方据此提示用户并保持当前工作台原样不动。
 */
export async function parseWorkspace(text: string, checksumService: ChecksumService): Promise<TransferResult> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, reason: 'not-json' };
  }
  if (!isEnvelopeShape(parsed)) return { ok: false, reason: 'not-envelope' };
  if (parsed.formatVersion > FORMAT_VERSION) return { ok: false, reason: 'future-version' };
  if (parsed.formatVersion < FORMAT_VERSION) return { ok: false, reason: 'not-envelope' };

  const document = parseFrameDocument(parsed.payload);
  if (!document) return { ok: false, reason: 'invalid-document' };
  if (!document.image) return { ok: false, reason: 'empty-document' };

  if (typeof parsed.checksum !== 'string' || parsed.checksum.length === 0) {
    return { ok: false, reason: 'checksum-mismatch' };
  }
  const actual = await checksumService.sha256(canonicalPayload(document));
  if (!hashesEqual(actual, parsed.checksum.trim().toLowerCase())) {
    return { ok: false, reason: 'checksum-mismatch' };
  }

  const exportedAt = typeof parsed.exportedAt === 'string' ? parsed.exportedAt : null;
  return { ok: true, document, exportedAt };
}

/** 浏览器侧文件读写：下载导出文件、读取待导入文件。 */
export interface FileTransferService {
  download(fileName: string, content: string): void;
  read(file: File): Promise<string>;
}

export class BrowserFileTransferService implements FileTransferService {
  download(fileName: string, content: string): void {
    const blob = new Blob([content], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = fileName;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
  }

  read(file: File): Promise<string> {
    return file.text();
  }
}
