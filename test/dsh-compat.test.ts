import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { access, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { directoryPublisherEnv } from '../src/changes/targets.js';
import { serverInstructions } from '../src/server.js';

const cli = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
const DSH_MAX_INSTRUCTION_BYTES = 32_768;
const TARGET_MAX_INSTRUCTION_BYTES = 2_048;

const READ_ONLY_TOOLS = [
  'webgal_status',
  'project_list',
  'project_inspect',
  'project_scan',
  'scene_list',
  'scene_read',
  'scene_validate',
  'asset_list',
  'live2d_model_inspect',
  'game_config_read',
  'preview_get_url',
] as const;

const WRITE_READ_ONLY_TOOLS = [
  'asset_source_list',
  'asset_source_inspect',
  'recovery_inspect',
] as const;

const DESTRUCTIVE_WRITE_TOOLS = [
  'change_apply',
  'recovery_restore',
] as const;

const NON_DESTRUCTIVE_WRITE_TOOLS = [
  'write_session_begin',
  'change_plan',
  'live2d_import_plan',
  'write_session_end',
  'recovery_reclaim_lock',
] as const;

let temporary: string;
let project: string;
let sourceRoot: string;
let otherCwd: string;
let configPath: string;
let terreServer: Server;
let terreUrl: string;

async function pathExists(target: string): Promise<boolean> {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

function minimalScrubbedEnv(): Record<string, string> {
  // Mirrors dsh-mcp-client scrubbedParentEnv() plus minimal OS runtime variables only.
  const keep = process.platform === 'win32'
    ? ['SYSTEMROOT', 'COMSPEC', 'PATH', 'TEMP', 'TMP']
    : ['PATH'];
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (/KEY|PASSWORD|SECRET|TOKEN/i.test(key) || /^DSH_/i.test(key)) continue;
    if (keep.includes(key.toUpperCase())) {
      env[key] = value;
    }
  }
  return env;
}

async function connectStdio(options: {
  args: string[];
  env?: Record<string, string>;
  cwd?: string;
}): Promise<{ client: Client; stderr: () => string }> {
  const client = new Client({ name: 'dsh-compat-test', version: '1.0.0' });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: options.args,
    env: options.env,
    cwd: options.cwd,
    stderr: 'pipe',
  });
  let stderr = '';
  transport.stderr?.on('data', (chunk: Buffer | string) => {
    stderr += chunk.toString();
  });
  await client.connect(transport);
  return { client, stderr: () => stderr };
}

async function callTool(client: Client, name: string, args: Record<string, unknown> = {}) {
  const response = await client.callTool({ name, arguments: args });
  const content = response.content as { type: string; text?: string }[];
  let data: unknown;
  try {
    data = JSON.parse(content[0]?.text ?? 'null');
  } catch {
    data = content[0]?.text;
  }
  return { response, content, data: data as any };
}

function auditJsonSchemaNode(toolName: string, node: unknown, pointer = '$'): void {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    node.forEach((item, index) => auditJsonSchemaNode(toolName, item, `${pointer}[${index}]`));
    return;
  }
  const record = node as Record<string, unknown>;
  for (const forbidden of ['$ref', '$defs', '$dynamicRef', '$anchor']) {
    expect(record, `${toolName} ${pointer} should not emit ${forbidden}`).not.toHaveProperty(forbidden);
  }
  if (typeof record.pattern === 'string') {
    expect(record.pattern, `${toolName} ${pointer} pattern must not contain UTF-16 surrogates`).not.toMatch(/[\uD800-\uDFFF]/);
    expect(record.pattern, `${toolName} ${pointer} pattern must not require Unicode property/codepoint escapes`).not.toContain('\\u{');
    expect(() => new RegExp(record.pattern as string), `${toolName} ${pointer} pattern must compile`).not.toThrow();
  }
  if (Array.isArray(record.oneOf)) {
    expect(record.oneOf.length, `${toolName} ${pointer} oneOf must have >= 2 branches`).toBeGreaterThanOrEqual(2);
    for (const [index, branch] of record.oneOf.entries()) {
      expect(branch, `${toolName} ${pointer}.oneOf[${index}] must be strict object`).toMatchObject({
        type: 'object',
        additionalProperties: false,
      });
    }
  }
  for (const [key, value] of Object.entries(record)) {
    if (key === 'required' || key === 'enum') continue;
    auditJsonSchemaNode(toolName, value, `${pointer}.${key}`);
  }
}

