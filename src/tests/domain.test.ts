import { describe, expect, it } from 'vitest';
import { cropForRatio, moveCrop, parseFrameDocument, resizeCrop } from '../domain';
import { DEFAULT_CROP, type FrameDocument } from '../model';

describe('crop domain rules', () => {
  it('fits a 1:1 crop inside a wide image and centers it', () => {
    const crop = cropForRatio('1:1', 1.5, DEFAULT_CROP);
    expect(crop.width).toBeCloseTo(2 / 3);
    expect(crop.height).toBe(1);
    expect(crop.x).toBeCloseTo(1 / 6);
  });

  it('clamps movement to the image boundary', () => {
    const crop = moveCrop({ ...DEFAULT_CROP, width: 0.5, height: 0.5 }, 0.9, -0.9);
    expect(crop.x).toBe(0.5);
    expect(crop.y).toBe(0);
  });

  it('keeps a selected ratio while resizing', () => {
    const crop = resizeCrop({ ...DEFAULT_CROP, ratio: '16:9', width: 0.5, height: 0.28125 }, 0.8, 0.8);
    expect(crop.width).toBe(0.8);
    expect(crop.height).toBeCloseTo(0.45);
  });
});

function validDocument(): FrameDocument {
  return {
    version: 1,
    image: { src: 'data:image/png;base64,QQ', width: 640, height: 480, name: 'a.png' },
    guides: { thirds: true, center: false, diagonal: false, golden: false },
    subject: null,
    crop: { id: 'current', x: 0, y: 0, width: 1, height: 1, ratio: 'free' },
    variants: [],
  };
}

describe('parseFrameDocument strict validation', () => {
  it('accepts a well-formed document and strips unknown fields', () => {
    const raw = { ...validDocument(), injected: 'drop-me' } as unknown;
    const parsed = parseFrameDocument(raw);
    expect(parsed).not.toBeNull();
    expect(parsed && 'injected' in parsed).toBe(false);
  });

  it('rejects wrong versions and non-objects', () => {
    expect(parseFrameDocument(null)).toBeNull();
    expect(parseFrameDocument('nope')).toBeNull();
    expect(parseFrameDocument({ ...validDocument(), version: 2 })).toBeNull();
    expect(parseFrameDocument({ ...validDocument(), version: 0 })).toBeNull();
  });

  it('rejects missing or mistyped guide flags', () => {
    expect(parseFrameDocument({ ...validDocument(), guides: {} })).toBeNull();
    expect(parseFrameDocument({ ...validDocument(), guides: { thirds: 'yes', center: false, diagonal: false, golden: false } })).toBeNull();
  });

  it('rejects out-of-range subject points', () => {
    expect(parseFrameDocument({ ...validDocument(), subject: { x: 1.2, y: 0.5 } })).toBeNull();
    expect(parseFrameDocument({ ...validDocument(), subject: { x: 0.5, y: NaN } })).toBeNull();
  });

  it('rejects crops that leave the unit frame', () => {
    expect(parseFrameDocument({ ...validDocument(), crop: { ...validDocument().crop, x: 0.6, width: 0.6 } })).toBeNull();
    expect(parseFrameDocument({ ...validDocument(), crop: { ...validDocument().crop, width: 0 } })).toBeNull();
    expect(parseFrameDocument({ ...validDocument(), crop: { ...validDocument().crop, ratio: '3:2' } })).toBeNull();
  });

  it('rejects non-self-contained images but accepts image-less documents', () => {
    const external = validDocument();
    external.image = { ...external.image!, src: 'https://example.com/a.png' };
    expect(parseFrameDocument(external)).toBeNull();
    expect(parseFrameDocument({ ...validDocument(), image: null })).not.toBeNull();
  });
});
