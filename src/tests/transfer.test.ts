import { describe, expect, it } from 'vitest';
import { parseWorkspaceFile, serializeWorkspace, sha256Hex, workspaceFileName } from '../transfer';
import { DEFAULT_CROP, type FrameDocument } from '../model';

const validDocument: FrameDocument = {
  version: 1,
  image: { src: 'data:image/svg+xml,test', width: 1200, height: 800, name: 'photo.jpg' },
  guides: { thirds: true, center: false, diagonal: true, golden: false },
  subject: { x: 0.42, y: 0.58 },
  crop: { ...DEFAULT_CROP, ratio: '1:1', width: 2 / 3, height: 1, x: 1 / 6, y: 0 },
  variants: [
    { id: 'variant-1', x: 0.1, y: 0.1, width: 0.5, height: 0.5, ratio: 'free' },
  ],
};

async function roundTrip(document: FrameDocument = structuredClone(validDocument)): Promise<string> {
  return serializeWorkspace(document, new Date('2026-09-27T08:30:00.000Z'));
}

describe('workspace transfer', () => {
  it('round-trips a full workspace including guides, subject, variants and current crop', async () => {
    const file = await roundTrip();
    const result = await parseWorkspaceFile(file);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.document.image?.name).toBe('photo.jpg');
    expect(result.document.guides).toEqual({ thirds: true, center: false, diagonal: true, golden: false });
    expect(result.document.subject).toEqual({ x: 0.42, y: 0.58 });
    expect(result.document.crop).toMatchObject({ ratio: '1:1', width: 2 / 3 });
    expect(result.document.variants).toHaveLength(1);
    expect(result.document.crop.id).toBe('current');
    expect(result.summary.variants).toBe(1);
    expect(result.summary.guidesEnabled).toBe(2);
    expect(result.summary.hasSubject).toBe(true);
    expect(result.summary.exportedAt).toBe('2026-09-27T08:30:00.000Z');
  });

  it('rejects text that is not JSON', async () => {
    const result = await parseWorkspaceFile('not a workspace at all');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('format');
  });

  it('rejects JSON that is not a FrameSense envelope', async () => {
    const result = await parseWorkspaceFile(JSON.stringify({ hello: 'world' }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('format');
  });

  it('rejects a file from a newer format version with an explicit upgrade message', async () => {
    const file = await roundTrip();
    const envelope = JSON.parse(file);
    envelope.kind = 99;
    const result = await parseWorkspaceFile(JSON.stringify(envelope));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('version');
    expect(result.message).toContain('升级');
  });

  it('detects a tampered payload via checksum mismatch', async () => {
    const file = await roundTrip();
    const envelope = JSON.parse(file);
    envelope.document.subject = { x: 0.99, y: 0.99 };
    const result = await parseWorkspaceFile(JSON.stringify(envelope));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('checksum');
  });

  it('detects a tampered checksum field itself', async () => {
    const file = await roundTrip();
    const envelope = JSON.parse(file);
    envelope.checksum = `${'0'.repeat(64)}`;
    const result = await parseWorkspaceFile(JSON.stringify(envelope));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('checksum');
  });

  it('rejects a file carrying a newer inner document version with an upgrade message', async () => {
    const file = await roundTrip();
    const envelope = JSON.parse(file);
    envelope.document.version = 2;
    envelope.checksum = await rehash(envelope);
    const result = await parseWorkspaceFile(JSON.stringify(envelope));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('version');
    expect(result.message).toContain('升级');
  });

  it('rejects structurally valid but spec-violating content', async () => {
    const file = await roundTrip();
    const envelope = JSON.parse(file);
    envelope.document.guides.thirds = 'yes';
    envelope.checksum = await rehash(envelope);
    const result = await parseWorkspaceFile(JSON.stringify(envelope));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('content');
  });

  it('rejects an image pointing outside the embedded data url', async () => {
    const file = await roundTrip();
    const envelope = JSON.parse(file);
    envelope.document.image.src = 'https://example.com/track.png';
    envelope.checksum = await rehash(envelope);
    const result = await parseWorkspaceFile(JSON.stringify(envelope));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('content');
  });

  it('rejects crops that escape the image bounds', async () => {
    const file = await roundTrip();
    const envelope = JSON.parse(file);
    envelope.document.crop = { id: 'current', x: 0.8, y: 0.8, width: 0.5, height: 0.5, ratio: 'free' };
    envelope.checksum = await rehash(envelope);
    const result = await parseWorkspaceFile(JSON.stringify(envelope));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('content');
  });

  it('refuses to export when there is no image', async () => {
    const { EMPTY_DOCUMENT } = await import('../model');
    await expect(serializeWorkspace(structuredClone(EMPTY_DOCUMENT))).rejects.toThrow();
  });

  it('builds a timestamped framesense file name', () => {
    expect(workspaceFileName(new Date('2026-09-27T08:05:00'))).toBe('framesense-20260927-0805.framesense.json');
  });
});

async function rehash(envelope: { format: string; kind: number; exportedAt: string; document: unknown }): Promise<string> {
  const canonical = JSON.stringify({ format: envelope.format, kind: envelope.kind, exportedAt: envelope.exportedAt, document: envelope.document });
  return sha256Hex(canonical);
}
