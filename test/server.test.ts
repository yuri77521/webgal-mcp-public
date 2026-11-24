import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, rm, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { createServer, type Server } from 'node:http';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

let temporary: string;
let project: string;
let brokenProject: string;
let client: Client;
let terreServer: Server;
let terreMode: 'healthy' | 'no_response' | 'wrong_api' | 'unverified' | 'mismatch' = 'healthy';
let stderr = '';
let before: string;
const cli = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
async function snapshot(dir: string): Promise<string> {
  const all: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const child = path.join(dir, entry.name);
    all.push(entry.isDirectory() ? `${entry.name}/${await snapshot(child)}` : `${entry.name}:${createHash('sha256').update(await readFile(child)).digest('hex')}`);
  }
  return all.sort().join('|');
}
async function call(name: string, args: Record<string, unknown> = {}) {
  const response = await client.callTool({ name, arguments: args });
  const content = response.content as { type: string; text?: string }[];
  let data: any;
  try { data = JSON.parse(content[0].text!); } catch { data = content[0].text; }
  return { ...response, data };
}
beforeAll(async () => {
  temporary = await realpath(await mkdtemp(path.join(os.tmpdir(), 'webgal-mcp-server-')));
  project = path.join(temporary, 'game project');
  brokenProject = path.join(temporary, 'other project');
  await mkdir(path.join(project, 'game/scene/chapter'), { recursive: true });
  await mkdir(path.join(project, 'game/background'), { recursive: true });
  await writeFile(path.join(project, 'game/scene/start.txt'), 'changeBg:missing.png;\n角色:你好;\nchangeScene:chapter/next.txt;\n');
  await writeFile(path.join(project, 'game/scene/chapter/next.txt'), '');
  await writeFile(path.join(project, 'game/scene/large.txt'), '"'.repeat(600_000));
  await writeFile(path.join(project, 'game/config.txt'), 'Game_name:P1 fixture;\nGame_key:p1-fixture;\n');
  await writeFile(path.join(project, 'game/background/测试.png'), new Uint8Array([1, 2, 3]));
  await mkdir(path.join(brokenProject, 'game/scene'), { recursive: true });
  await writeFile(path.join(brokenProject, 'game/config.txt'), Buffer.from([0xff, 0xfe]));

  terreServer = createServer((request, response) => {
    if (terreMode === 'no_response') {
      request.socket.destroy();
      return;
    }
    if (request.url === '/api/test') {
      response.end(terreMode === 'wrong_api' ? 'private HTTP response' : 'WebGAL Terre Application API Test OK');
      return;
    }
    if (request.url === '/api-json') {
      response.end(JSON.stringify({
        openapi: '3.0.0',
        info: { title: 'WebGAL Terre API' },
        paths: {
          '/api/test': { get: {} },
          '/api/manageGame/readGameAssets/{readDirPath}': { get: {} },
        },
      }));
      return;
    }
    const mapping = request.url?.match(/^\/api\/manageGame\/readGameAssets\/(mapped|broken)\/game\/scene$/)?.[1];
    if (mapping) {
      const directory = mapping === 'broken' || terreMode === 'mismatch' ? brokenProject : project;
      response.end(terreMode === 'unverified' ? 'private HTTP response' : JSON.stringify({
        readDirPath: `${mapping}/game/scene`,
        dirPath: path.join(directory, 'game/scene'),
        dirInfo: [{ name: 'private-stub.txt', isDir: false, extName: '.txt', path: path.join(directory, 'private-stub.txt') }],
      }));
      return;
    }
    response.writeHead(404).end();
  });
  terreServer.listen(0, '127.0.0.1');
  await once(terreServer, 'listening');
  const address = terreServer.address();
  if (!address || typeof address === 'string') throw new Error('Missing Terre test port.');
  const terreUrl = `http://127.0.0.1:${address.port}`;
  const config = path.join(temporary, 'config.json');
  await writeFile(config, JSON.stringify({ version: 1, projects: [
    { id: 'test', root: project },
    { id: 'mapped', root: project, terreUrl, terreGameDir: 'mapped' },
    { id: 'broken', root: brokenProject, terreUrl, terreGameDir: 'broken' },
    { id: 'wrong-root', root: path.join(project, 'game'), terreUrl, terreGameDir: 'mapped' },
  ] }));
  before = await snapshot(project);
  client = new Client({ name: 'webgal-mcp-p1-test', version: '1.0.0' });
  const transport = new StdioClientTransport({ command: process.execPath, args: [cli, '--config', config], stderr: 'pipe' });
  transport.stderr?.on('data', value => { stderr += value.toString(); });
  await client.connect(transport);
});
afterAll(async () => {
  if (client) await client.close();
  if (terreServer?.listening) {
    terreServer.closeAllConnections();
    await new Promise<void>(resolve => terreServer.close(() => resolve()));
  }
  if (temporary) await rm(temporary, { recursive: true, force: true });
});
describe('P1 real stdio read-only tool surface', () => {
  it('exposes the read tools and no mutation surface', async () => {
    const tools = (await client.listTools()).tools;
    expect(tools.map(t => t.name).sort()).toEqual(['webgal_status', 'project_list', 'project_inspect', 'project_scan', 'scene_list', 'scene_read', 'scene_validate', 'asset_list', 'live2d_model_discover', 'live2d_model_inspect', 'live2d_model_entries', 'game_config_read', 'preview_get_url'].sort());
    expect(tools.every(t => t.annotations?.readOnlyHint === true && t.annotations?.destructiveHint === false)).toBe(true);
    const status = await call('webgal_status');
    expect(status.data).toMatchObject({
      writable: false, editorState: 'unknown', writeToolsEnabled: false, handoffRequired: true,
      nextSteps: [expect.stringContaining('project_list'), expect.stringContaining('--state-root')],
    });
    expect(status.data).not.toHaveProperty('projectFiles');
    expect(status.data).not.toHaveProperty('terre');
  });
  it('reads authorized content, paginates, and preserves empty files', async () => {
    const projects = await call('project_list');
    expect(projects.data.items).toEqual([
      { id: 'test', name: 'test' },
      { id: 'mapped', name: 'mapped' },
      { id: 'broken', name: 'broken' },
      { id: 'wrong-root', name: 'wrong-root' },
    ]);
    const first = await call('scene_list', { projectId: 'test', limit: 1 });
    expect(first.data.items).toHaveLength(1);
    const second = await call('scene_list', { projectId: 'test', limit: 1, cursor: first.data.nextCursor });
    expect(second.data.items).toHaveLength(1);
    expect(first.data.items[0].path).not.toBe(second.data.items[0].path);
    const empty = await call('scene_read', { projectId: 'test', path: 'chapter/next.txt' });
    expect(empty.data).toMatchObject({ text: '', bytes: 0, source: 'disk' });
    expect(empty.data.revision).toMatch(/^[a-f0-9]{64}$/);
    const config = await call('game_config_read', { projectId: 'test' });
    expect(config.data.text).toContain('P1 fixture');
    expect((await call('asset_list', { projectId: 'test' })).data.items).toHaveLength(1);
    expect((await call('project_inspect', { projectId: 'test' })).data.projectType).toBe('content-only');
  });
  it('returns explicit errors without leaking filesystem roots', async () => {
    for (const args of [{ projectId: 'unknown', path: 'start.txt' }, { projectId: 'test', path: '../config.txt' }, { projectId: 'test', path: 'missing.txt' }]) {
      const response = await call('scene_read', args);
      expect(response.isError).toBe(true);
      expect(JSON.stringify(response)).not.toContain(temporary);
    }
    expect((await call('scene_list', { projectId: 'test', cursor: 'invalid' })).isError).toBe(true);
    expect((await call('preview_get_url', { projectId: 'test' })).isError).toBe(true);
    expect((await call('scene_read', { projectId: 'test', path: 'start.txt', force: true })).isError).toBe(true);
  });
  it('analyzes references without changing project files or stdout logging', async () => {
    const analyzed = await call('scene_validate', { projectId: 'test', path: 'start.txt' });
    expect(analyzed.isError).not.toBe(true);
    expect(JSON.stringify(analyzed.data)).toContain('missing.png');
    expect(await snapshot(project)).toBe(before);
    expect(stderr).toBe('');
  });
  it('scans saved scenes over stdio in read-only mode and reports the actual coverage', async () => {
    const result = await call('project_scan', { projectId: 'test', startAfter: 'large.txt' });
    expect(result.isError).not.toBe(true);
    expect(result.data).toMatchObject({
      complete: false,
      scope: { totalScenes: 3, scenesBeforeStart: 2, checkedScenes: 1, remainingScenes: 0 },
      scenes: [{
        path: 'start.txt', status: 'checked',
        issues: [{ category: 'missing', target: 'game/background/missing.png', line: 1 }],
      }],
    });
    expect(JSON.stringify(result.data)).not.toContain('你好');
    expect(await snapshot(project)).toBe(before);
    expect((await call('project_scan', { projectId: 'unknown' })).isError).toBe(true);
    expect((await call('project_scan', { projectId: 'test', limit: 101 })).isError).toBe(true);
  });
  it('enforces the complete MCP response size and cursor binding', async () => {
    const oversized = await call('scene_read', { projectId: 'test', path: 'large.txt' });
    expect(oversized.isError).toBe(true);
    expect(oversized.data.error.code).toBe('LIMIT_EXCEEDED');
    expect(JSON.stringify(oversized).length).toBeLessThan(1000);
    const scenes = await call('scene_list', { projectId: 'test', limit: 1 });
    expect((await call('asset_list', { projectId: 'test', cursor: scenes.data.nextCursor })).isError).toBe(true);
  });
});