beforeAll(async () => {
  temporary = await realpath(await mkdtemp(path.join(tmpdir(), 'webgal-mcp-dsh-')));
  project = path.join(temporary, 'demo-game');
  sourceRoot = path.join(temporary, 'sources');
  otherCwd = path.join(temporary, 'unrelated-cwd');
  await mkdir(path.join(project, 'game', 'scene'), { recursive: true });
  await mkdir(path.join(project, 'game', 'background'), { recursive: true });
  await mkdir(path.join(project, 'game', 'figure'), { recursive: true });
  await mkdir(sourceRoot, { recursive: true });
  await mkdir(otherCwd, { recursive: true });

  await writeFile(path.join(project, 'game', 'scene', 'start.txt'), '旁白:你好。;\n', 'utf8');
  await writeFile(path.join(project, 'game', 'config.txt'), 'Game_name:DSH Demo;\nGame_key:dsh-demo;\n', 'utf8');

  const sceneRoot = path.join(project, 'game', 'scene');
  terreServer = createServer((request, response) => {
    const pathname = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
    if (pathname === '/api/test') {
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
          '/api/manageGame/readGameAssets/{readDirPath}': { get: {} },
        },
      }));
      return;
    }
    if (pathname === '/api/manageGame/readGameAssets/demo-game/game/scene') {
      response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify({
        readDirPath: 'demo-game/game/scene',
        dirPath: sceneRoot,
        dirInfo: [],
      }));
      return;
    }
    response.writeHead(404).end();
  });
  terreServer.listen(0, '127.0.0.1');
  await once(terreServer, 'listening');
  const address = terreServer.address();
  if (!address || typeof address === 'string') {
    throw new Error('Missing Terre stub port.');
  }
  terreUrl = `http://127.0.0.1:${address.port}`;

  configPath = path.join(temporary, 'webgal-mcp.local.json');
  await writeFile(configPath, JSON.stringify({
    version: 1,
    projects: [{ id: 'demo', root: project, terreUrl, terreGameDir: 'demo-game' }],
    sources: [{ id: 'assets', root: sourceRoot }],
  }), 'utf8');
});

afterAll(async () => {
  if (terreServer?.listening) {
    terreServer.closeAllConnections();
    await new Promise<void>(resolve => terreServer.close(() => resolve()));
  }
  if (temporary) {
    await rm(temporary, { recursive: true, force: true });
  }
});

