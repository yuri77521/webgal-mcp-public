import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

const cli = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
const crashChild = fileURLToPath(new URL('./changes/fixtures/coordinator-child.mjs', import.meta.url));
const maxFileBytes = 1024 * 1024;

let temporary: string;
let project: string;
let otherProject: string;
let sourceRoot: string;
let stateRoot: string;
let homeRoot: string;
let configPath: string;
let sceneDirectory: string;
let sourceImagePath: string;
let sourceChangedPath: string;
let terreServer: Server;
let terreUrl: string;
let terreHealthy = true;
let client: Client;
let stderr = '';
let mixedBatchId: string;
let mixedSceneRevision: string;
let mixedConfigRevision: string;
let originalScene: Buffer;
let originalConfig: Buffer;
let expectedScene: Buffer;
let expectedConfig: Buffer;
let importedAsset: Buffer;

function environment(): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) {
      result[key] = value;
    }
  }
  result.USERPROFILE = homeRoot;
  result.HOME = homeRoot;
  return result;
}

function sha256(bytes: Uint8Array | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

async function snapshot(directory: string): Promise<string> {
  const records: string[] = [];
  const walk = async (current: string, relative: string): Promise<void> => {
    const entries = await readdir(current, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const absolute = path.join(current, entry.name);
      const entryRelative = relative === ''
        ? entry.name
        : relative + '/' + entry.name;
      if (entry.isDirectory()) {
        await walk(absolute, entryRelative);
      } else if (entry.isFile()) {
        records.push(entryRelative + ':' + sha256(await readFile(absolute)));
      }
    }
  };
  await walk(directory, '');
  return sha256(records.join('\n'));
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

async function call(
  target: Client,
  name: string,
  args: Record<string, unknown> = {}
): Promise<{ response: Awaited<ReturnType<Client['callTool']>>; data: any }> {
  const response = await target.callTool({ name, arguments: args });
  const content = response.content as { type: string; text?: string }[];
  let data: any;
  try {
    data = JSON.parse(content[0]?.text ?? 'null');
  } catch {
    data = content[0]?.text;
  }
  return { response, data };
}

function revisionOf(data: any): string {
  const revision = data?.revision ?? data?.sourceRevision ?? data?.sha256;
  expect(typeof revision).toBe('string');
  return revision as string;
}

function operation(type: string, fields: Record<string, unknown>): Record<string, unknown> {
  return { type, ...fields };
}

async function startTerreStub(sceneRoot: string): Promise<{ server: Server; url: string }> {
  const server = createServer((request, response) => {
    const pathname = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
    if (pathname === '/api/test') {
      if (!terreHealthy) {
        response.writeHead(503, { 'content-type': 'text/plain; charset=utf-8' });
        response.end('unavailable');
        return;
      }
      response.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
      response.end('WebGAL Terre Application API Test OK');
      return;
    }
    if (pathname === '/api-json') {
      response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify({
        openapi: '3.0.0',
        info: { title: 'WebGAL Terre API' },
        paths: {
          '/api/test': { get: {} },
          '/api/manageGame/readGameAssets/{readDirPath}': { get: {} }
        }
      }));
      return;
    }
    if (pathname === '/api/manageGame/readGameAssets/game/game/scene') {
      response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify({
        readDirPath: 'game/game/scene',
        dirPath: sceneRoot,
        dirInfo: []
      }));
      return;
    }
    response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    response.end('not found');
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Terre test server did not expose a TCP address.');
  }
  return {
    server,
    url: 'http://127.0.0.1:' + address.port
  };
}

async function connect(
  args: string[]
): Promise<{ client: Client; stderr: () => string }> {
  const instance = new Client({ name: 'webgal-mcp-write-test', version: '1.0.0' });
  const stdio = new StdioClientTransport({
    command: process.execPath,
    args,
    env: environment(),
    cwd: process.cwd(),
    stderr: 'pipe'
  });
  let output = '';
  stdio.stderr?.on('data', (value: Buffer | string) => {
    output += value.toString();
  });
  await instance.connect(stdio);
  return { client: instance, stderr: () => output };
}

function runChild(inputPath: string): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [crashChild, inputPath], {
      cwd: process.cwd(),
      env: environment(),
      windowsHide: true,
      stdio: ['ignore', 'ignore', 'pipe']
    });
    let childStderr = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('Crash child timed out: ' + childStderr));
    }, 10000);
    child.stderr.on('data', (value: Buffer | string) => {
      childStderr += value.toString();
    });
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stderr: childStderr });
    });
  });
}

