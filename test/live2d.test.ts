import { spawnSync } from 'node:child_process';
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { WriteCoordinator, type CoordinatorOptions } from '../src/changes/coordinator.js';
import { ProjectLocks } from '../src/changes/locks.js';
import { LARGE_ASSET_LIMITS } from '../src/changes/types.js';
import { planLive2dImport } from '../src/live2d/import.js';
import { inspectLive2dModel } from '../src/live2d/model.js';
import { ReadService } from '../src/service.js';
import type { AppConfig } from '../src/types.js';

const entry = 'hero/hero.model3.json';
const modelPath = 'game/figure/hero/hero.model3.json';
const owner = 'live2d-test';
const statement = { source: 'user-message' as const, statement: 'Saved and closed the temporary editor.' };
const input = { projectId: 'test', sourceId: 'models', modelPath: entry, targetDirectory: 'hero' };
const location = { kind: 'source' as const, sourceId: 'models', modelPath: entry };
const standard = {
  Moc: 'hero.moc3',
  Textures: ['texture/main.png'],
  Motions: { Idle: [{ File: 'motions/idle.motion3.json', Sound: 'sound/idle.wav' }] },
  Expressions: [{ Name: 'Happy', File: 'expressions/happy.exp3.json' }],
  Physics: 'hero.physics3.json',
  Pose: 'hero.pose3.json',
  UserData: 'hero.userdata3.json',
  DisplayInfo: 'hero.cdi3.json',
};
const dependencies = [
  'hero.moc3', 'texture/main.png', 'motions/idle.motion3.json', 'sound/idle.wav', 'expressions/happy.exp3.json',
  'hero.physics3.json', 'hero.pose3.json', 'hero.userdata3.json', 'hero.cdi3.json',
];
let dir: string;
let root: string;
let source: string;
let state: string;
let lockRoot: string;
let config: AppConfig;

async function put(base: string, relative: string, data = relative) {
  const target = join(base, relative);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, data);
  return target;
}

function model(refs: Record<string, unknown> = standard) {
  return JSON.stringify({ Version: 3, FileReferences: refs });
}

beforeEach(async () => {
  dir = await realpath(await mkdtemp(join(tmpdir(), 'webgal-live2d-')));
  root = join(dir, 'project');
  source = join(dir, 'models');
  await mkdir(root);
  await mkdir(source);
  state = join(dir, 'state');
  lockRoot = join(dir, 'locks');
  config = { version: 1, projects: [{ id: 'test', root }], sources: [{ id: 'models', root: source }] };
  await mkdir(join(root, 'game/figure'), { recursive: true });
  await put(root, 'game/scene/start.txt', 'Hero:Hello;');
  await put(source, entry, model());
  await Promise.all(dependencies.map(file => put(source, `hero/${file}`)));
});
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

function draft(extraPaths?: string[]) {
  return planLive2dImport(config, { ...input, extraPaths }, async () => {
    throw new Error('A draft must not persist a plan.');
  });
}

async function coordinator(fault?: CoordinatorOptions['fault']) {
  return WriteCoordinator.create(config, state, { locks: new ProjectLocks(lockRoot), capabilityCheck: async () => true, fault });
}

async function reviewed(host: WriteCoordinator) {
  const review = await draft();
  expect(review).toMatchObject({ committable: false, blockingIssues: [] });
  const session = host.sessions.begin(owner, input.projectId, statement, review.paths);
  const plan = await planLive2dImport(config, { ...input, sessionId: session.id, expectedBundleRevision: review.bundleRevision! },
    (id, files, bundle) => host.plan(owner, id, input.projectId, files, undefined, undefined, bundle));
  expect(plan.committable).toBe(true);
  return { plan, session };
}

it('lists all standard dependency fields, the motion group, and the expression name', async () => {
  const report = await inspectLive2dModel(config, location);
  expect(report).toMatchObject({
    status: 'valid', version: 3,
    motions: [{ name: 'Idle', files: ['motions/idle.motion3.json'] }],
    expressions: [{ name: 'Happy', file: 'expressions/happy.exp3.json' }],
    issues: [],
  });
  expect(report.dependencies.map(file => file.path).sort()).toEqual([...dependencies].sort());
  expect(report.dependencies.every(file => file.status === 'present')).toBe(true);
  expect(JSON.stringify(report)).not.toContain(source);
});

