import type { CropVariant, FrameDocument, GuideKey, ImageAsset, Ratio } from './model';

const GUIDE_KEYS: GuideKey[] = ['thirds', 'center', 'diagonal', 'golden'];
const ALLOWED_RATIOS = new Set<string>(['free', '1:1', '4:5', '16:9']);
const UNIT_EPSILON = 1e-9;

const clamp = (value: number, min = 0, max = 1): number => Math.min(max, Math.max(min, value));
const isFiniteNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const isNonEmptyString = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;
const isUnitValue = (value: number): boolean => value >= 0 && value <= 1;

export function normalizeCrop(crop: CropVariant): CropVariant {
  const width = clamp(crop.width, 0.12, 1);
  const height = clamp(crop.height, 0.12, 1);
  return {
    ...crop,
    x: clamp(crop.x, 0, 1 - width),
    y: clamp(crop.y, 0, 1 - height),
    width,
    height,
  };
}

export function cropForRatio(ratio: Ratio, imageRatio: number, current: CropVariant): CropVariant {
  if (ratio === 'free') return { ...current, ratio };
  const [w, h] = ratio.split(':').map(Number);
  const target = w / h;
  let width = 1;
  let height = 1;
  if (target > imageRatio) height = Math.min(1, imageRatio / target);
  else width = Math.min(1, target / imageRatio);
  return normalizeCrop({
    ...current,
    ratio,
    width,
    height,
    x: (1 - width) / 2,
    y: (1 - height) / 2,
  });
}

export function moveCrop(crop: CropVariant, dx: number, dy: number): CropVariant {
  return normalizeCrop({ ...crop, x: crop.x + dx, y: crop.y + dy });
}

export function resizeCrop(crop: CropVariant, width: number, height: number): CropVariant {
  const nextWidth = width;
  let nextHeight = height;
  if (crop.ratio !== 'free') {
    const [w, h] = crop.ratio.split(':').map(Number);
    nextHeight = nextWidth / (w / h);
  }
  return normalizeCrop({ ...crop, width: nextWidth, height: nextHeight });
}

export function makeVariant(crop: CropVariant, id: string): CropVariant {
  return { ...normalizeCrop(crop), id };
}

function validateImage(value: unknown): ImageAsset | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as Record<string, unknown>;
  // 导入文件必须自包含：只接受 data URL 图片，拒绝外链与其它协议。
  if (typeof candidate.src !== 'string' || !candidate.src.startsWith('data:image/')) return null;
  if (!isNonEmptyString(candidate.name)) return null;
  if (!isFiniteNumber(candidate.width) || candidate.width <= 0) return null;
  if (!isFiniteNumber(candidate.height) || candidate.height <= 0) return null;
  return { src: candidate.src, width: candidate.width, height: candidate.height, name: candidate.name };
}

function validateCrop(value: unknown): CropVariant | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as Record<string, unknown>;
  const id = candidate.id;
  const ratio = candidate.ratio;
  if (!isNonEmptyString(id) || !isNonEmptyString(ratio) || !ALLOWED_RATIOS.has(ratio)) return null;
  const { x, y, width, height } = candidate as Record<string, unknown>;
  if (!isFiniteNumber(x) || !isFiniteNumber(y) || !isFiniteNumber(width) || !isFiniteNumber(height)) return null;
  if (!isUnitValue(x) || !isUnitValue(y)) return null;
  if (width <= 0 || width > 1 || height <= 0 || height > 1) return null;
  if (x + width > 1 + UNIT_EPSILON || y + height > 1 + UNIT_EPSILON) return null;
  return { id, x, y, width, height, ratio };
}

/**
 * 严格校验一份 v1 工作区文档：任何字段缺失、类型错误或越界都返回 null，
 * 绝不把半成品交给调用方。校验通过时返回一个只含已知字段的干净副本。
 */
export function parseFrameDocument(value: unknown): FrameDocument | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as Record<string, unknown>;
  if (candidate.version !== 1) return null;

  let image: ImageAsset | null = null;
  if (candidate.image !== null) {
    image = validateImage(candidate.image);
    if (!image) return null;
  }

  if (!candidate.guides || typeof candidate.guides !== 'object') return null;
  const guideSource = candidate.guides as Record<string, unknown>;
  if (!GUIDE_KEYS.every((key) => typeof guideSource[key] === 'boolean')) return null;

  let subject: { x: number; y: number } | null = null;
  if (candidate.subject !== null) {
    if (!candidate.subject || typeof candidate.subject !== 'object') return null;
    const point = candidate.subject as Record<string, unknown>;
    if (!isFiniteNumber(point.x) || !isFiniteNumber(point.y) || !isUnitValue(point.x) || !isUnitValue(point.y)) return null;
    subject = { x: point.x, y: point.y };
  }

  const crop = validateCrop(candidate.crop);
  if (!crop) return null;

  if (!Array.isArray(candidate.variants) || candidate.variants.length > 8) return null;
  const variants: CropVariant[] = [];
  for (const item of candidate.variants) {
    const variant = validateCrop(item);
    if (!variant) return null;
    variants.push(variant);
  }

  return {
    version: 1,
    image,
    guides: {
      thirds: guideSource.thirds === true,
      center: guideSource.center === true,
      diagonal: guideSource.diagonal === true,
      golden: guideSource.golden === true,
    },
    subject,
    crop,
    variants,
  };
}

export function isFrameDocument(value: unknown): value is FrameDocument {
  return parseFrameDocument(value) !== null;
}
