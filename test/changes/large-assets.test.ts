import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  truncate,
  writeFile
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  describeAssetSource,
  inspectSource
} from '../../src/assets/source.js';
import {
  BusinessWriteService,
  type BusinessAssetKind,
  type BusinessOperation
} from '../../src/changes/business.js';
import {
  WriteCoordinator,
  type CoordinatorOptions
} from '../../src/changes/coordinator.js';
import { ProjectLocks } from '../../src/changes/locks.js';
import {
  LARGE_ASSET_LIMITS,
  WRITE_LIMITS,
  type Attestation,
  type BatchRecord,
  type FaultPoint,
  type WritePlan
} from '../../src/changes/types.js';
import { AppError } from '../../src/errors.js';
import type { AppConfig } from '../../src/types.js';

const fixturePath = path.join(
  process.cwd(),
  'test',
  'changes',
  'fixtures',
  'large-assets-child.mjs'
);
const ownerId = 'large-asset-owner';
const projectId = 'large-asset-project';
const sourceId = 'large-asset-source';
const backgroundTarget = 'game/background/背景 大图.bin';
const bgmTarget = 'game/bgm/主题 音乐.bin';
const backgroundSource = 'images/背景 大图.bin';
const bgmSource = 'audio/主题 音乐.bin';
const attestation: Attestation = {
  source: 'user-message',
  statement: 'I saved and closed all editor pages for this temporary project.'
};

interface ChildInput {
  project: AppConfig['projects'][number];
  sources: AppConfig['sources'];
  stateRoot: string;
  lockRoot: string;
  ownerId: string;
  attestation: Attestation;
  kind: 'background' | 'bgm';
  target: string;
  sourceId: string;
  sourcePath: string;
  expectedSourceRevision: string;
  faultPoint: 'after-stream-chunk' | 'after-write';
  exitCode: number;
  idempotencyKey: string;
}

interface ChildResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

function hash(bytes: Uint8Array | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function targetPath(root: string, relative: string): string {
  return path.join(root, ...relative.split('/'));
}

async function pathExists(absolutePath: string): Promise<boolean> {
  try {
    await access(absolutePath);
    return true;
  } catch {
    return false;
  }
}

async function expectAppError(
  operation: Promise<unknown>,
  code: string
): Promise<AppError> {
  try {
    await operation;
    throw new Error(`Expected AppError ${code}`);
  } catch (error) {
    expect(error).toBeInstanceOf(AppError);
    const appError = error as AppError;
    expect(appError.code).toBe(code);
    return appError;
  }
}

function isStreamChunkFault(point: FaultPoint, index?: number): boolean {
  return String(point) === 'after-stream-chunk'
    && (index === undefined || index === 0);
}

function runChild(inputPath: string, timeoutMs = 20000): Promise<ChildResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [fixturePath, inputPath], {
      cwd: process.cwd(),
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`Large-asset child timed out: ${stderr}`));
    }, timeoutMs);

    child.stdout.on('data', (chunk: Buffer | string) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk: Buffer | string) => {
      stderr += chunk.toString();
    });
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr });
    });
  });
}