describe('NEXT-01 over real MCP stdio', () => {
  it.each([
    { mode: 'healthy', connection: 'responded', mapping: 'verified', hint: 'preview_get_url' },
    { mode: 'no_response', connection: 'no_response', mapping: 'unverified', hint: '确认 Terre 是否已启动，以及 terreUrl 的端口是否与它一致' },
    { mode: 'wrong_api', connection: 'responded', mapping: 'verified', hint: '未能核对 Terre API' },
    { mode: 'unverified', connection: 'responded', mapping: 'unverified', hint: '未能验证工程映射' },
    { mode: 'mismatch', connection: 'responded', mapping: 'mismatch', hint: '场景目录与本机工程不匹配' },
  ] as const)('explains $mode without exposing private data or changing the project', async ({ mode, connection, mapping, hint }) => {
    const beforeBroken = await snapshot(brokenProject);
    terreMode = mode;
    try {
      const status = await call('webgal_status', { projectId: 'mapped' });
      expect(status.isError).not.toBe(true);
      expect(status.data).toMatchObject({
        projectFiles: { readable: true },
        terre: { connectionStatus: connection, mappingStatus: mapping },
        writeToolsEnabled: false,
        writable: false,
        handoffRequired: true,
      });
      expect(status.data.nextSteps[0]).toContain(hint);
      if (mode !== 'healthy') expect(status.data.nextSteps.join(' ')).not.toContain('preview_get_url');
      const payload = JSON.stringify(status.data);
      expect(payload).not.toContain(JSON.stringify(temporary).slice(1, -1));
      expect(payload).not.toContain(temporary.replaceAll('\\', '/'));
      for (const privateText of ['p1-fixture', '角色:你好', 'private HTTP response', 'private-stub.txt']) {
        expect(payload).not.toContain(privateText);
      }
      expect(await snapshot(project)).toBe(before);
      expect(await snapshot(brokenProject)).toBe(beforeBroken);
    } finally {
      terreMode = 'healthy';
    }
  });

  it('guides an unconfigured Terre project while keeping local reads available', async () => {
    const status = await call('webgal_status', { projectId: 'test' });
    expect(status.isError).not.toBe(true);
    expect(status.data).toMatchObject({
      projectFiles: { readable: true },
      terre: { connectionStatus: 'not_configured', mappingStatus: 'not_configured' },
    });
    expect(status.data.nextSteps[0]).toContain('terreUrl');
    expect(status.data.nextSteps[0]).toContain('terreGameDir');
    expect(status.data.nextSteps).toContainEqual(expect.stringContaining('scene_read'));
  });

  it('keeps Terre results available when local config is unreadable', async () => {
    const beforeBroken = await snapshot(brokenProject);
    const status = await call('webgal_status', { projectId: 'broken' });
    expect(status.isError).not.toBe(true);
    expect(status.data).toMatchObject({
      projectFiles: { readable: false, errorCode: 'UNSUPPORTED_FORMAT' },
      terre: { connectionStatus: 'responded', mappingStatus: 'verified' },
    });
    expect(status.data.nextSteps[0]).toContain('game/config.txt 使用 UTF-8');
    expect(status.data.nextSteps.join(' ')).not.toContain('preview_get_url');
    const inspection = await call('project_inspect', { projectId: 'broken' });
    expect(inspection.isError).toBe(true);
    expect(inspection.data.error.code).toBe('UNSUPPORTED_FORMAT');
    expect(await snapshot(brokenProject)).toBe(beforeBroken);
  });

  it('points the user to root when the configured folder is inside the project', async () => {
    const status = await call('webgal_status', { projectId: 'wrong-root' });
    expect(status.isError).not.toBe(true);
    expect(status.data).toMatchObject({
      projectFiles: { readable: false, errorCode: 'FILE_NOT_FOUND' },
      terre: { connectionStatus: 'responded', mappingStatus: 'unverified' },
    });
    expect(status.data.nextSteps[0]).toContain('核对 root');
    expect(status.data.nextSteps).toContainEqual(expect.stringContaining('重启 MCP 连接'));
    expect(await snapshot(project)).toBe(before);
  });
});
