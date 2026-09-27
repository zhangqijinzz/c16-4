import { describe, expect, it } from 'vitest';
import type { FrameDocument } from '../model';
import {
  exportFileName,
  parseWorkspace,
  serializeWorkspace,
  type ChecksumService,
  type TransferFailure,
  type TransferResult,
} from '../transfer';

class NodeChecksum implements ChecksumService {
  async sha256(value: string): Promise<string> {
    const bytes = new TextEncoder().encode(value);
    const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
    return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
  }
}

const checksum = new NodeChecksum();

function makeDocument(): FrameDocument {
  return {
    version: 1,
    image: { src: 'data:image/png;base64,QUJD', width: 800, height: 1200, name: 'portrait.png' },
    guides: { thirds: true, center: true, diagonal: false, golden: true },
    subject: { x: 0.25, y: 0.7 },
    crop: { id: 'current', x: 0.05, y: 0.1, width: 0.8, height: 0.6, ratio: '4:5' },
    variants: [
      { id: 'v1', x: 0, y: 0, width: 1, height: 1, ratio: 'free' },
      { id: 'v2', x: 0.2, y: 0.1, width: 0.5, height: 0.5, ratio: '1:1' },
    ],
  };
}

async function roundTrip(document: FrameDocument, exportedAt = new Date('2026-09-20T10:30:00.000Z')): Promise<{ result: TransferResult; text: string }> {
  const text = await serializeWorkspace(document, checksum, '1.0.0', exportedAt);
  return { text, result: await parseWorkspace(text, checksum) };
}

const expectFailure = (result: TransferResult, reason: TransferFailure['reason']) => {
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.reason).toBe(reason);
};

describe('workspace file transfer', () => {
  it('round-trips the full workspace: guides, subject, crops and variants', async () => {
    const document = makeDocument();
    const { result } = await roundTrip(document);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.document).toEqual(document);
      expect(result.exportedAt).toBe('2026-09-20T10:30:00.000Z');
    }
  });

  it('uses a timestamped .json file name', () => {
    expect(exportFileName(new Date('2026-09-27T08:09:10.000Z'))).toBe('framesense-workspace-2026-09-27-08-09-10.json');
  });

  it('rejects garbage that is not JSON', async () => {
    expectFailure(await parseWorkspace('{broken', checksum), 'not-json');
  });

  it('rejects JSON that is not a FrameSense envelope', async () => {
    expectFailure(await parseWorkspace(JSON.stringify({ hello: 'world' }), checksum), 'not-envelope');
    expectFailure(await parseWorkspace(JSON.stringify({ format: 'other-app', formatVersion: 1 }), checksum), 'not-envelope');
  });

  it('rejects files produced by a newer format version', async () => {
    const future = JSON.stringify({ format: 'framesense', formatVersion: 7, payload: {}, checksum: 'deadbeef' });
    expectFailure(await parseWorkspace(future, checksum), 'future-version');
  });

  it('rejects a payload whose checksum does not match (tampered or damaged)', async () => {
    const { text } = await roundTrip(makeDocument());
    const envelope = JSON.parse(text);
    envelope.payload.subject.x = 0.91;
    expectFailure(await parseWorkspace(JSON.stringify(envelope), checksum), 'checksum-mismatch');

    const brokenChecksum = JSON.parse(text);
    brokenChecksum.checksum = '0'.repeat(64);
    expectFailure(await parseWorkspace(JSON.stringify(brokenChecksum), checksum), 'checksum-mismatch');
  });

  it('rejects structurally invalid documents even with a matching checksum', async () => {
    // 内部规则不允许的比例（伪造文件可自行带上合法校验和）。
    const badRatio = makeDocument();
    badRatio.crop = { ...badRatio.crop, ratio: '21:9' };
    const text1 = await serializeWorkspace(badRatio, checksum);
    expectFailure(await parseWorkspace(text1, checksum), 'invalid-document');

    // 裁切窗口越界。
    const outOfBounds = makeDocument();
    outOfBounds.crop = { ...outOfBounds.crop, x: 0.8, width: 0.8 };
    const text2 = await serializeWorkspace(outOfBounds, checksum);
    expectFailure(await parseWorkspace(text2, checksum), 'invalid-document');

    // 图片不是自包含的 data URL。
    const externalImage = makeDocument();
    externalImage.image = { ...externalImage.image!, src: 'http://example.com/track.png' };
    const text3 = await serializeWorkspace(externalImage, checksum);
    expectFailure(await parseWorkspace(text3, checksum), 'invalid-document');

    // 方案数量超出上限。
    const tooManyVariants = makeDocument();
    tooManyVariants.variants = Array.from({ length: 9 }, (_, index) => ({ id: `v${index}`, x: 0, y: 0, width: 0.5, height: 0.5, ratio: '1:1' as const }));
    const text4 = await serializeWorkspace(tooManyVariants, checksum);
    expectFailure(await parseWorkspace(text4, checksum), 'invalid-document');
  });

  it('rejects a valid envelope that carries an empty workspace', async () => {
    const { result } = await roundTrip({ ...makeDocument(), image: null });
    expectFailure(result, 'empty-document');
  });
});