it('reports unresolved fields, missing files, links and paths outside the model directory', async () => {
  await symlink(join(source, 'hero/texture'), join(source, 'hero/link'), 'junction');
  await put(source, entry, model({
    ...standard, Textures: ['https://example.invalid/private.png', '../outside.png', 'link/main.png', 'missing.png'],
    UnsupportedDependency: 'hidden-reference.txt',
  }));
  const report = await inspectLive2dModel(config, location);
  expect(report.status).toBe('invalid');
  expect(report.issues).toEqual(expect.arrayContaining([
    expect.objectContaining({ code: 'UNKNOWN_DEPENDENCY_FIELD', status: 'unverified' }),
    expect.objectContaining({ code: 'DEPENDENCY_MISSING', path: 'missing.png' }),
    expect.objectContaining({ code: 'DEPENDENCY_PATH_INVALID', status: 'invalid' }),
    expect.objectContaining({ code: 'PATH_INVALID', path: 'link/main.png' }),
  ]));
  expect(JSON.stringify(report)).not.toMatch(/https:\/\/|\.\.\/|hidden-reference/);
  expect(await draft()).toMatchObject({ committable: false, bundleRevision: null });
});

it('checks candidate and saved scene names, defers dynamic references, and paginates', async () => {
  await put(root, modelPath, model());
  await Promise.all(dependencies.filter(file => file !== 'texture/main.png')
    .map(file => put(root, `game/figure/hero/${file}`)));
  const scene = [
    'changeFigure:hero/hero.model3.json -motion=idle -expression=Typo;',
    'changeFigure:hero/hero.model3.json -motion={gameMotion} -expression=Happy;',
    'changeFigure:{figure}.model3.json -motion=Idle;',
  ].join('\n');
  await put(root, 'game/scene/start.txt', scene);
  await put(root, 'game/scene/z.txt', 'Hello;');
  const service = new ReadService(config);
  const checked = await service.validate('test', 'start.txt', scene);
  expect(checked.live2dIssues).toEqual(expect.arrayContaining([
    expect.objectContaining({ line: 1, code: 'UNKNOWN_MOTION_GROUP', name: 'idle' }),
    expect.objectContaining({ line: 1, code: 'UNKNOWN_EXPRESSION', name: 'Typo' }),
    expect.objectContaining({ line: 1, code: 'DEPENDENCY_MISSING', dependencyPath: 'texture/main.png' }),
    expect.objectContaining({ line: 2, code: 'LIVE2D_SELECTOR_UNVERIFIED', selector: 'motion' }),
    expect.objectContaining({ line: 3, code: 'MODEL_REFERENCE_UNVERIFIED', modelPath: null }),
  ]));
  const page = await service.scan('test', { limit: 1 });
  expect(page.scenes[0].live2dIssues).toEqual(checked.live2dIssues);
  const later = await service.scan('test', { startAfter: page.scope.nextStartAfter! });
  expect(later.scenes.map(item => item.path)).toEqual(['z.txt']);
});

it('reports incomplete coverage when a scan reaches the model inspection budget', async () => {
  const scene = Array.from({ length: 33 }, (_, index) => `changeFigure:model-${index}.model3.json;`).join('\n');
  await put(root, 'game/scene/start.txt', scene);
  const service = new ReadService(config);
  const result = await service.scan('test', {});
  expect(result.complete).toBe(false);
  expect(result.scenes[0]).toMatchObject({ status: 'incomplete', reason: 'SCENE_ANALYSIS_TRUNCATED' });
  expect(result.scenes[0].live2dIssues.at(-1)).toMatchObject({
    line: 33, category: 'unverified', code: 'MODEL_INSPECTION_LIMIT',
  });
});

it('blocks an occupied destination, conflicting names, and unsafe extras', async () => {
  const existing = await put(root, modelPath, 'existing');
  expect((await draft()).blockingIssues).toContainEqual({ code: 'TARGET_EXISTS', path: 'game/figure/hero' });
  expect(await readFile(existing, 'utf8')).toBe('existing');
  await put(source, entry, model({ ...standard, Textures: ['texture/main.png', 'texture/MAIN.png'] }));
  await put(source, 'hero/texture/MAIN.png');
  const collision = await planLive2dImport(config, { ...input, targetDirectory: 'new-hero' }, async () => {
    throw new Error('A filename collision cannot produce a write plan.');
  });
  expect(collision.blockingIssues).toContainEqual(expect.objectContaining({ code: 'TARGET_EXISTS' }));
  expect(collision.committable).toBe(false);
  expect((await draft(['script.js'])).blockingIssues).toContainEqual({ code: 'INVALID_ARGUMENT' });
});