describe('v2 large asset imports', () => {
  let baseDirectory: string;
  let projectRoot: string;
  let sourceRoot: string;
  let stateRoot: string;
  let lockRoot: string;
  let config: AppConfig;

  beforeEach(async () => {
    baseDirectory = await realpath(
      await mkdtemp(path.join(tmpdir(), 'webgal-mcp-large-assets-'))
    );
    projectRoot = path.join(baseDirectory, '工程 大素材');
    sourceRoot = path.join(baseDirectory, '素材 来源');
    stateRoot = path.join(baseDirectory, 'state');
    lockRoot = path.join(baseDirectory, 'locks');

    await mkdir(path.join(projectRoot, 'game', 'scene'), { recursive: true });
    await mkdir(path.join(projectRoot, 'game', 'background'), { recursive: true });
    await mkdir(path.join(projectRoot, 'game', 'bgm'), { recursive: true });
    await mkdir(path.join(projectRoot, 'game', 'figure'), { recursive: true });
    await mkdir(path.join(sourceRoot, 'images'), { recursive: true });
    await mkdir(path.join(sourceRoot, 'audio'), { recursive: true });
    await writeFile(
      path.join(projectRoot, 'game', 'config.txt'),
      'Game_name:Large assets;\r\n',
      'utf8'
    );
    await writeFile(
      path.join(projectRoot, 'game', 'scene', 'start.txt'),
      '这是临时测试场景。\r\n',
      'utf8'
    );

    config = {
      version: 1,
      projects: [{ id: projectId, root: projectRoot }],
      sources: [{ id: sourceId, root: sourceRoot }]
    };
  });

  afterEach(async () => {
    await rm(baseDirectory, {
      recursive: true,
      force: true,
      maxRetries: 3
    });
  });

  async function createService(options: CoordinatorOptions = {}) {
    const coordinator = await WriteCoordinator.create(config, stateRoot, {
      locks: new ProjectLocks(lockRoot),
      capabilityCheck: async () => true,
      ...options
    });
    const service = new BusinessWriteService(config, coordinator, ownerId);
    return { coordinator, service };
  }

  function beginSession(
    coordinator: WriteCoordinator,
    paths: string[]
  ) {
    return coordinator.sessions.begin(
      ownerId,
      projectId,
      attestation,
      paths
    );
  }

  async function writeLargeSource(
    relative: string,
    fill: number,
    size = WRITE_LIMITS.maxFileBytes + 4096
  ): Promise<Buffer> {
    expect(size).toBeGreaterThan(WRITE_LIMITS.maxFileBytes);
    expect(size).toBeLessThanOrEqual(LARGE_ASSET_LIMITS.maxFileBytes);
    const bytes = Buffer.alloc(size, fill);
    await writeFile(targetPath(sourceRoot, relative), bytes);
    return bytes;
  }

  async function importOperation(
    kind: BusinessAssetKind,
    target: string,
    sourcePath: string
  ): Promise<Extract<BusinessOperation, { type: 'import_asset' }>> {
    const description = await describeAssetSource(config, sourceId, sourcePath);
    const inspected = await inspectSource(config, sourceId, sourcePath);
    expect(inspected).toEqual({
      sourceId,
      path: sourcePath,
      revision: description.revision,
      bytes: description.bytes
    });
    return {
      type: 'import_asset',
      kind,
      path: path.posix.relative(`game/${kind}`, target),
      sourceId,
      sourcePath,
      expectedSourceRevision: description.revision
    };
  }

  async function runInterruptedChild(
    input: Omit<ChildInput, 'project' | 'sources' | 'stateRoot' | 'lockRoot' | 'ownerId' | 'attestation'>
  ): Promise<ChildResult> {
    const inputPath = path.join(
      baseDirectory,
      `large-asset-child-${randomUUID()}.json`
    );
    await writeFile(inputPath, JSON.stringify({
      project: config.projects[0],
      sources: config.sources,
      stateRoot,
      lockRoot,
      ownerId,
      attestation,
      ...input
    }), 'utf8');
    return runChild(inputPath);
  }

  it('returns a non-persisted draft without a handoff session', async () => {
    const bytes = await writeLargeSource(backgroundSource, 0x31);
    const operation = await importOperation(
      'background',
      backgroundTarget,
      backgroundSource
    );
    const { service } = await createService();

    const review = await service.plan(projectId, undefined, [operation]);

    expect(review).toMatchObject({
      committable: false,
      planId: null,
      projectId,
      sessionId: null
    });
    expect(review.operations[0]).toMatchObject({
      type: 'import_asset',
      path: backgroundTarget,
      beforeRevision: null,
      afterRevision: hash(bytes),
      bytes: bytes.byteLength,
      kind: 'background',
      sourceId,
      sourcePath: backgroundSource,
      sourceRevision: hash(bytes)
    });
    expect(await pathExists(targetPath(projectRoot, backgroundTarget))).toBe(false);
    expect(await pathExists(path.join(stateRoot, 'plans'))).toBe(false);
  });

  it('streams two real assets through v2 JSON and replays after sources are removed', async () => {
    const backgroundBytes = await writeLargeSource(backgroundSource, 0x41);
    const bgmBytes = await writeLargeSource(bgmSource, 0x52);
    const operations = [
      await importOperation('background', backgroundTarget, backgroundSource),
      await importOperation('bgm', bgmTarget, bgmSource)
    ];
    const { coordinator, service } = await createService();
    const session = beginSession(coordinator, [backgroundTarget, bgmTarget]);

    const review = await service.plan(projectId, session.id, operations);
    expect(review.committable).toBe(true);
    expect(review.planId).toEqual(expect.any(String));
    expect(review.operations.map((operation) => ({
      path: operation.path,
      afterRevision: operation.afterRevision,
      bytes: operation.bytes
    }))).toEqual([
      {
        path: backgroundTarget,
        afterRevision: hash(backgroundBytes),
        bytes: backgroundBytes.byteLength
      },
      {
        path: bgmTarget,
        afterRevision: hash(bgmBytes),
        bytes: bgmBytes.byteLength
      }
    ]);

    const planId = review.planId as string;
    const planFile = path.join(stateRoot, 'plans', `${planId}.json`);
    const rawPlan = await readFile(planFile, 'utf8');
    expect(rawPlan).not.toMatch(/base64/i);
    expect(rawPlan).not.toContain('"data"');
    expect(rawPlan).not.toContain('Buffer');
    const storedPlan = JSON.parse(rawPlan) as WritePlan;
    expect(storedPlan.version).toBe(2);
    expect(storedPlan.operations).toHaveLength(2);
    for (const operation of storedPlan.operations) {
      expect(operation).not.toHaveProperty('data');
      expect(operation.source).toMatchObject({
        sourceId,
        rootKey: expect.stringMatching(/^[a-f0-9]{64}$/),
        revision: expect.stringMatching(/^[a-f0-9]{64}$/),
        bytes: expect.any(Number)
      });
    }

    const applied = await service.apply(
      session.id,
      planId,
      'two-large-assets'
    );
    expect(applied).toMatchObject({
      status: 'complete',
      replayed: false
    });
    expect(await readFile(targetPath(projectRoot, backgroundTarget)))
      .toEqual(backgroundBytes);
    expect(await readFile(targetPath(projectRoot, bgmTarget))).toEqual(bgmBytes);
    expect(hash(await readFile(targetPath(projectRoot, backgroundTarget))))
      .toBe(hash(backgroundBytes));
    expect(hash(await readFile(targetPath(projectRoot, bgmTarget))))
      .toBe(hash(bgmBytes));

    const inspected = await coordinator.inspect(projectId, applied.batchId);
    expect(inspected.status).toBe('complete');
    for (const operation of inspected.operations) {
      expect(operation).toMatchObject({
        phase: 'applied',
        diskState: 'planned',
        stagingPresent: false,
        stagingBytes: null,
        stagingVerified: null,
        limitation: 'Created files are never automatically deleted.'
      });
    }

    coordinator.sessions.end(session.id, ownerId);
    await rm(targetPath(sourceRoot, backgroundSource));
    await rm(targetPath(sourceRoot, bgmSource));
    const replaySession = beginSession(coordinator, [backgroundTarget, bgmTarget]);
    const replayed = await service.apply(
      replaySession.id,
      planId,
      'two-large-assets'
    );
    expect(replayed).toMatchObject({
      batchId: applied.batchId,
      status: 'complete',
      replayed: true
    });
    expect(await readFile(targetPath(projectRoot, backgroundTarget)))
      .toEqual(backgroundBytes);
    expect(await readFile(targetPath(projectRoot, bgmTarget))).toEqual(bgmBytes);
  });

  it('publishes and verifies a 100 MiB video in a 128 MiB batch with a figure and voice', async () => {
    const mib = 1024 * 1024;
    const { coordinator, service } = await createService();
    const assets = [
      { kind: 'video', file: 'intro.mp4', size: 100 * mib },
      { kind: 'figure', file: 'hero.png', size: 25 * mib },
      { kind: 'vocal', file: 'voice.ogg', size: 3 * mib }
    ] as const;
    const operations: Extract<BusinessOperation, { type: 'import_asset' }>[] = [];
    const paths = assets.map(({ kind, file }) => `game/${kind}/${file}`);
    for (const { kind, file, size } of assets) {
      await mkdir(path.join(projectRoot, 'game', kind), { recursive: true });
      const source = targetPath(sourceRoot, file);
      await writeFile(source, file);
      if (kind === 'video') {
        await truncate(source, size + 1);
        await expectAppError(inspectSource(config, sourceId, file), 'FILE_TOO_LARGE');
      }
      await truncate(source, size);
      const { revision } = await inspectSource(config, sourceId, file);
      operations.push({ type: 'import_asset', kind, path: file, sourcePath: file, sourceId, expectedSourceRevision: revision });
    }

    const voice = targetPath(sourceRoot, 'voice.ogg');
    await truncate(voice, 3 * mib + 1);
    const biggerVoice = { ...operations[2]!, expectedSourceRevision: (await inspectSource(config, sourceId, 'voice.ogg')).revision };
    await expectAppError(service.plan(projectId, undefined, [...operations.slice(0, 2), biggerVoice]), 'LIMIT_EXCEEDED');
    await truncate(voice, 3 * mib);

    const session = beginSession(coordinator, paths);
    const plan = await service.plan(projectId, session.id, operations);
    const applied = await service.apply(session.id, plan.planId!, 'binary-size-boundaries');
    expect(applied.status).toBe('complete');
    const inspected = await coordinator.inspect(projectId, applied.batchId);
    for (const [index, target] of paths.entries()) {
      expect((await stat(targetPath(projectRoot, target))).size).toBe(assets[index]!.size);
      expect(inspected.operations).toContainEqual(expect.objectContaining({
        path: target, currentRevision: operations[index]!.expectedSourceRevision, diskState: 'planned'
      }));
    }
  }, 60_000);

  it('rejects target reuse and bypass attempts before any large target is written', async () => {
    const bytes = await writeLargeSource(backgroundSource, 0x63);
    const operation = await importOperation(
      'background',
      backgroundTarget,
      backgroundSource
    );
    const { coordinator, service } = await createService();

    await expectAppError(
      service.plan(projectId, undefined, [operation, operation]),
      'TARGET_COLLISION'
    );

    const existingBytes = Buffer.from('existing target');
    await writeFile(targetPath(projectRoot, backgroundTarget), existingBytes);
    const targetSession = beginSession(coordinator, [backgroundTarget]);
    await expectAppError(
      service.plan(projectId, targetSession.id, [operation]),
      'TARGET_EXISTS'
    );
    expect(await readFile(targetPath(projectRoot, backgroundTarget)))
      .toEqual(existingBytes);

    const figureOperation = await importOperation(
      'figure',
      'game/figure/custom-model.JSON',
      backgroundSource
    );
    await expectAppError(
      service.plan(projectId, undefined, [figureOperation]),
      'FILE_TOO_LARGE'
    );

    const inlineTarget = 'game/background/inline 旁路.bin';
    const inlineSession = beginSession(coordinator, [inlineTarget]);
    await expectAppError(
      coordinator.plan(ownerId, inlineSession.id, projectId, [{
        path: inlineTarget,
        expectedRevision: null,
        bytes: Buffer.alloc(WRITE_LIMITS.maxFileBytes + 1, 0x71)
      }]),
      'INVALID_ARGUMENT'
    );

    const description = await describeAssetSource(
      config,
      sourceId,
      backgroundSource
    );
    const streamedFigureTarget = 'game/figure/hero.model3.json';
    const streamedSession = beginSession(coordinator, [streamedFigureTarget]);
    await expectAppError(
      coordinator.plan(ownerId, streamedSession.id, projectId, [{
        path: streamedFigureTarget,
        expectedRevision: null,
        source: {
          sourceId,
          path: backgroundSource,
          revision: description.revision,
          rootKey: description.rootKey,
          bytes: description.bytes
        }
      }]),
      'STATE_CORRUPT'
    );

    expect(await readFile(targetPath(projectRoot, backgroundTarget)))
      .toEqual(existingBytes);
    expect(await pathExists(targetPath(projectRoot, 'game/figure/custom-model.JSON')))
      .toBe(false);
    expect(await pathExists(targetPath(projectRoot, inlineTarget))).toBe(false);
    expect(await pathExists(targetPath(projectRoot, streamedFigureTarget)))
      .toBe(false);
    expect((await coordinator.pending(projectId)).batches).toEqual([]);
    expect(hash(bytes)).not.toBe(hash(existingBytes));
  });

  it('rejects a source rewrite after planning with zero target writes', async () => {
    const originalBytes = await writeLargeSource(backgroundSource, 0x74);
    const operation = await importOperation(
      'background',
      backgroundTarget,
      backgroundSource
    );
    const { coordinator, service } = await createService();
    const session = beginSession(coordinator, [backgroundTarget]);
    const review = await service.plan(projectId, session.id, [operation]);

    await writeFile(
      targetPath(sourceRoot, backgroundSource),
      Buffer.alloc(originalBytes.byteLength, 0x75)
    );
    await expectAppError(
      service.apply(session.id, review.planId as string, 'rewritten-source'),
      'SOURCE_CHANGED'
    );

    expect(await pathExists(targetPath(projectRoot, backgroundTarget))).toBe(false);
    expect((await coordinator.pending(projectId)).batches).toEqual([]);
  });

  it('maps an injected ENOSPC after a streamed chunk to STORAGE_FULL and cleans staging', async () => {
    const bytes = await writeLargeSource(backgroundSource, 0x86);
    const operation = await importOperation(
      'background',
      backgroundTarget,
      backgroundSource
    );
    const { coordinator, service } = await createService({
      fault: async (point, index) => {
        if (isStreamChunkFault(point, index)) {
          throw Object.assign(new Error('injected full disk'), {
            code: 'ENOSPC'
          });
        }
      }
    });
    const session = beginSession(coordinator, [backgroundTarget]);
    const review = await service.plan(projectId, session.id, [operation]);

    const result = await service.apply(
      session.id,
      review.planId as string,
      'injected-enospc'
    );
    expect(result).toMatchObject({
      status: 'failed',
      errorCode: 'STORAGE_FULL',
      replayed: false
    });
    expect(await pathExists(targetPath(projectRoot, backgroundTarget))).toBe(false);

    const inspected = await coordinator.inspect(projectId, result.batchId);
    expect(inspected).toMatchObject({
      status: 'failed',
      errorCode: 'STORAGE_FULL'
    });
    expect(inspected.operations[0]).toMatchObject({
      path: backgroundTarget,
      phase: 'pending',
      diskState: 'missing',
      sourceBytes: bytes.byteLength,
      stagingPresent: false,
      stagingBytes: null,
      stagingVerified: null
    });
    expect((await coordinator.pending(projectId)).unreadableRecords).toBe(0);
  });

  it('inspects real child state after interruption following the first streamed chunk', async () => {
    const bytes = await writeLargeSource(backgroundSource, 0x97);
    const operation = await importOperation(
      'background',
      backgroundTarget,
      backgroundSource
    );
    const { coordinator } = await createService();

    const child = await runInterruptedChild({
      kind: 'background',
      target: backgroundTarget,
      sourceId,
      sourcePath: backgroundSource,
      expectedSourceRevision: operation.expectedSourceRevision,
      faultPoint: 'after-stream-chunk',
      exitCode: 71,
      idempotencyKey: 'child-after-stream-chunk'
    });
    expect(child).toMatchObject({
      code: 71,
      signal: null
    });

    const pending = await coordinator.pending(projectId);
    expect(pending.unreadableRecords).toBe(0);
    expect(pending.batches).toHaveLength(1);
    const batch = pending.batches[0]!;
    expect(batch).toMatchObject({
      status: 'applying',
      snapshotOnly: true
    });
    expect(batch.operations[0]).toMatchObject({
      path: backgroundTarget,
      phase: 'intent',
      currentRevision: null,
      diskState: 'missing',
      sourceBytes: bytes.byteLength,
      stagingPresent: true,
      stagingBytes: LARGE_ASSET_LIMITS.chunkBytes,
      stagingVerified: false,
      canRestore: false,
      limitation: 'Created files are never automatically deleted.'
    });
    expect(await coordinator.inspect(projectId, batch.batchId)).toEqual(batch);

    const stagingPath = targetPath(
      projectRoot,
      `game/background/.wgmcp-${batch.batchId}-0.tmp`
    );
    expect((await stat(stagingPath)).size).toBe(LARGE_ASSET_LIMITS.chunkBytes);
    expect(await pathExists(targetPath(projectRoot, backgroundTarget))).toBe(false);
  });

  it('inspects a published target after after-write interruption and rejects the old session', async () => {
    const bytes = await writeLargeSource(bgmSource, 0xa8);
    const operation = await importOperation('bgm', bgmTarget, bgmSource);
    const { coordinator } = await createService();

    const child = await runInterruptedChild({
      kind: 'bgm',
      target: bgmTarget,
      sourceId,
      sourcePath: bgmSource,
      expectedSourceRevision: operation.expectedSourceRevision,
      faultPoint: 'after-write',
      exitCode: 72,
      idempotencyKey: 'child-after-write'
    });
    expect(child).toMatchObject({
      code: 72,
      signal: null
    });

    const pending = await coordinator.pending(projectId);
    expect(pending.unreadableRecords).toBe(0);
    expect(pending.batches).toHaveLength(1);
    const report = pending.batches[0]!;
    expect(report).toMatchObject({
      status: 'applying',
      snapshotOnly: true
    });
    expect(report.operations[0]).toMatchObject({
      path: bgmTarget,
      phase: 'intent',
      currentRevision: hash(bytes),
      diskState: 'planned',
      sourceBytes: bytes.byteLength,
      stagingPresent: false,
      stagingBytes: null,
      stagingVerified: null,
      canRestore: false,
      limitation: 'Created files are never automatically deleted.'
    });
    expect(await coordinator.inspect(projectId, report.batchId)).toEqual(report);
    expect(await readFile(targetPath(projectRoot, bgmTarget))).toEqual(bytes);

    const batchRecord = await coordinator.store.readJson<BatchRecord>(
      `batches/${report.batchId}/journal.json`
    );
    const plan = await coordinator.store.readJson<WritePlan>(
      `plans/${batchRecord.planId}.json`
    );
    await expectAppError(
      coordinator.apply(
        ownerId,
        plan.sessionId,
        plan.id,
        'child-after-write'
      ),
      'HANDOFF_REQUIRED'
    );
    expect(await coordinator.store.listBatchIds()).toEqual([report.batchId]);
    expect(await readFile(targetPath(projectRoot, bgmTarget))).toEqual(bytes);
  });
});
