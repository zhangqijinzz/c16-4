import { beforeEach, describe, expect, it } from 'vitest';
import { FrameSenseViewModel } from '../viewModel';
import { EMPTY_DOCUMENT, type FrameDocument, type ImageAsset } from '../model';
import type { FrameRepository } from '../repository';
import type { ImageService, WorkspaceFileService } from '../service';
import { serializeWorkspace } from '../transfer';

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

class FakeWorkspaceFileService implements WorkspaceFileService {
  files = new Map<string, string>();
  nextFile: string | null = null;
  readFails = false;
  async save(name: string, contents: string) { this.files.set(name, contents); }
  async read() {
    if (this.readFails) throw new Error('unreadable');
    if (this.nextFile === null) throw new Error('no file staged');
    return this.nextFile;
  }
}

describe('FrameSenseViewModel', () => {
  let repository: MemoryRepository;
  let fileService: FakeWorkspaceFileService;
  let vm: FrameSenseViewModel;
  beforeEach(() => {
    repository = new MemoryRepository();
    fileService = new FakeWorkspaceFileService();
    vm = new FrameSenseViewModel(repository, new FakeImageService(), fileService);
  });

  const workspaceFile = (name = 'export.framesense.json') => new File(['stub'], name, { type: 'application/json' });

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

  it('exports the workspace into a framesense file', async () => {
    vm.loadDemo();
    vm.markSubject(0.3, 0.4);
    vm.saveVariant();
    await vm.exportWorkspace();
    const saved = [...fileService.files.entries()];
    expect(saved).toHaveLength(1);
    expect(saved[0][0]).toMatch(/^framesense-\d{8}-\d{4}\.framesense\.json$/);
    const envelope = JSON.parse(saved[0][1]);
    expect(envelope.format).toBe('framesense.workspace');
    expect(envelope.checksum).toEqual(expect.any(String));
    expect(envelope.document.image.name).toBe('test.svg');
    expect(envelope.document.subject).toEqual({ x: 0.3, y: 0.4 });
  });

  it('restores an exported file into an empty workspace without a dialog', async () => {
    vm.loadDemo();
    vm.toggleGuide('golden');
    vm.setRatio('16:9');
    vm.saveVariant();
    await vm.exportWorkspace();
    const exported = [...fileService.files.values()][0];

    const empty = new FrameSenseViewModel(new MemoryRepository(), new FakeImageService(), fileService);
    fileService.nextFile = exported;
    await empty.importWorkspaceFile(workspaceFile());
    const state = empty.getSnapshot();
    expect(state.pendingImport).toBeNull();
    expect(state.document.image?.name).toBe('test.svg');
    expect(state.document.guides.golden).toBe(true);
    expect(state.document.crop.ratio).toBe('16:9');
    expect(state.document.variants).toHaveLength(1);
    expect(state.notice).toContain('已从文件还原');
  });

  it('asks for confirmation before replacing the open workspace and stays unchanged meanwhile', async () => {
    vm.loadDemo();
    const originalName = vm.getSnapshot().document.image?.name;
    const otherDoc = structuredClone(vm.getSnapshot().document);
    otherDoc.image = { ...otherDoc.image!, name: 'another-photo.jpg' };
    fileService.nextFile = await serializeWorkspace(otherDoc);

    await vm.importWorkspaceFile(workspaceFile());
    let state = vm.getSnapshot();
    expect(state.pendingImport).not.toBeNull();
    expect(state.pendingImport?.imageName).toBe('another-photo.jpg');
    expect(state.document.image?.name).toBe(originalName);

    vm.cancelWorkspaceImport();
    state = vm.getSnapshot();
    expect(state.pendingImport).toBeNull();
    expect(state.document.image?.name).toBe(originalName);

    fileService.nextFile = await serializeWorkspace(otherDoc);
    await vm.importWorkspaceFile(workspaceFile());
    vm.confirmWorkspaceImport();
    state = vm.getSnapshot();
    expect(state.pendingImport).toBeNull();
    expect(state.document.image?.name).toBe('another-photo.jpg');
    expect(repository.document.image?.name).toBe('another-photo.jpg');
  });

  it('rejects a damaged file and keeps the workspace untouched', async () => {
    vm.loadDemo();
    const before = structuredClone(vm.getSnapshot().document);
    fileService.nextFile = '{ broken json';
    await vm.importWorkspaceFile(workspaceFile());
    const state = vm.getSnapshot();
    expect(state.pendingImport).toBeNull();
    expect(state.error).toContain('JSON');
    expect(state.document).toEqual(before);
  });

  it('reports when the file itself cannot be read', async () => {
    fileService.readFails = true;
    await vm.importWorkspaceFile(workspaceFile());
    expect(vm.getSnapshot().error).toContain('读取失败');
  });
});