it('accepts a 1 MiB model entry and blocks an entry one byte larger', async () => {
  const paddedEntry = model().padEnd(1024 * 1024, ' ');
  await put(source, entry, paddedEntry);
  expect((await draft()).blockingIssues).toEqual([]);
  await put(source, entry, paddedEntry + ' ');
  expect((await draft()).blockingIssues).toContainEqual(expect.objectContaining({ code: 'FILE_TOO_LARGE' }));
});

it('uses file, total, and count limits for the complete package', async () => {
  const over = await put(source, 'hero/extra.png');
  await truncate(over, LARGE_ASSET_LIMITS.maxFileBytes + 1);
  expect((await draft(['extra.png'])).blockingIssues).toContainEqual(expect.objectContaining({ code: 'FILE_TOO_LARGE' }));
  await truncate(over, LARGE_ASSET_LIMITS.maxFileBytes);
  expect((await draft(['extra.png'])).blockingIssues).toEqual([]);
  const other = await put(source, 'hero/other.png');
  const base = await draft();
  const remainingBytes = LARGE_ASSET_LIMITS.maxBatchBytes - LARGE_ASSET_LIMITS.maxFileBytes - base.totalBytes;
  await truncate(other, remainingBytes + 1);
  expect((await draft(['extra.png', 'other.png'])).blockingIssues).toContainEqual(expect.objectContaining({ code: 'LIMIT_EXCEEDED' }));
  await truncate(other, remainingBytes);
  expect(await draft(['extra.png', 'other.png'])).toMatchObject({
    totalBytes: LARGE_ASSET_LIMITS.maxBatchBytes, blockingIssues: [],
  });
  const extraPaths = Array.from({ length: 23 }, (_, index) => `extra-${index}.png`);
  await Promise.all(extraPaths.map(file => put(source, `hero/${file}`)));
  expect((await draft(extraPaths.slice(1))).paths).toHaveLength(32);
  expect((await draft(extraPaths)).blockingIssues).toContainEqual({ code: 'LIMIT_EXCEEDED' });
}, 15_000);

it('refuses to adopt a directory created by someone else after preflight', async () => {
  const host = await coordinator(async (point, index) => {
    if (point === 'before-model-directory' && index === 0) {
      await put(root, 'game/figure/hero/keep.png', 'user bytes');
    }
  });
  const { session, plan } = await reviewed(host);
  const result = await host.apply(owner, session.id, plan.planId!, 'directory-race');
  expect(result.errorCode).toBe('TARGET_EXISTS');
  expect(await readFile(join(root, 'game/figure/hero/keep.png'), 'utf8')).toBe('user bytes');
  await expect(readFile(join(root, modelPath))).rejects.toMatchObject({ code: 'ENOENT' });
  const recovery = await host.inspect('test', result.batchId);
  expect(recovery.directories).toContainEqual({ path: 'game/figure/hero', phase: 'intent', diskState: 'present' });
});

it.each(['directory', 'file'])('preserves a %s whose name is occupied at model directory publication', async kind => {
  const target = join(root, 'game/figure/hero');
  let originalIdentity: bigint | undefined;
  const host = await coordinator(async (point, index) => {
    if (point !== 'before-model-directory-publish' || index !== 0) return;
    if (kind === 'directory') await mkdir(target);
    else await writeFile(target, 'user bytes', { flag: 'wx' });
    originalIdentity = (await lstat(target, { bigint: true })).ino;
  });
  const { session, plan } = await reviewed(host);
  const applied = await host.apply(owner, session.id, plan.planId!, 'occupied-publication');
  expect(applied).toMatchObject({ status: 'uncertain', errorCode: 'TARGET_EXISTS' });
  expect(applied.operations.every(operation => operation.phase === 'pending')).toBe(true);
  expect(originalIdentity).toBeDefined();
  expect((await lstat(target, { bigint: true })).ino).toBe(originalIdentity);
  if (kind === 'directory') expect(await readdir(target)).toEqual([]);
  else expect(await readFile(target, 'utf8')).toBe('user bytes');
  const recovery = await host.inspect('test', applied.batchId);
  const retained = recovery.directories?.find(directory => directory.path === 'game/figure/hero');
  expect(retained).toMatchObject({ phase: 'intent', stagingPath: expect.stringMatching(/^game\/figure\/\.wgmcp-dir-/) });
  expect(await readdir(join(root, retained!.stagingPath!))).toEqual([]);
  expect(await host.apply(owner, session.id, plan.planId!, 'occupied-publication')).toMatchObject({
    batchId: applied.batchId, replayed: true, errorCode: 'TARGET_EXISTS',
  });
});

