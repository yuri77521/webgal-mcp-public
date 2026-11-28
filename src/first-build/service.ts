import { createHash, randomUUID } from 'node:crypto';
import { cp, mkdir, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { BusinessWriteService, targetPath, type BusinessApplyResult, type BusinessAssetKind, type BusinessOperation } from '../changes/business.js';
import { WriteCoordinator, type CoordinatorOptions } from '../changes/coordinator.js';
import { assertWritePath } from '../changes/targets.js';
import { WRITE_LIMITS } from '../changes/types.js';
import { AppError, publicError } from '../errors.js';
import { validateRelativePath } from '../filesystem.js';
import { ReadService } from '../service.js';
import type { AppConfig, FirstBuildConfig } from '../types.js';
import { openPreview, type LocalPreview } from './preview.js';
import { inspectArchivedBuild } from './archive.js';
import { captureTree, sameContents, treeDifference, within, type Tree } from './tree.js';

export interface FirstBuildAsset {
  kind: BusinessAssetKind;
  path: string;
  sourceId: string;
  sourcePath: string;
  expectedSourceRevision: string;
}

export interface FirstBuildScope {
  storyRevision: string;
  scenes: string[];
  assets: FirstBuildAsset[];
  configKeys: string[];
}

interface Receipt {
  digest: string;
  planId: string;
  outcome?: BusinessApplyResult;
}

interface BuildPreview extends LocalPreview {
  snapshotId: string;
  snapshotPath: string;
  snapshotTree: Tree;
  projectTree: Tree;
}

interface Build {
  id: string;
  directory: string;
  project: string;
  scope: FirstBuildScope;
  statement: string;
  expiresAt: number;
  state: 'active' | 'paused' | 'delivered' | 'cancelled';
  reason?: string;
  busy: boolean;
  baseline: Tree;
  requiredTargets: Map<string, string | null>;
  receipts: Map<string, Receipt>;
  coordinator: WriteCoordinator;
  writer: BusinessWriteService;
  reader: ReadService;
  preview?: BuildPreview;
}

const ttlMs = 4 * 60 * 60 * 1000;

function confirmation(message: string): never {
  throw new AppError('FIRST_BUILD_CONFIRMATION_REQUIRED', message + ' 已暂停自动写入。请向用户说明情况并等待新的明确决定。');
}

function signature(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function importOperation(asset: FirstBuildAsset): BusinessOperation {
  return { type: 'import_asset', ...asset };
}

function approvedAsset(expected: FirstBuildAsset | undefined, operation: FirstBuildAsset): boolean {
  return expected?.sourceId === operation.sourceId && expected.sourcePath === operation.sourcePath &&
    expected.expectedSourceRevision === operation.expectedSourceRevision && expected.kind === operation.kind;
}

/** A run has its own config and coordinator. It is never registered in the regular project list. */
export class FirstBuildService {
  private readonly owner = randomUUID();
  private readonly runs = new Map<string, Build>();
  private closed = false;

  constructor(
    private readonly config: AppConfig,
    private readonly location: FirstBuildConfig,
    private readonly normalStateRoot: string,
    private readonly coordinatorOptions?: CoordinatorOptions,
  ) {}

  private pause(run: Build, reason: string): never {
    run.state = 'paused';
    run.reason = reason;
    confirmation(reason);
  }

  private find(runId: string): Build {
    const run = this.runs.get(runId);
    if (!run || this.closed) confirmation('此连接没有对应的首版授权。');
    return run;
  }

  private requireActive(run: Build): void {
    if (this.closed || run.state !== 'active') confirmation(run.reason ?? '此首版授权已结束。');
    if (Date.now() >= run.expiresAt) this.pause(run, '首版授权已过期。');
  }

  private async runExclusive<T>(runId: string, work: (run: Build) => Promise<T>): Promise<T> {
    const run = this.find(runId);
    this.requireActive(run);
    if (run.busy) throw new AppError('FIRST_BUILD_BUSY', '该首版批次仍在处理，请等待结果。');
    run.busy = true;
    try {
      return await work(run);
    } finally {
      run.busy = false;
    }
  }

  private async verify(run: Build, updates = new Map<string, string>()): Promise<Tree> {
    let current: Tree;
    try {
      current = await captureTree(run.project);
    } catch {
      this.pause(run, '无法核对隔离工程的目录和文件状态。');
    }
    const changed = treeDifference(run.baseline, current, updates);
    if (changed !== undefined) this.pause(run, '检测到工程状态变化：' + changed + '。');
    this.requireActive(run);
    return current;
  }

  private async assertIsolatedRoot(): Promise<void> {
    const { root, templateRoot, terreGamesRoots } = this.location;
    const protectedRoots = [templateRoot, ...terreGamesRoots,
      ...this.config.projects.map(project => project.root), ...this.config.sources.map(source => source.root)];
    if (path.relative(root, await realpath(root)) !== '' ||
      protectedRoots.some(other => within(root, other) || within(other, root)) ||
      within(root, path.resolve(this.normalStateRoot)) || within(path.resolve(this.normalStateRoot), root)) {
      throw new AppError('FIRST_BUILD_ROOT_OVERLAP', '首版工作区必须与模板、素材库、Terre 工程和普通写入状态分开。');
    }
  }

  async begin(scope: FirstBuildScope, statement: string) {
    if (this.closed) confirmation('MCP 连接已关闭。');
    await this.assertIsolatedRoot();
    const { root, templateRoot } = this.location;
    const targets = scope.scenes.map(scene => targetPath({ type: 'create_scene', path: scene, text: '' }));
    if (!targets.includes('game/scene/start.txt')) {
      throw new AppError('FIRST_BUILD_ENTRY_REQUIRED', '首版授权范围须包含入口场景 start.txt。');
    }
    targets.forEach(target => assertWritePath(target, true));
    for (const asset of scope.assets) {
      if (!this.config.sources.some(source => source.id === asset.sourceId)) confirmation('素材来源未登记。');
      validateRelativePath(asset.sourcePath);
      targets.push(assertWritePath(targetPath(importOperation(asset)), true));
    }
    if (new Set(targets.map(file => file.toLowerCase())).size !== targets.length) {
      throw new AppError('TARGET_COLLISION', '首版范围含有重复的工程路径。');
    }
    const template = await captureTree(templateRoot, true);
    if (!['index.html', 'game/config.txt', 'game/scene/start.txt'].every(file => template.get(file)?.revision)) {
      throw new AppError('FIRST_BUILD_TEMPLATE_INVALID', '首版模板需要包含可播放的 WebGAL 运行时、配置和 start.txt。');
    }
    const id = randomUUID();
    const directory = path.join(root, id);
    const project = path.join(directory, 'project');
    await mkdir(directory, { mode: 0o700 });
    await cp(templateRoot, project, { recursive: true, errorOnExist: true, force: false });
    const initial = await captureTree(project);
    if (!sameContents(template, initial) || treeDifference(template, await captureTree(templateRoot, true)) !== undefined) {
      confirmation('复制期间模板或新工程发生变化。');
    }
    for (const target of targets) await mkdir(path.dirname(path.join(project, target)), { recursive: true });
    const baseline = await captureTree(project);
    // New parent directories are expected. Template files must still have their copied identities and bytes.
    if (treeDifference(initial, new Map([...baseline].filter(([name, entry]) => entry.revision !== null || initial.has(name)))) !== undefined) {
      confirmation('生成工程目录期间发现意外文件。');
    }
    if (this.closed) confirmation('MCP 连接已关闭。');
    const config: AppConfig = { version: 1, projects: [{ id, root: project }], sources: this.config.sources };
    const coordinator = await WriteCoordinator.create(config, path.join(directory, 'state'), {
      ...this.coordinatorOptions,
      capabilityCheck: async candidate => {
        if (candidate.id !== id || candidate.root !== project || candidate.terreUrl) return false;
        await this.verify(this.find(id));
        return true;
      }
    });
    const expiresAt = Date.now() + ttlMs;
    await writeFile(path.join(directory, 'authorization.json'), JSON.stringify({ id, scope, statement, expiresAt }), { flag: 'wx', mode: 0o600 });
    if (this.closed) confirmation('MCP 连接已关闭。');
    this.runs.set(id, { id, directory, project, scope, statement, expiresAt, state: 'active', busy: false,
      baseline, requiredTargets: new Map(targets.map(target => [target, initial.get(target)?.revision ?? null])),
      receipts: new Map(), coordinator, writer: new BusinessWriteService(config, coordinator, this.owner),
      reader: new ReadService(config) });
    return { runId: id, storyRevision: scope.storyRevision, expiresAt, state: 'active', requiresTerreHandoff: false };
  }

  private checkScope(run: Build, storyRevision: string, operations: BusinessOperation[]): string[] {
    if (storyRevision !== run.scope.storyRevision) this.pause(run, '剧本版本超出本次授权。');
    const assets = new Map(run.scope.assets.map(asset => [targetPath(importOperation(asset)), asset]));
    const paths: string[] = [];
    for (const operation of operations) {
      let target: string;
      try {
        target = targetPath(operation);
      } catch {
        this.pause(run, '申请的写入路径不在工程范围内。');
      }
      if (operation.type === 'import_asset') {
        if (!approvedAsset(assets.get(target), operation)) this.pause(run, '素材、来源或目标超出本次授权：' + target + '。');
      } else if (operation.type === 'edit_config') {
        if (operation.updates.some(update => !run.scope.configKeys.includes(update.key))) {
          this.pause(run, '申请的设置项超出本次授权。');
        }
      } else if (!run.scope.scenes.includes(operation.path)) {
        this.pause(run, '场景超出本次授权：' + target + '。');
      }
      paths.push(target);
    }
    return paths;
  }

  async apply(runId: string, storyRevision: string, key: string, operations: BusinessOperation[]) {
    return this.runExclusive(runId, async run => {
      const paths = this.checkScope(run, storyRevision, operations);
      const digest = signature(operations);
      await this.verify(run);
      const replay = run.receipts.get(key);
      if (replay) {
        if (replay.digest !== digest || !replay.outcome) this.pause(run, '批次键已用于其他请求或缺少已核对的回执。');
        return { planId: replay.planId, ...replay.outcome, replayed: true };
      }
      const window = Math.min(WRITE_LIMITS.sessionTtlMs, run.expiresAt - Date.now());
      if (window <= 0) this.pause(run, '首版授权已过期。');
      const session = run.coordinator.sessions.begin(
        this.owner, run.id, { source: 'user-message', statement: run.statement }, paths, window
      );
      let pending = false;
      try {
        const review = await run.writer.plan(run.id, session.id, operations);
        const planId = review.planId!;
        if (review.diagnosticsTruncated || review.diagnostics.some(entry => entry.severity === 'error')) {
          throw new AppError('FIRST_BUILD_CANDIDATE_INVALID', '候选场景或配置有待修正的诊断，请检查候选后重试。');
        }
        await writeFile(path.join(run.directory, planId + '.pending.json'),
          JSON.stringify({ key, digest, planId, operations: review.operations.map(({ path, beforeRevision, afterRevision }) =>
            ({ path, beforeRevision, afterRevision })) }), { flag: 'wx', mode: 0o600 });
        const receipt: Receipt = { digest, planId };
        run.receipts.set(key, receipt);
        this.requireActive(run);
        pending = true;
        const outcome = await run.writer.apply(session.id, planId, key);
        if (outcome.status !== 'complete' || outcome.warnings?.length) this.pause(run, '写入结果需要核对，计划 ' + planId + '。');
        run.baseline = await this.verify(run, new Map(review.operations.map(operation => [operation.path, operation.afterRevision])));
        await writeFile(path.join(run.directory, planId + '.result.json'), JSON.stringify(outcome), { flag: 'wx', mode: 0o600 });
        receipt.outcome = outcome;
        return { planId, ...outcome };
      } catch (error) {
        const { code } = publicError(error);
        if (code === 'FIRST_BUILD_CONFIRMATION_REQUIRED') throw error;
        if (pending || ['SOURCE_CHANGED', 'REVISION_CONFLICT', 'TARGET_EXISTS', 'PATH_INVALID'].includes(code)) {
          this.pause(run, '批次需要核对，原因 ' + code + '。');
        }
        throw error;
      } finally {
        run.coordinator.sessions.end(session.id, this.owner);
      }
    });
  }

  async inspect(runId: string, scenePath?: string, candidateText?: string): Promise<unknown> {
    const run = !this.closed ? this.runs.get(runId) : undefined;
    if (!run) {
      if (this.closed) confirmation('MCP 连接已关闭。');
      if (scenePath !== undefined) {
        throw new AppError('FIRST_BUILD_ARCHIVE_ONLY', '旧连接的首版仅支持只读查看批次回执。');
      }
      await this.assertIsolatedRoot();
      return inspectArchivedBuild(this.location.root, runId);
    }
    if (run.state === 'active' && Date.now() >= run.expiresAt) {
      run.state = 'paused';
      run.reason = '首版授权已过期。';
    }
    if (scenePath !== undefined) {
      return {
        ...(candidateText === undefined ? { scene: await run.reader.scene(run.id, scenePath) } : {}),
        analysis: await run.reader.validate(run.id, scenePath, candidateText)
      };
    }
    const batches = [...run.receipts.values()].map(({ planId, outcome }) => ({
      planId, batchId: outcome?.batchId, verified: outcome !== undefined
    }));
    return {
      state: run.state, requiresUserConfirmation: run.state !== 'active',
      reason: run.reason, expiresAt: run.expiresAt, batches,
      ...(run.state === 'delivered' ? { projectPath: run.project, snapshotPath: run.preview?.snapshotPath, previewUrl: run.preview?.url } : {}),
      ...(run.state === 'active' ? { project: await run.reader.inspect(run.id), scan: await run.reader.scan(run.id, {}) } : {}),
      ...(run.state === 'paused' ? {
        recovery: await run.coordinator.pending(run.id, { includeCompleted: true })
      } : {})
    };
  }

  private async deliver(run: Build, snapshotId?: string) {
    const writes = new Map<string, string>();
    for (const receipt of run.receipts.values()) {
      for (const operation of receipt.outcome?.operations ?? []) {
        writes.set(operation.path, operation.afterRevision);
      }
    }
    const missing = [...run.requiredTargets].filter(([target, original]) => {
      const saved = run.baseline.get(target)?.revision;
      return !saved || saved === original || writes.get(target) !== saved;
    }).map(([target]) => target);
    if (missing.length) {
      const detail = missing.slice(0, 8).join('、');
      throw new AppError('FIRST_BUILD_INCOMPLETE', '仍有 ' + missing.length + ' 项必交产物未写入并读回：' + detail + '。');
    }

    const preview = run.preview;
    if (!preview || preview.snapshotId !== snapshotId || preview.projectTree !== run.baseline) {
      throw new AppError('FIRST_BUILD_PREVIEW_REQUIRED', '请先预览和核对当前工程版本，再提交该快照 ID。');
    }
    let currentSnapshot: Tree;
    try {
      currentSnapshot = await captureTree(preview.snapshotPath);
    } catch {
      throw new AppError('FIRST_BUILD_PREVIEW_REQUIRED', '播放快照不可用，请重新预览核对。');
    }
    if (treeDifference(preview.snapshotTree, currentSnapshot) !== undefined ||
      [...preview.snapshotTree].some(([target, entry]) => currentSnapshot.get(target)?.fingerprint !== entry.fingerprint)) {
      throw new AppError('FIRST_BUILD_PREVIEW_REQUIRED', '播放快照已发生变化，请重新预览核对。');
    }
    await this.verify(run);
    run.state = 'delivered';
    return {
      runId: run.id, state: run.state, snapshotId: preview.snapshotId, previewUrl: preview.url,
      projectPath: run.project, snapshotPath: preview.snapshotPath
    };
  }

  async preview(runId: string, deliver: boolean, snapshotId?: string) {
    return this.runExclusive(runId, async run => {
      await this.verify(run);
      if (deliver) return this.deliver(run, snapshotId);

      const id = randomUUID();
      const snapshotPath = path.join(run.directory, 'snapshot-' + id);
      let snapshotTree: Tree;
      try {
        await cp(run.project, snapshotPath, { recursive: true, errorOnExist: true, force: false });
        snapshotTree = await captureTree(snapshotPath);
      } catch {
        this.pause(run, '无法核对播放快照。');
      }
      if (!sameContents(run.baseline, snapshotTree)) this.pause(run, '播放快照的内容与已核对工程不一致。');
      await this.verify(run);
      const preview = await openPreview(snapshotPath, snapshotTree);
      try {
        this.requireActive(run);
      } catch (error) {
        preview.server.close();
        throw error;
      }
      run.preview?.server.close();
      run.preview = { ...preview, snapshotId: id, snapshotPath, snapshotTree, projectTree: run.baseline };
      return { runId, state: run.state, snapshotId: id, previewUrl: preview.url };
    });
  }

  cancel(runId: string) {
    const run = this.find(runId);
    if (run.state === 'delivered') return { state: run.state };
    run.state = 'cancelled';
    run.coordinator.sessions.disconnect(this.owner);
    run.preview?.server.close();
    return { state: run.state };
  }

  close() {
    this.closed = true;
    for (const run of this.runs.values()) {
      run.coordinator.sessions.disconnect(this.owner);
      run.preview?.server.close();
    }
  }
}
