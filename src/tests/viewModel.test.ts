import { beforeEach, describe, expect, it } from 'vitest';
import { FrameSenseViewModel } from '../viewModel';
import { EMPTY_DOCUMENT, type FrameDocument, type ImageAsset } from '../model';
import type { FrameRepository } from '../repository';
import type { ImageService } from '../service';
import type { ChecksumService, FileTransferService } from '../transfer';

class MemoryRepository implements FrameRepository {
  document: FrameDocument = structuredClone(EMPTY_DOCUMENT);
  fail = false;
  load() { return structuredClone(this.document); }
  save(document: FrameDocument) { if (this.fail) throw new Error('no storage'); this.document = structuredClone(document); }
}

class FakeImageService implements ImageService {
  asset: ImageAsset = { src: 'data:image/svg+xml,test', width: 1200, height: 800, name: 'test.svg' };
  readFile() { return Promise.resolve(this.asset); }
  demo() { return this.asset; }
}

// 与 serializeWorkspace 相同的规范化规则，供测试自行构造校验和。
const canonical = (document: FrameDocument) => JSON.stringify({
  version: document.version,
  image: document.image,
  guides: document.guides,
  subject: document.subject,
  crop: document.crop,
  variants: document.variants,
});

class FakeChecksum implements ChecksumService {
  async sha256(value: string) { return `hash:${value.length}`; }
}

class FakeFileTransfer implements FileTransferService {
  downloads: Array<{ fileName: string; content: string }> = [];
  readShouldFail = false;
  download(fileName: string, content: string) { this.downloads.push({ fileName, content }); }
  async read(file: File) { if (this.readShouldFail) throw new Error('unreadable'); return file.text(); }
}

async function envelopeFor(document: FrameDocument, checksum: FakeChecksum): Promise<string> {
  const payload = structuredClone(document);
  return JSON.stringify({
    format: 'framesense',
    formatVersion: 1,
    appVersion: '1.0.0',
    exportedAt: '2026-09-20T08:00:00.000Z',
    payload,
    checksum: await checksum.sha256(canonical(payload)),
  });
}

function makeDocument(): FrameDocument {
  return {
    version: 1,
    image: { src: 'data:image/png;base64,AAAA', width: 1000, height: 600, name: 'imported.png' },
    guides: { thirds: false, center: true, diagonal: true, golden: false },
    subject: { x: 0.31, y: 0.42 },
    crop: { id: 'current', x: 0.1, y: 0.2, width: 0.5, height: 0.4, ratio: '16:9' },
    variants: [{ id: 'variant-1', x: 0, y: 0, width: 0.6, height: 0.6, ratio: '1:1' }],
  };
}