beforeAll(async () => {
  temporary = await realpath(await mkdtemp(path.join(tmpdir(), 'webgal-mcp-write-server-')));
  project = path.join(temporary, 'Project');
  otherProject = path.join(temporary, 'Other Project');
  sourceRoot = path.join(temporary, 'Source');
  stateRoot = path.join(temporary, 'state');
  homeRoot = path.join(temporary, 'home');
  sceneDirectory = path.join(project, 'game', 'scene');
  sourceImagePath = path.join(sourceRoot, 'images', 'cover.png');
  sourceChangedPath = path.join(sourceRoot, 'images', 'changed.png');
  await mkdir(sceneDirectory, { recursive: true });
  await mkdir(path.join(project, 'game', 'background'), { recursive: true });
  await mkdir(path.join(project, 'game', 'figure'), { recursive: true });
  await mkdir(path.join(project, 'game', 'bgm'), { recursive: true });
  await mkdir(path.join(project, 'game', 'vocal'), { recursive: true });
  await mkdir(path.join(project, 'game', 'video'), { recursive: true });
  await mkdir(path.join(otherProject, 'game', 'scene'), { recursive: true });
  await writeFile(path.join(otherProject, 'game', 'config.txt'), 'Game_name:Other;\n');
  await mkdir(path.join(sourceRoot, 'images'), { recursive: true });
  await mkdir(homeRoot);

  originalScene = Buffer.from('你好\n世界\n', 'utf8');
  originalConfig = Buffer.from('Game_name:Old;\nGame_key:key;\n', 'utf8');
  importedAsset = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff]);
  expectedScene = Buffer.from('你好\nWebGAL\n', 'utf8');
  expectedConfig = Buffer.from('Game_name:New;\nGame_key:key;\n', 'utf8');
  await writeFile(path.join(sceneDirectory, 'start.txt'), originalScene);
  await writeFile(path.join(project, 'game', 'config.txt'), originalConfig);
  await writeFile(sourceImagePath, importedAsset);
  await writeFile(sourceChangedPath, Buffer.from('source-before'));

  const terre = await startTerreStub(sceneDirectory);
  terreServer = terre.server;
  terreUrl = terre.url;
  configPath = path.join(temporary, 'config.json');
  await writeFile(configPath, JSON.stringify({
    version: 1,
    projects: [
      {
        id: 'test',
        name: 'Write Test',
        root: project,
        terreUrl,
        terreGameDir: 'game'
      },
      {
        id: 'other',
        name: 'Other Project',
        root: otherProject
      }
    ],
    sources: [{ id: 'source', root: sourceRoot }]
  }));

  const connected = await connect([
    cli,
    '--config',
    configPath,
    '--state-root',
    stateRoot
  ]);
  client = connected.client;
  stderr = connected.stderr();
});

afterAll(async () => {
  if (client) {
    await client.close();
  }
  if (terreServer) {
    terreServer.closeAllConnections();
    await new Promise<void>((resolve) => terreServer.close(() => resolve()));
  }
  if (temporary) {
    await rm(temporary, { recursive: true, force: true, maxRetries: 3 });
  }
});