describe('DeepSeek Harness (dsh) compatibility', () => {
  it('returns concise, mode-specific MCP instructions within dsh limits and without private paths', async () => {
    const stateRoot = path.join(temporary, 'state-instructions');
    const readOnly = await connectStdio({ args: [cli, '--config', configPath] });
    const writeMode = await connectStdio({ args: [cli, '--config', configPath, '--state-root', stateRoot] });
    try {
      const roInstructions = readOnly.client.getInstructions();
      const rwInstructions = writeMode.client.getInstructions();

      expect(roInstructions).toBe(serverInstructions(false));
      expect(rwInstructions).toBe(serverInstructions(true));
      expect(roInstructions).toBeTruthy();
      expect(rwInstructions).toBeTruthy();

      for (const text of [roInstructions!, rwInstructions!]) {
        const bytes = Buffer.byteLength(text, 'utf8');
        expect(bytes).toBeGreaterThan(0);
        expect(bytes).toBeLessThanOrEqual(TARGET_MAX_INSTRUCTION_BYTES);
        expect(bytes).toBeLessThan(DSH_MAX_INSTRUCTION_BYTES);
        expect(text).not.toContain(temporary);
        expect(text).not.toContain(project);
        expect(text).not.toContain(stateRoot);
        expect(text).not.toContain(configPath);
        expect(text).toContain('webgal_status');
      }

      expect(roInstructions).toContain('--state-root');
      expect(roInstructions).not.toContain('change_apply');

      expect(rwInstructions).toContain('change_plan');
      expect(rwInstructions).toContain('live2d_import_plan');
      expect(rwInstructions).toContain('write_session_begin');
      expect(rwInstructions).toContain('change_apply');
      expect(rwInstructions).toContain('write_session_end');
      expect(rwInstructions).toContain('planId');
      expect(rwInstructions).toContain('recovery_inspect');

      expect(readOnly.stderr()).toBe('');
      expect(writeMode.stderr()).toBe('');
    } finally {
      await readOnly.client.close();
      await writeMode.client.close();
    }
    expect(await pathExists(stateRoot)).toBe(false);
  });

  it('handles dsh-style stdio probe -> close without touching state-root, then serves normally', async () => {
    const stateRoot = path.join(temporary, 'state-probe-then-serve');

    // Stage 1: temporary probe (initialize + listTools + immediate close)
    const probe = await connectStdio({ args: [cli, '--config', configPath, '--state-root', stateRoot] });
    const probeTools = (await probe.client.listTools()).tools;
    await probe.client.close();

    expect(probeTools).toHaveLength(21);
    expect(probe.stderr()).toBe('');
    expect(await pathExists(stateRoot)).toBe(false);

    // Stage 2: serving connection executes read + full handoff write flow
    const serve = await connectStdio({ args: [cli, '--config', configPath, '--state-root', stateRoot] });
    try {
      const status = await callTool(serve.client, 'webgal_status', { projectId: 'demo' });
      expect(status.response.isError).not.toBe(true);
      expect(status.data).toMatchObject({
        writeToolsEnabled: true,
        handoffRequired: true,
        projectFiles: { readable: true },
        terre: { connectionStatus: 'responded', mappingStatus: 'verified' },
      });

      const scene = await callTool(serve.client, 'scene_read', { projectId: 'demo', path: 'start.txt' });
      expect(scene.response.isError).not.toBe(true);

      const session = await callTool(serve.client, 'write_session_begin', {
        projectId: 'demo',
        paths: ['game/scene/start.txt'],
        decision: 'saved-and-editors-closed',
        statement: '我已在 Terre 保存并关闭了全部编辑页，可以修改 start.txt。',
      });
      expect(session.response.isError).not.toBe(true);
      const sessionId = session.data.sessionId as string;

      const targetOffset = (scene.data.text as string).indexOf('你好。');
      const plan = await callTool(serve.client, 'change_plan', {
        projectId: 'demo',
        sessionId,
        operations: [{
          type: 'edit_scene',
          path: 'start.txt',
          expectedRevision: scene.data.revision,
          edits: [{ start: targetOffset, end: targetOffset + '你好。'.length, text: '你好，DSH。' }],
        }],
      });
      expect(plan.response.isError).not.toBe(true);
      expect(plan.data.committable).toBe(true);

      const applied = await callTool(serve.client, 'change_apply', {
        sessionId,
        planId: plan.data.planId,
        idempotencyKey: 'dsh-probe-serve-1',
      });
      expect(applied.response.isError).not.toBe(true);
      expect(applied.data.status).toBe('complete');

      const ended = await callTool(serve.client, 'write_session_end', { sessionId });
      expect(ended.response.isError).not.toBe(true);
      expect(ended.data.state).toBe('closed');
      expect(serve.stderr()).toBe('');

      const diskText = await readFile(path.join(project, 'game', 'scene', 'start.txt'), 'utf8');
      expect(diskText).toContain('你好，DSH。');
    } finally {
      await serve.client.close();
    }
  });

  it('exits cleanly on stdin EOF (and SIGTERM on POSIX) with empty stderr and no state-root creation', async () => {
    const stateRoot = path.join(temporary, 'state-exit-signal');
    const modes: Array<'eof' | 'sigterm'> = process.platform === 'win32' ? ['eof'] : ['eof', 'sigterm'];

    for (const mode of modes) {
      const outcome = await new Promise<{ code: number | null; signal: NodeJS.Signals | null; stderr: string; timedOut: boolean }>((resolve, reject) => {
        const child = spawn(process.execPath, [cli, '--config', configPath, '--state-root', stateRoot], {
          stdio: ['pipe', 'pipe', 'pipe'],
          windowsHide: true,
        });
        let stderr = '';
        child.stderr.on('data', chunk => { stderr += chunk.toString(); });
        child.once('error', reject);
        const timer = setTimeout(() => {
          child.kill('SIGKILL');
          resolve({ code: null, signal: 'SIGKILL', stderr, timedOut: true });
        }, 5_000);
        child.once('exit', (code, signal) => {
          clearTimeout(timer);
          resolve({ code, signal, stderr, timedOut: false });
        });

        const initRequest = JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {
            protocolVersion: '2025-03-26',
            capabilities: {},
            clientInfo: { name: 'dsh-exit-probe', version: '1.0.0' },
          },
        }) + '\n';
        child.stdin.write(initRequest);
        child.stdout.once('data', () => {
          if (mode === 'eof') child.stdin.end();
          else child.kill('SIGTERM');
        });
      });

      expect(outcome.timedOut, `mode=${mode} timed out`).toBe(false);
      expect(outcome.code, `mode=${mode} exit code`).toBe(0);
      expect(outcome.signal, `mode=${mode} exit signal`).toBeNull();
      expect(outcome.stderr, `mode=${mode} stderr`).toBe('');
    }

    expect(await pathExists(stateRoot)).toBe(false);
  });

  it('passes static JSON Schema, naming, and annotation audits across all 21 tools for dsh + DeepSeek', async () => {
    const stateRoot = path.join(temporary, 'state-schema-audit');
    const conn = await connectStdio({ args: [cli, '--config', configPath, '--state-root', stateRoot] });
    try {
      const tools = (await conn.client.listTools()).tools;
      expect(tools).toHaveLength(21);

      const expectedAll = [
        ...READ_ONLY_TOOLS,
        ...WRITE_READ_ONLY_TOOLS,
        ...DESTRUCTIVE_WRITE_TOOLS,
        ...NON_DESTRUCTIVE_WRITE_TOOLS,
      ];
      expect(tools.map(t => t.name).sort()).toEqual([...expectedAll].sort());

      const seenNames = new Set<string>();
      for (const tool of tools) {
        expect(seenNames.has(tool.name)).toBe(false);
        seenNames.add(tool.name);

        // dsh public naming contract: mcp__<serverName>__<rawName> without lossy normalization
        expect(tool.name).toMatch(/^[a-z0-9_]+$/);
        expect(tool.name).not.toBe('load_tools');
        expect(`mcp__webgal__${tool.name}`.length).toBeLessThanOrEqual(64);

        // DeepSeek API requires root type: 'object'
        expect(tool.inputSchema).toMatchObject({
          type: 'object',
          additionalProperties: false,
        });
        expect(Buffer.byteLength(JSON.stringify(tool.inputSchema), 'utf8')).toBeLessThan(8_192);
        auditJsonSchemaNode(tool.name, tool.inputSchema);

        // Annotation accuracy
        if ((READ_ONLY_TOOLS as readonly string[]).includes(tool.name)
          || (WRITE_READ_ONLY_TOOLS as readonly string[]).includes(tool.name)) {
          expect(tool.annotations, `${tool.name} annotations`).toMatchObject({
            readOnlyHint: true,
            destructiveHint: false,
          });
        } else if ((DESTRUCTIVE_WRITE_TOOLS as readonly string[]).includes(tool.name)) {
          expect(tool.annotations, `${tool.name} annotations`).toMatchObject({
            readOnlyHint: false,
            destructiveHint: true,
          });
        } else {
          expect(tool.annotations, `${tool.name} annotations`).toMatchObject({
            readOnlyHint: false,
            destructiveHint: false,
          });
        }
      }
      expect(conn.stderr()).toBe('');
    } finally {
      await conn.client.close();
    }
    expect(await pathExists(stateRoot)).toBe(false);
  });

  it('keeps content text JSON and structuredContent consistent across normal, business-error, and schema-error responses', async () => {
    const conn = await connectStdio({ args: [cli, '--config', configPath] });
    try {
      // Normal response
      const ok = await callTool(conn.client, 'webgal_status', { projectId: 'demo' });
      expect(ok.response.isError).not.toBe(true);
      expect(ok.content[0]?.type).toBe('text');
      expect(ok.content[0]?.text?.length).toBeGreaterThan(2);
      expect(ok.response.structuredContent).toEqual({ data: ok.data });

      // Application/business error
      const appErr = await callTool(conn.client, 'scene_read', { projectId: 'missing-project', path: 'start.txt' });
      expect(appErr.response.isError).toBe(true);
      expect(appErr.content[0]?.type).toBe('text');
      expect(appErr.data).toMatchObject({ error: { code: 'PROJECT_NOT_AUTHORIZED' } });
      expect(appErr.response.structuredContent).toEqual(appErr.data);

      // Parameter schema validation error (must produce non-empty model-visible text content)
      const schemaErr = await callTool(conn.client, 'scene_read', { projectId: 'demo', path: 'start.txt', unexpectedKey: true });
      expect(schemaErr.response.isError).toBe(true);
      expect(schemaErr.content[0]?.type).toBe('text');
      expect(schemaErr.content[0]?.text?.trim().length).toBeGreaterThan(0);

      expect(conn.stderr()).toBe('');
    } finally {
      await conn.client.close();
    }
  });

  it('operates cleanly under a scrubbed environment and unrelated cwd with absolute config and state-root', async () => {
    const stateRoot = path.join(temporary, 'state-scrubbed');
    const conn = await connectStdio({
      args: [cli, '--config', configPath, '--state-root', stateRoot],
      env: minimalScrubbedEnv(),
      cwd: otherCwd,
    });
    try {
      const status = await callTool(conn.client, 'webgal_status', { projectId: 'demo' });
      expect(status.response.isError).not.toBe(true);
      expect(status.data).toMatchObject({
        projectFiles: { readable: true },
        writeToolsEnabled: true,
      });

      const scan = await callTool(conn.client, 'project_scan', { projectId: 'demo' });
      expect(scan.response.isError).not.toBe(true);
      expect(scan.data.complete).toBe(true);

      const draft = await callTool(conn.client, 'change_plan', {
        projectId: 'demo',
        operations: [{ type: 'create_scene', path: 'dsh-draft.txt', text: '旁白:草案。;\n' }],
      });
      expect(draft.response.isError).not.toBe(true);
      expect(draft.data.committable).toBe(false);
      expect(conn.stderr()).toBe('');
    } finally {
      await conn.client.close();
    }
  });

  it('fills safe platform defaults in directoryPublisherEnv when MCP client scrubs environment variables', () => {
    const fromEmpty = directoryPublisherEnv({}, 'C:\\stage', 'C:\\target', 'win32');
    expect(fromEmpty.ProgramFiles).toBe('C:\\Program Files');
    expect(fromEmpty.SystemRoot).toBe('C:\\Windows');
    expect(fromEmpty.WGMCP_DIRECTORY_STAGE).toBe('C:\\stage');
    expect(fromEmpty.WGMCP_DIRECTORY_TARGET).toBe('C:\\target');

    const fromUppercase = directoryPublisherEnv(
      { PROGRAMFILES: 'D:\\Programs', SYSTEMROOT: 'D:\\Windows' },
      'C:\\stage',
      'C:\\target',
      'win32',
    );
    expect(fromUppercase.PROGRAMFILES).toBe('D:\\Programs');
    expect(fromUppercase.SYSTEMROOT).toBe('D:\\Windows');
    expect(fromUppercase).not.toHaveProperty('ProgramFiles');
    expect(fromUppercase).not.toHaveProperty('SystemRoot');

    const fromFallbacks = directoryPublisherEnv(
      { ProgramFiles: '  ', ProgramW6432: 'E:\\Program Files', WINDIR: 'E:\\Windows' },
      'C:\\stage',
      'C:\\target',
      'win32',
    );
    expect(fromFallbacks.ProgramFiles).toBe('E:\\Program Files');
    expect(fromFallbacks.SystemRoot).toBe('E:\\Windows');

    const linuxEmpty = directoryPublisherEnv({}, '/tmp/stage', '/tmp/target', 'linux');
    expect(linuxEmpty.PATH).toBe('/usr/local/bin:/usr/bin:/bin');
    expect(linuxEmpty.WGMCP_DIRECTORY_STAGE).toBe('/tmp/stage');
    expect(linuxEmpty.WGMCP_DIRECTORY_TARGET).toBe('/tmp/target');
    expect(linuxEmpty).not.toHaveProperty('ProgramFiles');
    expect(linuxEmpty).not.toHaveProperty('SystemRoot');

    const linuxCustom = directoryPublisherEnv(
      { PATH: '/opt/python/bin:/usr/bin' },
      '/tmp/stage',
      '/tmp/target',
      'linux',
    );
    expect(linuxCustom.PATH).toBe('/opt/python/bin:/usr/bin');
  });

  it('revokes write sessions on client reconnect/reload while preserving planId lookup via recovery_inspect', async () => {
    const stateRoot = path.join(temporary, 'state-reconnect');

    // Client A opens a handoff session, applies a scene creation, and disconnects without calling write_session_end
    const clientA = await connectStdio({ args: [cli, '--config', configPath, '--state-root', stateRoot] });
    let oldSessionId: string;
    let appliedPlanId: string;
    let appliedBatchId: string;
    try {
      const begin = await callTool(clientA.client, 'write_session_begin', {
        projectId: 'demo',
        paths: ['game/scene/reconnect-check.txt', 'game/scene/reconnect-second.txt'],
        decision: 'saved-and-editors-closed',
        statement: '我已保存并关闭全部编辑页，允许新建这两个测试场景。',
      });
      expect(begin.response.isError).not.toBe(true);
      oldSessionId = begin.data.sessionId;

      const plan = await callTool(clientA.client, 'change_plan', {
        projectId: 'demo',
        sessionId: oldSessionId,
        operations: [{ type: 'create_scene', path: 'reconnect-check.txt', text: '旁白:重连验证。;\n' }],
      });
      expect(plan.response.isError).not.toBe(true);
      appliedPlanId = plan.data.planId;

      const apply = await callTool(clientA.client, 'change_apply', {
        sessionId: oldSessionId,
        planId: appliedPlanId,
        idempotencyKey: 'dsh-reconnect-1',
      });
      expect(apply.response.isError).not.toBe(true);
      expect(apply.data.status).toBe('complete');
      appliedBatchId = apply.data.batchId;
    } finally {
      await clientA.client.close();
    }

    // Client B reconnects (simulating dsh restart / HMR reload) against the same state-root
    const clientB = await connectStdio({ args: [cli, '--config', configPath, '--state-root', stateRoot] });
    try {
      const stalePlan = await callTool(clientB.client, 'change_plan', {
        projectId: 'demo',
        sessionId: oldSessionId,
        operations: [{ type: 'create_scene', path: 'reconnect-second.txt', text: '旁白:不应通过。;\n' }],
      });
      expect(stalePlan.response.isError).toBe(true);
      expect(['HANDOFF_REQUIRED', 'SESSION_MISMATCH']).toContain(stalePlan.data.error.code);

      const staleEnd = await callTool(clientB.client, 'write_session_end', { sessionId: oldSessionId });
      expect(staleEnd.response.isError).toBe(true);
      expect(['HANDOFF_REQUIRED', 'SESSION_MISMATCH']).toContain(staleEnd.data.error.code);

      // recovery_inspect still locates the completed batch by planId without any write session
      const recovery = await callTool(clientB.client, 'recovery_inspect', {
        projectId: 'demo',
        planId: appliedPlanId,
      });
      expect(recovery.response.isError).not.toBe(true);
      expect(recovery.data.batches).toHaveLength(1);
      expect(recovery.data.batches[0]).toMatchObject({
        batchId: appliedBatchId,
        status: 'complete',
        operations: [expect.objectContaining({
          path: 'game/scene/reconnect-check.txt',
          phase: 'applied',
          diskState: 'planned',
        })],
      });
      expect(clientB.stderr()).toBe('');
    } finally {
      await clientB.client.close();
    }
  });
});
