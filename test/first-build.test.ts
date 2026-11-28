import { createHash } from 'node:crypto';
import { access, link, mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WRITE_LIMITS } from '../src/changes/types.js';

const cli = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
const initialScene = '旁白:空白模板;\n';
const originalScene = '旁白:正式工程;\n';
const initialConfig = 'Game_name:Blank;\nGame_key:blank;\n';
const assetBytes = Buffer.from('fixture-asset');
const input = { storyRevision: digest('approved script'), scenes: ['start.txt'], assets: [], configKeys: [] };
let temporary: string;
let sandbox: string;
let template: string;
let existing: string;
let source: string;
let client: Client | undefined;

function digest(bytes: string | Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

async function connect(overrides: Record<string, unknown> = {}) {
  const configPath = path.join(temporary, 'config.json');
  await writeFile(configPath, JSON.stringify({
    version: 1,
    projects: [{ id: 'existing', root: existing }],
    sources: [{ id: 'library', root: source }],
    firstBuild: { root: sandbox, templateRoot: template, terreGamesRoots: [path.dirname(existing)] },
    ...overrides
  }));
  const connection = new Client({ name: 'creator-first-build-test', version: '1.0.0' });
  await connection.connect(new StdioClientTransport({
    command: process.execPath, args: [cli, '--config', configPath, '--state-root', path.join(temporary, 'state')],
    stderr: 'inherit'
  }));
  return connection;
}

async function call(name: string, args: Record<string, unknown> = {}) {
  const response = await client!.callTool({ name, arguments: args });
  const content = response.content as { type: string; text: string }[];
  const data = JSON.parse(content[0].text);
  return { isError: response.isError ?? false, data };
}

async function begin(overrides: Record<string, unknown> = {}) {
  const reply = await call('first_build_begin', {
    ...input, ...overrides, statement: '我确认剧本、路径与素材，授权这次临时首版制作。'
  });
  expect(reply.isError, JSON.stringify(reply.data)).toBe(false);
  return reply.data.runId as string;
}

function project(runId: string, relative: string): string {
  return path.join(sandbox, runId, 'project', relative);
}

function apply(runId: string, idempotencyKey: string, operations: unknown[], storyRevision = input.storyRevision) {
  return call('first_build_apply', { runId, idempotencyKey, storyRevision, operations });
}

function editStart(text: string, base = initialScene) {
  return { type: 'edit_scene', path: 'start.txt', expectedRevision: digest(base), edits: [{ start: 0, end: base.length, text }] };
}

beforeEach(async () => {
  temporary = await realpath(await mkdtemp(path.join(tmpdir(), 'webgal-first-build-')));
  sandbox = path.join(temporary, 'sandbox');
  template = path.join(temporary, 'template');
  existing = path.join(temporary, 'terre-games', 'existing');
  source = path.join(temporary, 'source');
  for (const root of [template, existing]) {
    await mkdir(path.join(root, 'game/scene'), { recursive: true });
    await writeFile(path.join(root, 'index.html'), '<!doctype html><title>First build test</title>');
    await writeFile(path.join(root, 'game/config.txt'), initialConfig);
  }
  await mkdir(sandbox);
  await mkdir(source);
  await writeFile(path.join(template, 'game/scene/start.txt'), initialScene);
  await writeFile(path.join(existing, 'game/scene/start.txt'), originalScene);
  await writeFile(path.join(source, 'station.png'), assetBytes);
  client = await connect();
});

afterEach(async () => {
  await client?.close();
  client = undefined;
  await rm(temporary, { recursive: true, force: true, maxRetries: 3 });
});

describe('Creator isolated first build over real stdio and disk', () => {
  it('authorizes one build across more than one batch, verifies its files, and delivers only the read-only snapshot', async () => {
    const names = Array.from({ length: WRITE_LIMITS.maxFiles }, (_, index) => 'part-' + index + '.txt');
    const asset = { kind: 'background', path: 'station.png', sourceId: 'library', sourcePath: 'station.png',
      expectedSourceRevision: digest(assetBytes) };
    const runId = await begin({ scenes: ['start.txt', ...names], assets: [asset], configKeys: ['Game_name'] });
    const ignoredByNormalTools = await call('write_session_begin', {
      projectId: runId, paths: ['game/scene/start.txt'], decision: 'saved-and-editors-closed', statement: 'test'
    });
    expect(ignoredByNormalTools.data.error.code).toBe('PROJECT_NOT_AUTHORIZED');

    const firstOps = [{ type: 'import_asset', ...asset },
      ...names.slice(0, -1).map(name => ({ type: 'create_scene', path: name, text: '旁白:场景内容;\n' }))];
    const first = await apply(runId, 'first', firstOps);
    expect(first.data, JSON.stringify(first.data)).toMatchObject({ status: 'complete', replayed: false });
    const replay = await apply(runId, 'first', firstOps);
    expect(replay.data).toMatchObject({ batchId: first.data.batchId, planId: first.data.planId, replayed: true });
    const text = 'changeBg:station.png -next;\n旁白:独立首版;\n';
    const second = await apply(runId, 'second', [
      { type: 'create_scene', path: names.at(-1), text: '旁白:尾声;\n' },
      editStart(text),
      { type: 'edit_config', expectedRevision: digest(initialConfig), updates: [{ key: 'Game_name', value: 'First edition' }] }
    ]);
    expect(second.data, JSON.stringify(second.data)).toMatchObject({ status: 'complete', replayed: false });
    expect(second.data.batchId).not.toBe(first.data.batchId);
    const preview = await call('first_build_preview', { runId, deliver: false });
    const delivery = await call('first_build_preview', { runId, deliver: true, snapshotId: preview.data.snapshotId });
    expect(delivery.data).toMatchObject({
      state: 'delivered', snapshotId: preview.data.snapshotId, previewUrl: preview.data.previewUrl
    });
    const url = new URL('game/scene/start.txt', delivery.data.previewUrl);
    expect(await (await fetch(url)).text()).toBe(text);
    expect((await fetch(url, { method: 'POST', body: 'overwrite' })).status).toBe(405);
    expect((await fetch(new URL('authorization.json', delivery.data.previewUrl))).status).toBe(404);
    expect((await fetch(url, { method: 'HEAD' })).status).toBe(200);
    await writeFile(path.join(delivery.data.snapshotPath, 'added.txt'), 'unexpected');
    expect((await fetch(new URL('added.txt', delivery.data.previewUrl))).status).toBe(404);
    await writeFile(path.join(delivery.data.snapshotPath, 'game/scene/start.txt'), 'edited snapshot');
    expect((await fetch(url)).status).toBe(404);
    const late = await apply(runId, 'third', [editStart('旁白:应该被拦截;\n', text)]);
    expect(late.data.error.code).toBe('FIRST_BUILD_CONFIRMATION_REQUIRED');
    expect(await readFile(project(runId, 'game/scene/start.txt'), 'utf8')).toBe(text);
    expect(await readFile(path.join(existing, 'game/scene/start.txt'), 'utf8')).toBe(originalScene);
    expect(await readFile(path.join(template, 'game/scene/start.txt'), 'utf8')).toBe(initialScene);
    expect(await readFile(path.join(source, 'station.png'))).toEqual(assetBytes);
  });

  it('blocks incomplete delivery and delivers only the latest reviewed, unchanged snapshot', async () => {
    const asset = { kind: 'background', path: 'station.png', sourceId: 'library', sourcePath: 'station.png',
      expectedSourceRevision: digest(assetBytes) };
    const runId = await begin({ scenes: ['start.txt', 'chapter.txt'], assets: [asset] });
    const early = await call('first_build_preview', { runId, deliver: true });
    expect(early.data.error).toMatchObject({
      code: 'FIRST_BUILD_INCOMPLETE', message: expect.stringContaining('game/scene/start.txt')
    });
    const oldPreview = (await call('first_build_preview', { runId, deliver: false })).data;
    expect((await apply(runId, 'opening', [editStart('旁白:审批中;\n')])).data.status).toBe('complete');
    const partial = await call('first_build_preview', { runId, deliver: true, snapshotId: oldPreview.snapshotId });
    expect(partial.data.error).toMatchObject({
      code: 'FIRST_BUILD_INCOMPLETE', message: expect.stringContaining('game/background/station.png')
    });
    expect((await apply(runId, 'remaining', [{ type: 'import_asset', ...asset },
      { type: 'create_scene', path: 'chapter.txt', text: '旁白:完成;\n' }])).data.status).toBe('complete');
    expect((await call('first_build_preview', { runId, deliver: true, snapshotId: oldPreview.snapshotId })).data.error.code)
      .toBe('FIRST_BUILD_PREVIEW_REQUIRED');
    const preview = (await call('first_build_preview', { runId, deliver: false })).data;
    const snapshotFile = path.join(sandbox, runId, 'snapshot-' + preview.snapshotId, 'game/scene/start.txt');
    await writeFile(snapshotFile, '快照被外部改动');
    expect((await call('first_build_preview', { runId, deliver: true, snapshotId: preview.snapshotId })).data.error.code)
      .toBe('FIRST_BUILD_PREVIEW_REQUIRED');
    const fresh = (await call('first_build_preview', { runId, deliver: false })).data;
    expect((await call('first_build_preview', { runId, deliver: true, snapshotId: fresh.snapshotId })).data)
      .toMatchObject({ state: 'delivered', previewUrl: fresh.previewUrl, snapshotId: fresh.snapshotId });
  });

  it('pauses before writing the next batch when a different file changes externally', async () => {
    const runId = await begin({ scenes: ['start.txt', 'next.txt'] });
    const firstText = '旁白:已写入;\n';
    expect((await apply(runId, 'first', [editStart(firstText)])).data.status).toBe('complete');
    await writeFile(project(runId, 'game/config.txt'), 'Game_name:作者在外部改过;\n');
    const second = await apply(runId, 'second', [{ type: 'create_scene', path: 'next.txt', text: '旁白:不会落盘;\n' }]);
    expect(second.data.error).toMatchObject({ code: 'FIRST_BUILD_CONFIRMATION_REQUIRED', message: expect.stringContaining('game/config.txt') });
    expect((await call('first_build_inspect', { runId })).data).toMatchObject({ state: 'paused', requiresUserConfirmation: true });
    expect((await apply(runId, 'third', [editStart('旁白:不恢复旧权限;\n', firstText)])).data.error.code)
      .toBe('FIRST_BUILD_CONFIRMATION_REQUIRED');
    await expect(access(project(runId, 'game/scene/next.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(project(runId, 'game/config.txt'), 'utf8')).toBe('Game_name:作者在外部改过;\n');
    expect(await readFile(project(runId, 'game/scene/start.txt'), 'utf8')).toBe(firstText);
  });

  it('pauses an entire mixed batch when one operation is outside the authorized scope', async () => {
    const runId = await begin();
    const result = await apply(runId, 'mixed', [
      editStart('旁白:这条也不能先写;\n'),
      { type: 'create_scene', path: 'unapproved.txt', text: '旁白:超范围;\n' }
    ]);
    expect(result.data.error).toMatchObject({ code: 'FIRST_BUILD_CONFIRMATION_REQUIRED', message: expect.stringContaining('unapproved.txt') });
    expect((await apply(runId, 'retry', [editStart('旁白:必须重新确认;\n')])).data.error.code)
      .toBe('FIRST_BUILD_CONFIRMATION_REQUIRED');
    expect(await readFile(project(runId, 'game/scene/start.txt'), 'utf8')).toBe(initialScene);
    await expect(access(project(runId, 'game/scene/unapproved.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects a changed story revision, a different asset revision, and a cross-project hard link', async () => {
    const storyRun = await begin();
    expect((await apply(storyRun, 'changed-story', [editStart('旁白:草稿;\n')], digest('other story'))).data.error.code)
      .toBe('FIRST_BUILD_CONFIRMATION_REQUIRED');
    const asset = { kind: 'background', path: 'station.png', sourceId: 'library', sourcePath: 'station.png',
      expectedSourceRevision: digest(assetBytes) };
    const assetRun = await begin({ assets: [asset] });
    await writeFile(path.join(source, 'station.png'), 'externally different');
    expect((await apply(assetRun, 'changed-source', [{ type: 'import_asset', ...asset }])).data.error.code)
      .toBe('FIRST_BUILD_CONFIRMATION_REQUIRED');
    const linkRun = await begin();
    const target = project(linkRun, 'game/scene/start.txt');
    await rm(target);
    await link(path.join(existing, 'game/scene/start.txt'), target);
    expect((await apply(linkRun, 'link', [editStart('旁白:不能改原工程;\n', originalScene)])).data.error.code)
      .toBe('FIRST_BUILD_CONFIRMATION_REQUIRED');
    expect(await readFile(path.join(existing, 'game/scene/start.txt'), 'utf8')).toBe(originalScene);
  });

  it('rejects an isolated root inside a configured Terre library before creating any files', async () => {
    await client!.close();
    client = await connect({ firstBuild: { root: existing, templateRoot: template, terreGamesRoots: [path.dirname(existing)] } });
    const result = await call('first_build_begin', { ...input, statement: '测试拒绝把现有项目当作隔离根。' });
    expect(result.data.error.code).toBe('FIRST_BUILD_ROOT_OVERLAP');
    expect(await readFile(path.join(existing, 'game/scene/start.txt'), 'utf8')).toBe(originalScene);
  });

  it('reads verified and incomplete receipts after reconnecting without restoring write access', async () => {
    const runId = await begin({ scenes: ['start.txt', 'chapter.txt'] });
    const newText = '旁白:已核对;\n';
    const complete = (await apply(runId, 'verified-before-restart', [editStart(newText)])).data;
    expect(complete.status).toBe('complete');
    const interrupted = (await apply(runId, 'interrupted-receipt', [
      { type: 'create_scene', path: 'chapter.txt', text: '旁白:未确认;\n' }
    ])).data;
    expect(interrupted.status).toBe('complete');
    const receipt = path.join(sandbox, runId, interrupted.planId + '.result.json');
    await rename(receipt, receipt + '.hold');
    await client!.close();
    client = await connect();
    const archive = await call('first_build_inspect', { runId });
    expect(archive.data).toMatchObject({
      state: 'archived', requiresUserConfirmation: true,
      batches: expect.arrayContaining([
        { planId: complete.planId, batchId: complete.batchId, verified: true, paths: ['game/scene/start.txt'] },
        { planId: interrupted.planId, verified: false, paths: ['game/scene/chapter.txt'] }
      ])
    });
    expect((await apply(runId, 'after-restart', [editStart('旁白:旧授权到期;\n', newText)])).data.error.code)
      .toBe('FIRST_BUILD_CONFIRMATION_REQUIRED');
    expect((await call('first_build_inspect', { runId, scenePath: 'start.txt' })).data.error.code)
      .toBe('FIRST_BUILD_ARCHIVE_ONLY');
    expect(await readFile(project(runId, 'game/scene/start.txt'), 'utf8')).toBe(newText);
  });
});