describe('FrameSenseViewModel', () => {
  let repository: MemoryRepository;
  let files: FakeFileTransfer;
  let checksum: FakeChecksum;
  let vm: FrameSenseViewModel;
  beforeEach(() => {
    repository = new MemoryRepository();
    files = new FakeFileTransfer();
    checksum = new FakeChecksum();
    vm = new FrameSenseViewModel(repository, new FakeImageService(), files, checksum);
  });

  it('initializes empty and loads a demo image', async () => {
    await vm.initialize();
    expect(vm.getSnapshot().phase).toBe('ready');
    vm.loadDemo();
    expect(vm.getSnapshot().document.image?.name).toBe('test.svg');
    expect(repository.document.image).not.toBeNull();
  });

  it('updates guides, subject, ratio, and variants', () => {
    vm.loadDemo();
    vm.toggleGuide('center');
    vm.markSubject(0.2, 0.8);
    vm.setRatio('1:1');
    vm.saveVariant();
    expect(vm.getSnapshot().document.guides.center).toBe(true);
    expect(vm.getSnapshot().document.subject).toEqual({ x: 0.2, y: 0.8 });
    expect(vm.getSnapshot().document.crop.ratio).toBe('1:1');
    expect(vm.getSnapshot().document.variants).toHaveLength(1);
  });

  it('keeps edits in memory and reports persistence failure', () => {
    repository.fail = true;
    vm.loadDemo();
    expect(vm.getSnapshot().phase).toBe('error');
    expect(vm.getSnapshot().document.image).not.toBeNull();
    expect(vm.getSnapshot().error).toContain('本地保存失败');
  });

  it('exports the current workspace as a downloadable file', async () => {
    vm.loadDemo();
    await vm.exportWorkspace();
    expect(files.downloads).toHaveLength(1);
    expect(files.downloads[0].fileName).toMatch(/^framesense-workspace-.*\.json$/);
    const envelope = JSON.parse(files.downloads[0].content);
    expect(envelope.format).toBe('framesense');
    expect(envelope.formatVersion).toBe(1);
    expect(envelope.payload.image.name).toBe('test.svg');
    expect(typeof envelope.checksum).toBe('string');
  });

  it('does not export when there is no image', async () => {
    await vm.exportWorkspace();
    expect(files.downloads).toHaveLength(0);
  });

  it('imports directly into an empty workspace without a conflict prompt', async () => {
    await vm.initialize();
    const text = await envelopeFor(makeDocument(), checksum);
    await vm.importWorkspace(new File([text], 'backup.json', { type: 'application/json' }));
    const state = vm.getSnapshot();
    expect(state.pendingImport).toBeNull();
    expect(state.document.image?.name).toBe('imported.png');
    expect(state.document.subject).toEqual({ x: 0.31, y: 0.42 });
    expect(state.document.guides.center).toBe(true);
    expect(state.document.variants).toHaveLength(1);
    expect(repository.document.image?.name).toBe('imported.png');
  });

  it('asks for confirmation before replacing a workspace that already has content', async () => {
    vm.loadDemo();
    const text = await envelopeFor(makeDocument(), checksum);
    await vm.importWorkspace(new File([text], 'backup.json'));
    const state = vm.getSnapshot();
    expect(state.pendingImport).not.toBeNull();
    // 确认前当前内容不被改动。
    expect(state.document.image?.name).toBe('test.svg');
    expect(repository.document.image?.name).toBe('test.svg');

    vm.cancelImport();
    expect(vm.getSnapshot().pendingImport).toBeNull();
    expect(vm.getSnapshot().document.image?.name).toBe('test.svg');

    // 再次触发并确认后才替换。
    await vm.importWorkspace(new File([text], 'backup.json'));
    vm.confirmImport();
    expect(vm.getSnapshot().document.image?.name).toBe('imported.png');
    expect(repository.document.image?.name).toBe('imported.png');
  });

  it('rejects a tampered file and leaves the current workspace untouched', async () => {
    vm.loadDemo();
    const text = await envelopeFor(makeDocument(), checksum);
    expect(text).toContain('imported.png');
    const tampered = text.replace('imported.png', 'swapped.png');
    await vm.importWorkspace(new File([tampered], 'tampered.json'));
    const state = vm.getSnapshot();
    expect(state.pendingImport).toBeNull();
    expect(state.document.image?.name).toBe('test.svg');
    expect(state.error).toContain('校验未通过');
  });

  it('rejects a future-version file without touching the workspace', async () => {
    vm.loadDemo();
    const future = JSON.stringify({ format: 'framesense', formatVersion: 99, payload: {}, checksum: 'x' });
    await vm.importWorkspace(new File([future], 'future.json'));
    const state = vm.getSnapshot();
    expect(state.document.image?.name).toBe('test.svg');
    expect(state.error).toContain('更新版本');
  });

  it('rejects a non-JSON file and keeps working state', async () => {
    vm.loadDemo();
    const text = '<<< not json >>>';
    await vm.importWorkspace(new File([text], 'weird.dat'));
    expect(vm.getSnapshot().document.image?.name).toBe('test.svg');
    expect(vm.getSnapshot().error).toContain('JSON');
  });

  it('refuses files beyond the size limit before reading them', async () => {
    vm.loadDemo();
    const file = new File(['x'], 'big.json');
    Object.defineProperty(file, 'size', { value: 31 * 1024 * 1024 });
    await vm.importWorkspace(file);
    expect(vm.getSnapshot().error).toContain('30MB');
  });
});