it.skipIf(process.platform !== 'linux')(
  'preserves a dangling symlink whose name is occupied at model directory publication on Linux',
  async () => {
    const target = join(root, 'game/figure/hero');
    let originalIdentity: bigint | undefined;
    const host = await coordinator(async (point, index) => {
      if (point !== 'before-model-directory-publish' || index !== 0) return;
      await symlink(join(dir, 'nonexistent-target'), target);
      originalIdentity = (await lstat(target, { bigint: true })).ino;
    });
    const { session, plan } = await reviewed(host);
    const applied = await host.apply(owner, session.id, plan.planId!, 'occupied-symlink');
    expect(applied).toMatchObject({ status: 'uncertain', errorCode: 'TARGET_EXISTS' });
    expect(applied.operations.every(operation => operation.phase === 'pending')).toBe(true);
    expect(originalIdentity).toBeDefined();
    const current = await lstat(target, { bigint: true });
    expect(current.isSymbolicLink()).toBe(true);
    expect(current.ino).toBe(originalIdentity);
  },
);

it('requires the reviewed files at handoff and again at apply', async () => {
  const host = await coordinator();
  const review = await draft();
  const session = host.sessions.begin(owner, 'test', statement, review.paths);
  await put(source, 'hero/hero.moc3', 'edited after review');
  await expect(planLive2dImport(config, { ...input, sessionId: session.id, expectedBundleRevision: review.bundleRevision! },
    async () => { throw new Error('Changed source must not produce a plan.'); })).rejects.toMatchObject({ code: 'SOURCE_CHANGED' });
  const fresh = await reviewed(host);
  await put(source, 'hero/hero.moc3', 'edited after plan');
  await expect(host.apply(owner, fresh.session.id, fresh.plan.planId!, 'fresh')).rejects.toMatchObject({ code: 'SOURCE_CHANGED' });
  await expect(readFile(join(root, modelPath))).rejects.toMatchObject({ code: 'ENOENT' });
});

it('rechecks installed dependencies immediately before publishing the model entry', async () => {
  const host = await coordinator(async (point, index) => {
    if (point === 'before-write' && index === dependencies.length) {
      await put(root, 'game/figure/hero/hero.moc3', 'changed externally');
    }
  });
  const { session, plan } = await reviewed(host);
  const result = await host.apply(owner, session.id, plan.planId!, 'entry-last');
  expect(result.errorCode).toBe('REVISION_CONFLICT');
  await expect(readFile(join(root, modelPath))).rejects.toMatchObject({ code: 'ENOENT' });
  const replay = await host.apply(owner, session.id, plan.planId!, 'entry-last');
  expect(replay).toMatchObject({ replayed: true, batchId: result.batchId });
  await expect(host.apply(owner, session.id, plan.planId!, 'different-key')).rejects.toMatchObject({ code: 'HANDOFF_REQUIRED' });
});

it.each([
  ['before-model-directory-publish', 0, 'missing', 'missing'],
  ['after-model-directory', 0, 'missing', 'present'],
  ['after-write', 0, 'missing', 'planned'],
  ['after-write', dependencies.length, 'planned', 'planned'],
])('inspects disk after a process exits at %s index %i', async (fault, index, entryState, directoryState) => {
  const fixtureFile = await put(dir, 'child.json', JSON.stringify({ config, state, lockRoot, input, fault, index }));
  const script = fileURLToPath(new URL('./changes/fixtures/live2d-child.mjs', import.meta.url));
  const child = spawnSync(process.execPath, [script, fixtureFile], { encoding: 'utf8', windowsHide: true, timeout: 15_000 });
  expect(child.status, child.stderr).toBe(73);
  const host = await coordinator();
  const history = await host.pending('test', { planId: child.stdout.trim() });
  expect(history.unreadableRecords).toBe(0);
  expect(history.batches).toHaveLength(1);
  const batch = history.batches[0];
  const directory = batch.directories?.find(item => item.path === 'game/figure/hero');
  expect(directory?.diskState).toBe(directoryState);
  if (fault === 'before-model-directory-publish') {
    expect(directory?.stagingPath).toEqual(expect.any(String));
    expect(await readdir(join(root, directory!.stagingPath!))).toEqual([]);
  }
  expect(batch.operations.find(item => item.path === modelPath)?.diskState).toBe(entryState);
  if (entryState === 'planned') expect(batch.operations.every(item => item.diskState === 'planned')).toBe(true);
}, 20_000);