describe('P3 real stdio write server', () => {
  it('keeps config-only startup read-only and exposes write tools only with state-root', async () => {
    const readonly = await connect([cli, '--config', configPath]);
    try {
      const tools = (await readonly.client.listTools()).tools;
      expect(tools.map((tool) => tool.name).sort()).toEqual([
        'asset_list',
        'game_config_read',
        'live2d_model_discover',
        'live2d_model_entries',
        'live2d_model_inspect',
        'preview_get_url',
        'project_inspect',
        'project_list',
        'project_scan',
        'scene_list',
        'scene_read',
        'scene_validate',
        'webgal_status'
      ]);
    } finally {
      await readonly.client.close();
    }

    const writeTools = (await client.listTools()).tools.map((tool) => tool.name);
    expect(writeTools).toHaveLength(23);
    expect(writeTools).toEqual(expect.arrayContaining([
      'asset_source_list',
      'asset_source_inspect',
      'write_session_begin',
      'write_session_end',
      'change_plan',
      'change_apply',
      'live2d_import_plan',
      'recovery_inspect',
      'recovery_restore',
      'recovery_reclaim_lock'
    ]));
  });

  it('rejects missing and not-ready handshakes and keeps draft plans non-committable', async () => {
    const before = await snapshot(project);
    const status = await call(client, 'webgal_status', { projectId: 'test' });
    expect(status.response.isError).not.toBe(true);
    expect(status.data).toMatchObject({
      stage: 'P3',
      readOnly: false,
      projectFiles: { readable: true },
      terre: { connectionStatus: 'responded', mappingStatus: 'verified' },
      writeToolsEnabled: true,
      writable: false,
      handoffRequired: true,
      editorState: 'unknown',
    });
    expect(status.data.nextSteps.at(-1)).toContain('成功保存、关闭该工程的所有编辑页，再明确确认本批交接');
    expect(await pathExists(stateRoot)).toBe(false);

    const missingDecision = await call(client, 'write_session_begin', {
      projectId: 'test',
      paths: ['game/scene/start.txt'],
      statement: 'saved'
    });
    expect(missingDecision.response.isError).toBe(true);

    const notReady = await call(client, 'write_session_begin', {
      projectId: 'test',
      paths: ['game/scene/start.txt'],
      decision: 'not-ready',
      statement: 'I have not saved and closed the editor.'
    });
    expect(notReady.response.isError === true || notReady.data?.sessionId == null).toBe(true);

    const draft = await call(client, 'change_plan', {
      projectId: 'test',
      operations: [
        operation('create_scene', { path: 'draft.txt', text: 'draft\n' })
      ]
    });
    expect(draft.response.isError).not.toBe(true);
    expect(draft.data.committable).toBe(false);
    expect(await pathExists(path.join(stateRoot, 'plans'))).toBe(false);
    expect(await snapshot(project)).toBe(before);
  });

  it('rejects a session from another project', async () => {
    const before = await snapshot(project);
    const foreignSession = await call(client, 'write_session_begin', {
      projectId: 'other',
      paths: ['game/scene/foreign.txt'],
      decision: 'saved-and-editors-closed',
      statement: 'I saved and closed all editor pages for this project.'
    });
    expect(foreignSession.response.isError).not.toBe(true);

    const foreignPlan = await call(client, 'change_plan', {
      projectId: 'test',
      sessionId: foreignSession.data.sessionId,
      operations: [
        operation('create_scene', { path: 'foreign.txt', text: 'foreign\n' })
      ]
    });
    expect(foreignPlan.response.isError).toBe(true);
    expect(foreignPlan.data.error.code).toBe('SESSION_MISMATCH');
    expect(await pathExists(path.join(sceneDirectory, 'foreign.txt'))).toBe(false);
    expect(await snapshot(project)).toBe(before);
  });

  it('plans and applies a mixed scene, asset, and config batch with expected bytes', async () => {
    const sources = await call(client, 'asset_source_list');
    expect(JSON.stringify(sources.data)).toContain('source');
    const inspectedSource = await call(client, 'asset_source_inspect', {
      sourceId: 'source',
      path: 'images/cover.png'
    });
    expect(inspectedSource.response.isError).not.toBe(true);
    expect(Number.isInteger(inspectedSource.data.bytes)).toBe(true);
    const sourceRevision = revisionOf(inspectedSource.data);
    const start = await call(client, 'scene_read', {
      projectId: 'test',
      path: 'start.txt'
    });
    const config = await call(client, 'game_config_read', { projectId: 'test' });
    const startText = start.data.text as string;
    const editStart = startText.indexOf('世界');
    expect(editStart).toBeGreaterThanOrEqual(0);

    const session = await call(client, 'write_session_begin', {
      projectId: 'test',
      paths: [
        'game/scene/new.txt',
        'game/scene/start.txt',
        'game/background/cover.png',
        'game/config.txt'
      ],
      decision: 'saved-and-editors-closed',
      statement: 'I saved and closed all editor pages for this project.'
    });
    expect(session.response.isError).not.toBe(true);
    expect(session.data.sessionId).toEqual(expect.any(String));

    const plan = await call(client, 'change_plan', {
      projectId: 'test',
      sessionId: session.data.sessionId,
      operations: [
        operation('create_scene', { path: 'new.txt', text: 'new scene\n' }),
        operation('edit_scene', {
          path: 'start.txt',
          expectedRevision: start.data.revision,
          edits: [{ start: editStart, end: editStart + 2, text: 'WebGAL' }]
        }),
        operation('import_asset', {
          kind: 'background',
          path: 'cover.png',
          sourceId: 'source',
          sourcePath: 'images/cover.png',
          expectedSourceRevision: sourceRevision
        }),
        operation('edit_config', {
          expectedRevision: config.data.revision,
          updates: [{ key: 'Game_name', value: 'New' }]
        })
      ]
    });
    expect(plan.response.isError).not.toBe(true);
    expect(plan.data.committable).toBe(true);
    expect(plan.data.planId).toEqual(expect.any(String));
    expect(plan.data.operations).toHaveLength(4);

    const applied = await call(client, 'change_apply', {
      sessionId: session.data.sessionId,
      planId: plan.data.planId,
      idempotencyKey: 'mixed-write-key'
    });
    expect(applied.response.isError).not.toBe(true);
    expect(applied.data.status).toBe('complete');
    expect(applied.data.batchId).toEqual(expect.any(String));
    mixedBatchId = applied.data.batchId;

    expect(await readFile(path.join(sceneDirectory, 'new.txt'))).toEqual(
      Buffer.from('new scene\n')
    );
    expect(await readFile(path.join(sceneDirectory, 'start.txt'))).toEqual(expectedScene);
    expect(await readFile(path.join(project, 'game', 'background', 'cover.png')))
      .toEqual(importedAsset);
    expect(await readFile(path.join(project, 'game', 'config.txt'))).toEqual(expectedConfig);
    expect(await pathExists(path.join(homeRoot, '.webgal-mcp', 'locks'))).toBe(true);

    const repeated = await call(client, 'change_apply', {
      sessionId: session.data.sessionId,
      planId: plan.data.planId,
      idempotencyKey: 'mixed-write-key'
    });
    expect(repeated.response.isError).not.toBe(true);
    expect(repeated.data.status).toBe('complete');
    expect(repeated.data.replayed).toBe(true);

    const currentScene = await call(client, 'scene_read', {
      projectId: 'test',
      path: 'start.txt'
    });
    const currentConfig = await call(client, 'game_config_read', { projectId: 'test' });
    mixedSceneRevision = currentScene.data.revision;
    mixedConfigRevision = currentConfig.data.revision;
  });

  it('refuses restore after a later human edit', async () => {
    const target = 'game/scene/later.txt';
    const targetPath = path.join(sceneDirectory, 'later.txt');
    const session = await call(client, 'write_session_begin', {
      projectId: 'test',
      paths: [target],
      decision: 'saved-and-editors-closed',
      statement: 'I saved and closed all editor pages for this project.'
    });
    const plan = await call(client, 'change_plan', {
      projectId: 'test',
      sessionId: session.data.sessionId,
      operations: [
        operation('create_scene', { path: 'later.txt', text: 'later-original\n' })
      ]
    });
    const applied = await call(client, 'change_apply', {
      sessionId: session.data.sessionId,
      planId: plan.data.planId,
      idempotencyKey: 'later-human-edit-batch'
    });
    expect(applied.response.isError).not.toBe(true);
    const inspected = await call(client, 'recovery_inspect', {
      projectId: 'test',
      batchId: applied.data.batchId
    });
    expect(inspected.response.isError).not.toBe(true);
    const current = await call(client, 'scene_read', {
      projectId: 'test',
      path: 'later.txt'
    });
    const humanEdit = Buffer.from('human edit after inspection\n');
    await writeFile(targetPath, humanEdit);
    const recoverySession = await call(client, 'write_session_begin', {
      projectId: 'test',
      paths: [target],
      decision: 'saved-and-editors-closed',
      statement: 'I saved and closed all editor pages for this project.'
    });
    const restored = await call(client, 'recovery_restore', {
      projectId: 'test',
      sessionId: recoverySession.data.sessionId,
      batchId: applied.data.batchId,
      selected: [{
        path: target,
        expectedRevision: current.data.revision
      }],
      idempotencyKey: 'later-human-edit-restore'
    });
    expect(restored.response.isError).toBe(true);
    expect(restored.data.error.code).toBe('RECOVERY_CONFLICT');
    expect(await readFile(targetPath)).toEqual(humanEdit);
  });

  it('rejects a source changed after planning with zero target writes', async () => {
    const inspect = await call(client, 'asset_source_inspect', {
      sourceId: 'source',
      path: 'images/changed.png'
    });
    const revision = revisionOf(inspect.data);
    const session = await call(client, 'write_session_begin', {
      projectId: 'test',
      paths: ['game/background/changed.png'],
      decision: 'saved-and-editors-closed',
      statement: 'I saved and closed all editor pages for this project.'
    });
    const plan = await call(client, 'change_plan', {
      projectId: 'test',
      sessionId: session.data.sessionId,
      operations: [
        operation('import_asset', {
          kind: 'background',
          path: 'changed.png',
          sourceId: 'source',
          sourcePath: 'images/changed.png',
          expectedSourceRevision: revision
        })
      ]
    });
    expect(plan.response.isError).not.toBe(true);
    const before = await snapshot(project);
    await writeFile(sourceChangedPath, Buffer.from('source-after'));
    const applied = await call(client, 'change_apply', {
      sessionId: session.data.sessionId,
      planId: plan.data.planId,
      idempotencyKey: 'source-changed-key'
    });
    expect(applied.response.isError).toBe(true);
    expect(applied.data.error.code).toMatch(/SOURCE|REVISION|CHANGED/);
    expect(await snapshot(project)).toBe(before);
    expect(await pathExists(path.join(project, 'game', 'background', 'changed.png')))
      .toBe(false);
  });

  it('refuses apply when the default Terre capability check fails', async () => {
    const target = 'game/scene/offline.txt';
    const session = await call(client, 'write_session_begin', {
      projectId: 'test',
      paths: [target],
      decision: 'saved-and-editors-closed',
      statement: 'I saved and closed all editor pages for this project.'
    });
    const plan = await call(client, 'change_plan', {
      projectId: 'test',
      sessionId: session.data.sessionId,
      operations: [
        operation('create_scene', { path: 'offline.txt', text: 'offline\n' })
      ]
    });
    expect(plan.response.isError).not.toBe(true);
    const before = await snapshot(project);
    terreHealthy = false;
    let applied;
    try {
      applied = await call(client, 'change_apply', {
        sessionId: session.data.sessionId,
        planId: plan.data.planId,
        idempotencyKey: 'offline-capability-key'
      });
    } finally {
      terreHealthy = true;
    }
    expect(applied.response.isError).toBe(true);
    expect(applied.data.error.code).toBe('UNSUPPORTED_CAPABILITY');
    expect(await pathExists(path.join(sceneDirectory, 'offline.txt'))).toBe(false);
    expect(await snapshot(project)).toBe(before);
  });

  it('inspects and restores selected originals while preserving backups and created files', async () => {
    const inspected = await call(client, 'recovery_inspect', {
      projectId: 'test',
      batchId: mixedBatchId
    });
    expect(inspected.response.isError).not.toBe(true);
    expect(inspected.data.status).toBe('complete');
    const sceneOperation = inspected.data.operations.find(
      (operation: any) => operation.path === 'game/scene/start.txt'
    );
    const configOperation = inspected.data.operations.find(
      (operation: any) => operation.path === 'game/config.txt'
    );
    expect(sceneOperation).toMatchObject({ canRestore: true, backupVerified: true });
    expect(configOperation).toMatchObject({ canRestore: true, backupVerified: true });

    const session = await call(client, 'write_session_begin', {
      projectId: 'test',
      paths: ['game/scene/start.txt', 'game/config.txt'],
      decision: 'saved-and-editors-closed',
      statement: 'I saved and closed all editor pages for this project.'
    });
    const restored = await call(client, 'recovery_restore', {
      projectId: 'test',
      sessionId: session.data.sessionId,
      batchId: mixedBatchId,
      selected: [
        { path: 'game/scene/start.txt', expectedRevision: mixedSceneRevision },
        { path: 'game/config.txt', expectedRevision: mixedConfigRevision }
      ],
      idempotencyKey: 'restore-mixed-key'
    });
    expect(restored.response.isError).not.toBe(true);
    expect(restored.data.status).toBe('complete');
    expect(await readFile(path.join(sceneDirectory, 'start.txt'))).toEqual(originalScene);
    expect(await readFile(path.join(project, 'game', 'config.txt'))).toEqual(originalConfig);
    expect(await readFile(path.join(sceneDirectory, 'new.txt'))).toEqual(
      Buffer.from('new scene\n')
    );
    expect(await readFile(path.join(project, 'game', 'background', 'cover.png')))
      .toEqual(importedAsset);

    const originalBackups = path.join(stateRoot, 'batches', mixedBatchId, 'backups');
    const originalBackupBytes = await Promise.all(
      (await readdir(originalBackups))
        .map((name) => readFile(path.join(originalBackups, name)))
    );
    expect(originalBackupBytes.some((bytes) => bytes.equals(originalScene))).toBe(true);
    expect(originalBackupBytes.some((bytes) => bytes.equals(originalConfig))).toBe(true);

    const restoreBatch = restored.data.batchId as string;
    const restoreBackups = path.join(stateRoot, 'batches', restoreBatch, 'backups');
    const restoreBackupBytes = await Promise.all(
      (await readdir(restoreBackups))
        .map((name) => readFile(path.join(restoreBackups, name)))
    );
    expect(restoreBackupBytes.some((bytes) => bytes.equals(expectedScene))).toBe(true);
    expect(restoreBackupBytes.some((bytes) => bytes.equals(expectedConfig))).toBe(true);
  });

  it('invalidates ended sessions and rejects files above 1 MiB without writes', async () => {
    const before = await snapshot(project);
    const ended = await call(client, 'write_session_begin', {
      projectId: 'test',
      paths: ['game/scene/end.txt'],
      decision: 'saved-and-editors-closed',
      statement: 'I saved and closed all editor pages for this project.'
    });
    const endedResponse = await call(client, 'write_session_end', {
      sessionId: ended.data.sessionId
    });
    expect(endedResponse.response.isError).not.toBe(true);
    const afterEnd = await call(client, 'change_plan', {
      projectId: 'test',
      sessionId: ended.data.sessionId,
      operations: [
        operation('create_scene', { path: 'end.txt', text: 'should not write\n' })
      ]
    });
    expect(afterEnd.response.isError).toBe(true);

    const oversizedSession = await call(client, 'write_session_begin', {
      projectId: 'test',
      paths: ['game/scene/too-large.txt'],
      decision: 'saved-and-editors-closed',
      statement: 'I saved and closed all editor pages for this project.'
    });
    const oversized = await call(client, 'change_plan', {
      projectId: 'test',
      sessionId: oversizedSession.data.sessionId,
      operations: [
        operation('create_scene', {
          path: 'too-large.txt',
          text: 'x'.repeat(maxFileBytes + 1)
        })
      ]
    });
    expect(oversized.response.isError).toBe(true);
    expect(await pathExists(path.join(sceneDirectory, 'end.txt'))).toBe(false);
    expect(await pathExists(path.join(sceneDirectory, 'too-large.txt'))).toBe(false);
    expect(await snapshot(project)).toBe(before);
  });

  it('returns schema errors without physical path leakage and keeps stdout protocol clean', async () => {
    const before = await snapshot(project);
    const invalidSession = await call(client, 'write_session_begin', {
      projectId: 'test',
      paths: ['../outside.txt'],
      decision: 'saved-and-editors-closed',
      statement: 'I saved and closed all editor pages for this project.'
    });
    expect(invalidSession.response.isError).toBe(true);
    expect(JSON.stringify(invalidSession.response)).not.toContain(temporary);

    const invalidSource = await call(client, 'asset_source_inspect', {
      sourceId: 'source',
      path: '../outside.bin'
    });
    expect(invalidSource.response.isError).toBe(true);
    expect(JSON.stringify(invalidSource.response)).not.toContain(temporary);

    const traversalSession = await call(client, 'write_session_begin', {
      projectId: 'test',
      paths: ['game/background/escape.png'],
      decision: 'saved-and-editors-closed',
      statement: 'I saved and closed all editor pages for this project.'
    });
    const traversalPlan = await call(client, 'change_plan', {
      projectId: 'test',
      sessionId: traversalSession.data.sessionId,
      operations: [
        operation('import_asset', {
          kind: 'background',
          path: 'escape.png',
          sourceId: 'source',
          sourcePath: '../outside.bin',
          expectedSourceRevision: '0'.repeat(64)
        })
      ]
    });
    expect(traversalPlan.response.isError).toBe(true);
    expect(JSON.stringify(traversalPlan.response)).not.toContain(temporary);

    const invalidPlan = await call(client, 'change_plan', {
      projectId: 'test',
      operations: [
        operation('create_scene', { path: '../escape.txt', text: 'escape\n' })
      ]
    });
    expect(invalidPlan.response.isError || invalidPlan.data?.committable === false).toBe(true);
    expect(JSON.stringify(invalidPlan.response)).not.toContain(temporary);
    expect(await snapshot(project)).toBe(before);
    expect(stderr).toBe('');
  });

  it('reclaims only a dead matching lock through the recovery tool', async () => {
    const target = 'game/scene/reclaim.txt';
    const inputPath = path.join(temporary, 'reclaim-child.json');
    const lockRoot = path.join(homeRoot, '.webgal-mcp', 'locks');
    await writeFile(inputPath, JSON.stringify({
      project: {
        id: 'test',
        name: 'Write Test',
        root: project,
        terreUrl,
        terreGameDir: 'game'
      },
      stateRoot,
      lockRoot,
      ownerId: 'reclaim-owner',
      attestation: {
        source: 'user-message',
        statement: 'I saved and closed all editor pages for this project.'
      },
      idempotencyKey: 'reclaim-crash-key',
      changes: [{
        path: target,
        expectedRevision: null,
        bytesBase64: Buffer.from('reclaim\n').toString('base64')
      }]
    }));
    const child = await runChild(inputPath);
    expect(child.code).toBe(77);

    const lockFiles = await readdir(lockRoot);
    expect(lockFiles).toHaveLength(1);
    const lockRecord = JSON.parse(
      await readFile(path.join(lockRoot, lockFiles[0] as string), 'utf8')
    ) as { token: string };
    const wrong = await call(client, 'recovery_reclaim_lock', {
      projectId: 'test',
      token: randomUUID()
    });
    expect(wrong.response.isError).toBe(true);
    const reclaimed = await call(client, 'recovery_reclaim_lock', {
      projectId: 'test',
      token: lockRecord.token
    });
    expect(reclaimed.response.isError).not.toBe(true);
    expect(JSON.stringify(reclaimed.response)).not.toContain(temporary);
    expect(await readdir(lockRoot)).toEqual([]);
  });

  it('finds a completed request by planId after restart without a new handshake', async () => {
    const targetName = 'lost-receipt-' + randomUUID() + '.txt';
    const target = 'game/scene/' + targetName;
    const targetPath = path.join(sceneDirectory, targetName);
    const bytes = Buffer.from('lost receipt target\n', 'utf8');
    const session = await call(client, 'write_session_begin', {
      projectId: 'test',
      paths: [target],
      decision: 'saved-and-editors-closed',
      statement: 'I saved and closed all editor pages for this project.'
    });
    const plan = await call(client, 'change_plan', {
      projectId: 'test',
      sessionId: session.data.sessionId,
      operations: [
        operation('create_scene', { path: targetName, text: bytes.toString('utf8') })
      ]
    });
    const applied = await call(client, 'change_apply', {
      sessionId: session.data.sessionId,
      planId: plan.data.planId,
      idempotencyKey: 'lost-receipt-' + randomUUID()
    });
    expect(applied.response.isError).not.toBe(true);
    expect(applied.data.status).toBe('complete');
    const savedPlanId = plan.data.planId as string;
    expect(await readFile(targetPath)).toEqual(bytes);

    await client.close();
    const reconnected = await connect([
      cli,
      '--config',
      configPath,
      '--state-root',
      stateRoot
    ]);
    client = reconnected.client;
    stderr = reconnected.stderr();

    const byPlan = await call(client, 'recovery_inspect', {
      projectId: 'test',
      planId: savedPlanId
    });
    expect(byPlan.response.isError).not.toBe(true);
    expect(byPlan.data.total).toBe(1);
    expect(byPlan.data.batches).toHaveLength(1);
    expect(byPlan.data.batches[0]).toMatchObject({
      status: 'complete',
      operations: [{ path: target, phase: 'applied' }]
    });
    expect(await readFile(targetPath)).toEqual(bytes);

    const pendingOnly = await call(client, 'recovery_inspect', {
      projectId: 'test'
    });
    expect(pendingOnly.response.isError).not.toBe(true);
    expect(pendingOnly.data.batches.every((batch: any) => batch.status !== 'complete'))
      .toBe(true);

    const withCompleted = await call(client, 'recovery_inspect', {
      projectId: 'test',
      includeCompleted: true
    });
    expect(withCompleted.response.isError).not.toBe(true);
    expect(withCompleted.data.batches.some((batch: any) => batch.status === 'complete'))
      .toBe(true);
  });

  it('revokes an old handoff after a real stdio process restart', async () => {
    const target = 'game/scene/disconnect.txt';
    const targetPath = path.join(sceneDirectory, 'disconnect.txt');
    const session = await call(client, 'write_session_begin', {
      projectId: 'test',
      paths: [target],
      decision: 'saved-and-editors-closed',
      statement: 'I saved and closed all editor pages for this project.'
    });
    const plan = await call(client, 'change_plan', {
      projectId: 'test',
      sessionId: session.data.sessionId,
      operations: [
        operation('create_scene', { path: 'disconnect.txt', text: 'must-not-write\n' })
      ]
    });
    expect(plan.response.isError).not.toBe(true);
    const before = await snapshot(project);

    await client.close();
    const reconnected = await connect([
      cli,
      '--config',
      configPath,
      '--state-root',
      stateRoot
    ]);
    client = reconnected.client;
    stderr = reconnected.stderr();

    const status = await call(client, 'webgal_status', { projectId: 'test' });
    expect(status.data).toMatchObject({ writeToolsEnabled: true, writable: false, handoffRequired: true });
    const inspection = await call(client, 'recovery_inspect', {
      projectId: 'test'
    });
    expect(inspection.response.isError).not.toBe(true);
    const oldApply = await call(client, 'change_apply', {
      sessionId: session.data.sessionId,
      planId: plan.data.planId,
      idempotencyKey: 'disconnect-old-key'
    });
    expect(oldApply.response.isError).toBe(true);
    expect(oldApply.data.error.code).toMatch(/HANDOFF_REQUIRED|SESSION_MISMATCH/);
    expect(await pathExists(targetPath)).toBe(false);
    expect(await snapshot(project)).toBe(before);
  });

  it('imports a complete model via stdio and applies a scene cue using its actual names', async () => {
    const model = 'performed/hero.model3.json';
    await mkdir(path.join(sourceRoot, 'performed/textures'), { recursive: true });
    await mkdir(path.join(project, 'game/figure'), { recursive: true });
    await writeFile(path.join(sourceRoot, model), JSON.stringify({
      Version: 3,
      FileReferences: {
        Moc: 'hero.moc3', Textures: ['textures/main.png'],
        Motions: { Surprise: [{ File: 'surprise.motion3.json' }] },
        Expressions: [{ Name: 'Surprised', File: 'face.exp3.json' }],
      },
    }));
    for (const file of ['hero.moc3', 'textures/main.png', 'surprise.motion3.json', 'face.exp3.json'])
      await writeFile(path.join(sourceRoot, 'performed', file), file);
    const source = (await call(client, 'asset_source_list')).data.sources[0].id;
    const input = { projectId: 'test', sourceId: source, modelPath: model, targetDirectory: 'hero' };
    const before = await snapshot(project);
    const { data: inspection } = await call(client, 'live2d_model_inspect', {
      location: { kind: 'source', sourceId: source, modelPath: model },
    });
    expect(inspection).toMatchObject({ status: 'valid', motions: [{ name: 'Surprise' }], expressions: [{ name: 'Surprised' }] });
    const { data: draft } = await call(client, 'live2d_import_plan', input);
    expect(draft).toMatchObject({ committable: false, planId: null, blockingIssues: [] });
    expect(await snapshot(project)).toBe(before);
    const { data: session } = await call(client, 'write_session_begin', {
      projectId: 'test', paths: draft.paths, decision: 'saved-and-editors-closed',
      statement: 'I saved and closed all editor pages for this test fixture.',
    });
    const { data: plan } = await call(client, 'live2d_import_plan', {
      ...input, sessionId: session.sessionId, expectedBundleRevision: draft.bundleRevision,
    });
    expect(plan).toMatchObject({ committable: true, modelTargetPath: 'game/figure/hero/hero.model3.json' });
    const { data: applied } = await call(client, 'change_apply', {
      planId: plan.planId, sessionId: session.sessionId, idempotencyKey: 'live2d-stdio',
    });
    expect(applied.status).toBe('complete');
    const { data: recovery } = await call(client, 'recovery_inspect', { projectId: 'test', batchId: applied.batchId });
    expect(recovery.modelBundle.modelPath).toBe(plan.modelTargetPath);
    for (const file of draft.files) expect(sha256(await readFile(path.join(project, file.path)))).toBe(file.revision);
    await call(client, 'write_session_end', { sessionId: session.sessionId });
    const scenePath = 'live2d-demo.txt';
    const initialScene = 'changeFigure:hero/hero.model3.json -id=hero -left;\nHero:You are here?;\n';
    const cue = 'changeFigure:hero/hero.model3.json -id=hero -left -motion=Surprise -expression=Surprised;\n';
    await writeFile(path.join(sceneDirectory, scenePath), initialScene);
    const { data: sceneRead } = await call(client, 'scene_read', { projectId: 'test', path: scenePath });
    const { data: scene } = await call(client, 'scene_validate', {
      projectId: 'test', path: scenePath, candidateText: sceneRead.text + cue,
    });
    expect(scene.live2dIssues).toEqual([]);
    expect(scene.staticReferences).toContainEqual(expect.objectContaining({ path: plan.modelTargetPath, exists: true }));
    const operations = [operation('edit_scene', {
      path: scenePath, expectedRevision: sceneRead.revision,
      edits: [{ start: sceneRead.text.length, end: sceneRead.text.length, text: cue }],
    })];
    const { data: sceneDraft } = await call(client, 'change_plan', { projectId: 'test', operations });
    expect(sceneDraft.committable).toBe(false);
    const { data: editSession } = await call(client, 'write_session_begin', {
      projectId: 'test', paths: [`game/scene/${scenePath}`], decision: 'saved-and-editors-closed',
      statement: 'I saved and closed all editor pages for the scene edit.',
    });
    const { data: scenePlan } = await call(client, 'change_plan', {
      projectId: 'test', sessionId: editSession.sessionId, operations,
    });
    const { data: edit } = await call(client, 'change_apply', {
      planId: scenePlan.planId, sessionId: editSession.sessionId, idempotencyKey: 'live2d-cue',
    });
    expect(edit.status).toBe('complete');
    await call(client, 'write_session_end', { sessionId: editSession.sessionId });
    expect(await readFile(path.join(sceneDirectory, scenePath), 'utf8')).toBe(initialScene + cue);
  });
});
