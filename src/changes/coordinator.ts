import { createHash, randomUUID } from 'node:crypto';
import { posix } from 'node:path';
import { z } from 'zod';
import { AppError } from '../errors.js';
import { getProject } from '../config.js';
import { inspectTerre } from '../terre.js';
import type { AppConfig, ProjectConfig } from '../types.js';
import { SessionManager } from './sessions.js';
import { canonicalProjectKey, ProjectLocks } from './locks.js';
import { StateStore } from './store.js';
import { copyAssetSource, describeAssetSource, readSource } from '../assets/source.js';
import { validateRelativePath } from '../filesystem.js';
import { assertCreateTargetAbsent, assertReferenceableTarget, assertWritePath, snapshotTarget, publishTarget, publishStreamedAsset, streamedTargetRevision, inspectStaging, inspectStreamedStaging, checkedModelDirectory, createModelDirectory, inspectModelDirectoryStaging, modelDirectoryIdentity } from './targets.js';
import { LARGE_ASSET_LIMITS, WRITE_LIMITS, type ChangeInput, type CoordinatorChange, type PlannedChange, type WritePlan, type BatchRecord, type ApplyResult, type FaultHook, type SourceRevision, type ModelBundle, type ModelDependencyRevision } from './types.js';

const hash = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
const uuid = z.string().uuid();
const revision = z.string().regex(/^[a-f0-9]{64}$/);
const version = z.literal([1, 2, 3, 4]);
const operationPath = z.string().min(1).max(1024);
const sourceRootPath = z.string().max(1024);
const maxModelDirectories = 128;
const legacyModelBundleSchema = z.object({ directory: operationPath, modelPath: operationPath }).strict();
const modelDirectoryExpectationSchema = z.object({
  path: operationPath,
  state: z.enum(['create', 'existing']),
  identity: revision.optional(),
}).strict();
const modelSourceMappingSchema = z.object({
  targetRelativePath: operationPath,
  sourceRelativePath: operationPath,
}).strict();
const modelDependencyRevisionSchema = z.object({
  path: operationPath,
  revision,
}).strict();
const extendedModelBundleSchema = z.object({
  directory: operationPath,
  modelPath: operationPath,
  mode: z.enum(['create', 'update']),
  directories: z.array(modelDirectoryExpectationSchema).min(1).max(maxModelDirectories),
  sourceId: z.string().min(1).max(64),
  sourceRootPath,
  bundleRevision: revision,
  batchIndex: z.number().int().min(0).max(10_000),
  batchCount: z.number().int().min(1).max(10_000),
  skippedBatchIndices: z.array(z.number().int().min(0).max(10_000)).max(10_000).optional(),
  previousPlanId: uuid.optional(),
  entryIncluded: z.boolean(),
  sourceMappings: z.array(modelSourceMappingSchema).max(WRITE_LIMITS.maxFiles).optional(),
  dependencies: z.array(modelDependencyRevisionSchema).max(10_000).optional(),
  targetEntryRevision: revision.optional(),
  targetReferences: z.array(modelDependencyRevisionSchema).max(10_000).optional(),
}).strict();
const modelBundleSchema = z.union([extendedModelBundleSchema, legacyModelBundleSchema]);
const modelDirectorySchema = z.object({ path: operationPath, phase: z.enum(['pending', 'intent', 'created']), identity: revision.optional() }).strict();
const inlineOperation = z.object({ path: operationPath, expectedRevision: revision.nullable(), newRevision: revision, data: z.string().max(2 * WRITE_LIMITS.maxFileBytes) }).strict();
const sourceSchema = z.object({ sourceId: z.string().min(1).max(64), path: z.string().min(1).max(1024), revision, rootKey: revision }).strict();
const assetSize = z.number().int().min(0).max(LARGE_ASSET_LIMITS.maxFileBytes);
const streamedOperation = z.object({ path: operationPath, expectedRevision: z.null(), newRevision: revision, source: sourceSchema.extend({ bytes: assetSize }) }).strict();
const operationSchema = z.union([inlineOperation, streamedOperation]);
const planSchema = z.object({ version, id: uuid, projectId: z.string(), projectKey: revision, ownerId: z.string(), sessionId: uuid, createdAt: z.number().finite(), expiresAt: z.number().finite(), operations: z.array(operationSchema).min(1).max(WRITE_LIMITS.maxFiles), digest: revision, restoresBatchId: uuid.optional(), sources: z.array(sourceSchema).min(1).max(WRITE_LIMITS.maxFiles).optional(), modelBundle: modelBundleSchema.optional() }).strict();
const recordSchema = z.object({ path: z.string(), expectedRevision: revision.nullable(), newRevision: revision, backup: z.string().optional(), sourceBytes: assetSize.optional(), phase: z.enum(['pending', 'intent', 'applied']) }).strict();
const batchSchema = z.object({ version, id: uuid, projectId: z.string(), projectKey: revision, ownerId: z.string(), planId: uuid, planDigest: revision, keyHash: revision, status: z.enum(['preparing', 'applying', 'complete', 'failed', 'partial', 'uncertain']), operations: z.array(recordSchema).min(1).max(WRITE_LIMITS.maxFiles), errorCode: z.string().optional(), createdAt: z.number().finite(), restoresBatchId: uuid.optional(), directories: z.array(modelDirectorySchema).max(maxModelDirectories).optional() }).strict();
const keySchema = z.object({ version, projectKey: revision, planId: uuid, digest: revision, batchId: uuid }).strict();
function corrupt(): never { throw new AppError('STATE_CORRUPT', 'Stored write state could not be validated. No recovery was applied.'); }
function digest(plan: Omit<WritePlan, 'digest'>) {
  const operations = plan.operations.map(op => [op.path, op.expectedRevision, op.newRevision, op.source
    ? ['source', op.source.sourceId, op.source.path, op.source.rootKey, op.source.revision, op.source.bytes]
    : op.data]);
  const payload: unknown[] = [plan.version, plan.id, plan.projectId, plan.projectKey, plan.ownerId, plan.sessionId, plan.createdAt, plan.expiresAt, operations, plan.restoresBatchId ?? null];
  if (plan.sources) payload.push(plan.sources.map(source => [source.sourceId, source.path, source.revision, source.rootKey]));
  if (plan.modelBundle) payload.push(plan.modelBundle);
  return hash(JSON.stringify(payload));
}
function checkedId(id: string) { if (!uuid.safeParse(id).success) throw new AppError('INVALID_ARGUMENT', 'Invalid write record identifier.'); return id; }
function identity(path: string) { return process.platform === 'win32' ? path.toLowerCase() : path; }
function errorCode(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOSPC') return 'STORAGE_FULL';
  return error instanceof AppError ? error.code : 'WRITE_FAILED';
}
function checkedOperations(operations: PlannedChange[], model?: ModelBundle) {
  let total = 0;
  let streamedTotal = 0;
  const paths = new Set<string>();
  for (const op of operations) {
    if (model && op.path === model.modelPath && op.expectedRevision !== null) {
      assertReferenceableTarget(op.path);
    } else {
      assertWritePath(op.path, op.expectedRevision === null);
    }
    if (paths.has(identity(op.path))) throw new AppError('INVALID_ARGUMENT', 'A batch cannot contain duplicate target paths.');
    paths.add(identity(op.path));
    if (op.source) {
      const validTarget = model
        ? op.path.startsWith(`${model.directory}/`)
        : /^game\/(?:background|bgm)\//.test(op.path) && op.source.bytes > WRITE_LIMITS.maxFileBytes;
      if (!validTarget || op.expectedRevision !== null
        || op.source.revision !== op.newRevision || validateRelativePath(op.source.path) === '') corrupt();
      streamedTotal += op.source.bytes;
      if (streamedTotal > LARGE_ASSET_LIMITS.maxBatchBytes) throw new AppError('LIMIT_EXCEEDED', 'Large assets exceed the streaming batch limit.');
      continue;
    }
    const data = Buffer.from(op.data, 'base64');
    total += data.byteLength;
    if (data.toString('base64') !== op.data || data.byteLength > WRITE_LIMITS.maxFileBytes
      || total > WRITE_LIMITS.maxBatchBytes || hash(data) !== op.newRevision
      || (model && op.path !== model.modelPath)) corrupt();
  }
}

function extendedModel(model: ModelBundle): model is ModelBundle & {
  mode: 'create' | 'update';
  directories: NonNullable<ModelBundle['directories']>;
  sourceId: string;
  sourceRootPath: string;
  bundleRevision: string;
  batchIndex: number;
  batchCount: number;
  entryIncluded: boolean;
  dependencies?: NonNullable<ModelBundle['dependencies']>;
} {
  return model.directories !== undefined;
}

function modelEntryName(path: string) {
  const name = posix.basename(path).toLowerCase();
  return name === 'model.json' || name.endsWith('.model3.json');
}

function modelTargetBindings(model: ModelBundle): ModelDependencyRevision[] {
  return [
    ...(model.targetEntryRevision ? [{ path: model.modelPath, revision: model.targetEntryRevision }] : []),
    ...(model.targetReferences ?? []),
  ];
}

type ModelOperation = Pick<PlannedChange, 'path' | 'source'> & { newRevision?: string };

export function checkedModelDirectories(model: ModelBundle, operations: readonly ModelOperation[]): string[] {
  const root = checkedModelDirectory(model.directory);
  const last = operations.at(-1);
  const entry = operations.find(operation => operation.path === model.modelPath);
  const entryIncluded = last?.path === model.modelPath;
  if (!last || !model.modelPath.startsWith(`${root}/`) || !modelEntryName(model.modelPath)
    || entryIncluded !== !!entry || (extendedModel(model) && model.entryIncluded !== entryIncluded)) corrupt();
  if (!extendedModel(model) && (!entryIncluded || !entry?.source)) corrupt();
  if (extendedModel(model)
    && (model.mode === undefined
      || model.sourceId === undefined
      || model.sourceRootPath === undefined
      || model.bundleRevision === undefined
      || model.batchIndex === undefined
      || model.batchCount === undefined
      || (model.sourceRootPath !== '' && validateRelativePath(model.sourceRootPath) !== model.sourceRootPath)
      || model.batchIndex >= model.batchCount
      || (model.skippedBatchIndices ?? []).some((index, position, skipped) => (
        index >= model.batchIndex!
        || (position > 0 && index <= skipped[position - 1])
      ))
      || (model.previousPlanId === undefined
        && (model.skippedBatchIndices?.length ?? 0) !== model.batchIndex))) corrupt();
  const sourceMappings = model.sourceMappings ?? [];
  const mappingByTarget = new Map(sourceMappings.map(mapping => [mapping.targetRelativePath, mapping]));
  if (new Set(sourceMappings.map(mapping => mapping.targetRelativePath)).size !== sourceMappings.length
    || new Set(sourceMappings.map(mapping => mapping.sourceRelativePath)).size !== sourceMappings.length
    || sourceMappings.some(mapping => (
      validateRelativePath(mapping.targetRelativePath) !== mapping.targetRelativePath
      || validateRelativePath(mapping.sourceRelativePath) !== mapping.sourceRelativePath
    ))) corrupt();
  const dependencies = model.dependencies ?? [];
  const dependencyByPath = new Map(dependencies.map(dependency => [identity(dependency.path), dependency]));
  if ((extendedModel(model) && model.entryIncluded && model.dependencies === undefined)
    || dependencyByPath.size !== dependencies.length
    || dependencies.some(dependency => (
      !dependency.path.startsWith(`${root}/`)
      || validateRelativePath(dependency.path) !== dependency.path
    ))) corrupt();
  const targetReferences = model.targetReferences ?? [];
  const targetReferenceByPath = new Map(targetReferences.map(reference => [identity(reference.path), reference]));
  const operationPaths = new Set(operations.map(operation => identity(operation.path)));
  if (targetReferenceByPath.size !== targetReferences.length
    || targetReferences.some(reference => (
      !reference.path.startsWith(`${root}/`)
      || validateRelativePath(reference.path) !== reference.path
      || identity(reference.path) === identity(model.modelPath)
      || operationPaths.has(identity(reference.path))
    ))) corrupt();
  const paths = new Map<string, { path: string; directory: boolean }>();
  const usedSourceMappings = new Set<string>();
  const directories = new Set([root]);
  const add = (path: string, directory: boolean) => {
    const key = path.normalize('NFC').toLowerCase();
    const previous = paths.get(key);
    if (previous && (!directory || !previous.directory || previous.path !== path)) {
      throw new AppError('TARGET_EXISTS', 'Model files or directories have conflicting target names.');
    }
    paths.set(key, { path, directory });
  };
  for (const op of operations) {
    assertReferenceableTarget(op.path);
    if (!op.path.startsWith(`${root}/`) || (op !== entry && !op.source)
      || (op !== entry && modelEntryName(op.path))) corrupt();
    if (extendedModel(model) && op.source) {
      const relative = op.path.slice(root.length + 1);
      const mapping = mappingByTarget.get(relative);
      const sourceRelativePath = mapping?.sourceRelativePath ?? relative;
      if (sourceMappings.length && !mapping) corrupt();
      if (mapping) usedSourceMappings.add(mapping.targetRelativePath);
      const expectedSourcePath = posix.join(model.sourceRootPath, sourceRelativePath);
      if (op.source.sourceId !== model.sourceId || op.source.path !== expectedSourcePath) corrupt();
      const dependency = dependencyByPath.get(identity(op.path));
      if (model.dependencies && (!dependency || !op.newRevision || dependency.revision !== op.newRevision)) corrupt();
    }
    add(op.path, false);
    for (let parent = posix.dirname(op.path); parent !== root; parent = posix.dirname(parent)) {
      add(parent, true);
      directories.add(parent);
      if (directories.size > maxModelDirectories) {
        throw new AppError('LIMIT_EXCEEDED', 'The model package contains too many directories.');
      }
    }
  }
  if (sourceMappings.some(mapping => !usedSourceMappings.has(mapping.targetRelativePath))) corrupt();
  const sorted = [...directories].sort((left, right) => left.length - right.length || (left < right ? -1 : left > right ? 1 : 0));
  if (extendedModel(model)) {
    const expected = model.directories;
    if (expected.length > maxModelDirectories
      || new Set(expected.map(item => identity(item.path))).size !== expected.length
      || expected.some(item => !item.path.startsWith(`${root}`)
        || (item.path !== root && !item.path.startsWith(`${root}/`))
        || (item.state === 'create' && item.identity !== undefined)
        || (item.state === 'existing' && item.identity === undefined))
      || expected.map(item => item.path)
        .sort((left, right) => left.length - right.length || left.localeCompare(right))
        .join('\n') !== sorted.join('\n')
      || (model.mode === 'create' && expected.some(item => item.state !== 'create'))
      || (model.mode === 'update' && expected.find(item => item.path === root)?.state !== 'existing')) corrupt();
  }
  return sorted;
}

export function modelCreateDirectories(model: ModelBundle, operations: readonly ModelOperation[]) {
  if (!extendedModel(model)) return checkedModelDirectories(model, operations);
  checkedModelDirectories(model, operations);
  return model.directories.filter(item => item.state === 'create').map(item => item.path);
}

export function modelExistingDirectories(model: ModelBundle, operations: readonly ModelOperation[]) {
  if (!extendedModel(model)) return [];
  checkedModelDirectories(model, operations);
  return model.directories.filter(item => item.state === 'existing');
}
function summarize(record: BatchRecord, replayed = false): ApplyResult {
  return { batchId: record.id, status: record.status, operations: structuredClone(record.operations), ...(record.errorCode ? { errorCode: record.errorCode } : {}), replayed };
}
export interface CoordinatorOptions {
  sessions?: SessionManager;
  locks?: ProjectLocks;
  now?: () => number;
  capabilityCheck?: (project: ProjectConfig) => Promise<boolean>;
  fault?: FaultHook;
}

/** Internal host API only. No P2 mutation is registered as an MCP tool. */
export class WriteCoordinator {
  readonly sessions: SessionManager;
  readonly locks: ProjectLocks;
  readonly store: StateStore;
  private readonly now: () => number;
  private readonly capabilityCheck: (project: ProjectConfig) => Promise<boolean>;
  private readonly fault: FaultHook;
  private constructor(private readonly config: AppConfig, store: StateStore, options: CoordinatorOptions) {
    this.now = options.now ?? Date.now;
    this.sessions = options.sessions ?? new SessionManager(this.now);
    this.locks = options.locks ?? new ProjectLocks();
    this.store = store;
    this.fault = options.fault ?? (() => {});
    this.capabilityCheck = options.capabilityCheck ?? (async project => {
      const state = await inspectTerre(project);
      return state.reachable && state.mappingVerified && state.capabilities.apiTest === 'available' && state.capabilities.openApi === 'available' && state.capabilities.readGameAssets === 'available';
    });
  }
  static async create(config: AppConfig, stateRoot: string, options: CoordinatorOptions = {}) {
    const ownedConfig = structuredClone(config);
    const locks = options.locks ?? new ProjectLocks();
    await locks.validateIsolation(ownedConfig);
    return new WriteCoordinator(ownedConfig, await StateStore.create(stateRoot, ownedConfig), { ...options, locks });
  }
  async plan(ownerId: string, sessionId: string, projectId: string, changes: CoordinatorChange[], restoresBatchId?: string, sources?: SourceRevision[], modelBundle?: ModelBundle): Promise<WritePlan> {
    const project = getProject(this.config, projectId);
    if (modelBundle?.previousPlanId) await this.assertModelContinuation(projectId, modelBundle);
    if (!Array.isArray(changes) || changes.length < 1 || changes.length > WRITE_LIMITS.maxFiles) throw new AppError('INVALID_ARGUMENT', 'Invalid batch size.');
    if (changes.reduce((total, change) => total + ('bytes' in change ? change.bytes?.byteLength ?? 0 : 0), 0) > WRITE_LIMITS.maxBatchBytes) throw new AppError('LIMIT_EXCEEDED', 'The batch exceeds the configured byte limit.');
    const operations: PlannedChange[] = changes.map(change => {
      if ('source' in change) {
        const checked = streamedOperation.safeParse({
          path: assertWritePath(change.path, true),
          expectedRevision: change.expectedRevision,
          newRevision: change.source.revision,
          source: change.source,
        });
        if (!checked.success) throw new AppError('INVALID_ARGUMENT', 'Invalid streamed asset descriptor.');
        return checked.data;
      }
      if (!(change.bytes instanceof Uint8Array) || change.bytes.byteLength > WRITE_LIMITS.maxFileBytes || !revision.nullable().safeParse(change.expectedRevision).success) throw new AppError('INVALID_ARGUMENT', 'Invalid change payload or base revision.');
      const bytes = Buffer.from(change.bytes);
      const path = modelBundle && change.path === modelBundle.modelPath && change.expectedRevision !== null
        ? assertReferenceableTarget(change.path)
        : assertWritePath(change.path, change.expectedRevision === null);
      return { path, expectedRevision: change.expectedRevision, newRevision: hash(bytes), data: bytes.toString('base64') };
    });
    checkedOperations(operations, modelBundle);
    if (modelBundle) checkedModelDirectories(modelBundle, operations);
    const planVersion = modelBundle
      ? modelBundle.directories !== undefined ? 4 : 3
      : operations.some(operation => operation.source) ? 2 : 1;
    if ((planVersion !== 1 && restoresBatchId) || (modelBundle && sources?.length)) corrupt();
    if (!restoresBatchId) operations.forEach(op => assertReferenceableTarget(op.path));
    const session = this.sessions.require(sessionId, ownerId, projectId, operations.map(op => op.path));
    const projectKey = await canonicalProjectKey(project.root);
    await this.preflight(project, operations, modelBundle);
    const checkedSources = sources?.length ? z.array(sourceSchema).min(1).max(WRITE_LIMITS.maxFiles).parse(sources) : undefined;
    await this.validateSources(checkedSources);
    await this.validateStreamedSources(operations);
    const unsigned: Omit<WritePlan, 'digest'> = { version: planVersion, id: randomUUID(), projectId, projectKey, ownerId, sessionId, createdAt: this.now(), expiresAt: session.expiresAt, operations, ...(restoresBatchId ? { restoresBatchId: checkedId(restoresBatchId) } : {}), ...(checkedSources ? { sources: checkedSources } : {}), ...(modelBundle ? { modelBundle } : {}) };
    const plan: WritePlan = { ...unsigned, digest: digest(unsigned) };
    await this.store.createJson(`plans/${plan.id}.json`, plan);
    return structuredClone(plan);
  }
  private async assertModelContinuation(projectId: string, model: ModelBundle) {
    if (!extendedModel(model) || !model.previousPlanId) corrupt();
    const previousPlan = await this.readPlan(model.previousPlanId);
    const previousModel = previousPlan.modelBundle;
    if (!previousModel || !extendedModel(previousModel)
      || previousModel.directory !== model.directory
      || previousModel.modelPath !== model.modelPath
      || previousModel.sourceId !== model.sourceId
      || previousModel.sourceRootPath !== model.sourceRootPath
      || previousModel.bundleRevision !== model.bundleRevision
      || previousModel.batchCount !== model.batchCount
      || model.batchCount < model.batchIndex + 1) {
      throw new AppError('INVALID_ARGUMENT', 'The model continuation does not match the reviewed bundle.');
    }
    const skipped = new Set(model.skippedBatchIndices ?? []);
    const skippedGap = (from: number, to: number) => {
      for (let index = from + 1; index < to; index++) {
        if (!skipped.has(index)) return false;
      }
      return true;
    };
    let previousBatch;
    for (const id of await this.store.listBatchIds()) {
      try {
        const raw = batchSchema.parse(await this.store.readJson(`batches/${checkedId(id)}/journal.json`));
        if (raw.projectId === projectId && raw.planId === model.previousPlanId) {
          previousBatch = await this.readBatch(id, projectId);
          break;
        }
      } catch {
        // Unreadable unrelated batches are reported by recovery, not adopted here.
      }
    }
    if (!previousBatch) throw new AppError('RECOVERY_REQUIRED', 'The previous model batch could not be verified.');
    const { record } = previousBatch;
    if (record.status === 'uncertain' || record.status === 'preparing' || record.status === 'applying') {
      throw new AppError('RECOVERY_REQUIRED', 'Inspect and resolve the previous model batch before continuing.');
    }
    if (record.status === 'complete' && (previousModel.entryIncluded
      || model.batchIndex <= previousModel.batchIndex
      || !skippedGap(previousModel.batchIndex, model.batchIndex))) {
      throw new AppError('INVALID_ARGUMENT', 'The previous model batch is complete and cannot be continued.');
    }
    if (record.status === 'partial' || record.status === 'failed') {
      const retriesSameBatch = model.batchIndex === previousModel.batchIndex;
      const advancesAfterAppliedBatch = !previousModel.entryIncluded
        && model.batchIndex > previousModel.batchIndex
        && skippedGap(previousModel.batchIndex, model.batchIndex)
        && record.operations.every(operation => operation.phase === 'applied');
      if (!retriesSameBatch && !advancesAfterAppliedBatch) {
        throw new AppError('INVALID_ARGUMENT', 'Retry a failed model batch or continue only after every operation in it was verified as applied.');
      }
    }
    const previousRootIdentity = record.directories?.find(directory => directory.path === model.directory)?.identity
      ?? previousModel.directories.find(directory => directory.path === model.directory)?.identity;
    const currentRoot = model.directories?.find(directory => directory.path === model.directory);
    if (!currentRoot) corrupt();
    if (previousRootIdentity) {
      if (model.mode !== 'update' || currentRoot.state !== 'existing' || currentRoot.identity !== previousRootIdentity) {
        throw new AppError('FILE_CHANGED', 'The model directory no longer matches the previous batch.');
      }
    } else if (model.mode !== 'create') {
      throw new AppError('INVALID_ARGUMENT', 'A continuation without a model directory must be a create batch.');
    }
  }
  private async readPlan(id: string): Promise<WritePlan> {
    const parsed = planSchema.safeParse(await this.store.readJson(`plans/${checkedId(id)}.json`));
    if (!parsed.success) corrupt();
    const plan = parsed.data;
    if (plan.id !== id || digest(plan) !== plan.digest) corrupt();
    const hasSource = plan.operations.some(operation => 'source' in operation);
    if ((plan.version === 1 && hasSource) || (plan.version !== 1 && !hasSource && plan.version !== 4)
      || (plan.version !== 1 && plan.restoresBatchId) || !((plan.version === 3 || plan.version === 4) === !!plan.modelBundle)
      || (plan.version === 3 && plan.modelBundle && extendedModel(plan.modelBundle))
      || (plan.version === 4 && plan.modelBundle && !extendedModel(plan.modelBundle))
      || (plan.modelBundle && plan.sources)) corrupt();
    checkedOperations(plan.operations, plan.modelBundle);
    if (plan.modelBundle) checkedModelDirectories(plan.modelBundle, plan.operations);
    for (const source of plan.sources ?? []) validateRelativePath(source.path);
    return plan;
  }
  private async validateSources(sources?: SourceRevision[]) {
    for (const source of sources ?? []) {
      let current;
      try { current = await readSource(this.config, source.sourceId, source.path); }
      catch { throw new AppError('SOURCE_CHANGED', 'An asset source is unavailable or no longer authorized. Recreate the plan.'); }
      if (current.revision !== source.revision || current.rootKey !== source.rootKey) throw new AppError('SOURCE_CHANGED', 'An asset source changed after planning. Recreate the plan.');
    }
  }
  private async validateStreamedSources(operations: PlannedChange[]) {
    for (const { source } of operations) {
      if (!source) continue;
      let current;
      try { current = await describeAssetSource(this.config, source.sourceId, source.path); }
      catch { throw new AppError('SOURCE_CHANGED', 'A large asset source is unavailable. Recreate the plan.'); }
      if (current.bytes !== source.bytes || current.revision !== source.revision || current.rootKey !== source.rootKey) {
        throw new AppError('SOURCE_CHANGED', 'A large asset source changed after planning. Recreate the plan.');
      }
    }
  }
  private async readBatch(id: string, projectId: string) {
    const parsed = batchSchema.safeParse(await this.store.readJson(`batches/${checkedId(id)}/journal.json`));
    if (!parsed.success || parsed.data.id !== id || parsed.data.projectId !== projectId) corrupt();
    const record = parsed.data;
    const project = getProject(this.config, projectId);
    if (record.projectKey !== await canonicalProjectKey(project.root)) corrupt();
    const plan = await this.readPlan(record.planId);
    if (record.version !== plan.version || record.planDigest !== plan.digest || plan.projectId !== record.projectId || plan.projectKey !== record.projectKey || record.ownerId !== plan.ownerId || record.restoresBatchId !== plan.restoresBatchId || record.operations.length !== plan.operations.length) corrupt();
    record.operations.forEach((op, index) => {
      const expected = plan.operations[index];
      if (op.path !== expected.path || op.expectedRevision !== expected.expectedRevision || op.newRevision !== expected.newRevision || op.sourceBytes !== expected.source?.bytes || (op.backup !== undefined && op.backup !== `batches/${record.id}/backups/${index}.bin`)) corrupt();
      if (op.expectedRevision === null && op.backup !== undefined) corrupt();
      if (record.status === 'complete' && (op.phase !== 'applied' || (op.expectedRevision !== null && !op.backup))) corrupt();
    });
    const expectedDirectories = plan.modelBundle ? modelCreateDirectories(plan.modelBundle, plan.operations) : [];
    if (expectedDirectories.length !== (record.directories?.length ?? 0)
      || record.directories?.some((directory, index) => directory.path !== expectedDirectories[index]
        || (directory.phase === 'created') !== !!directory.identity
        || (record.status === 'complete' && directory.phase !== 'created'))) corrupt();
    return { record, modelBundle: plan.modelBundle };
  }
  private async preflight(project: ProjectConfig, operations: PlannedChange[], model?: ModelBundle) {
    if (model) {
      checkedModelDirectories(model, operations);
      for (const directory of modelExistingDirectories(model, operations)) {
        if (await modelDirectoryIdentity(project.root, directory.path) !== directory.identity) {
          throw new AppError('FILE_CHANGED', 'An existing model directory changed after the package was reviewed.');
        }
      }
      const createDirectories = modelCreateDirectories(model, operations);
      for (const path of createDirectories) {
        if (createDirectories.some(parent => parent !== path && path.startsWith(`${parent}/`))) continue;
        await assertCreateTargetAbsent(project.root, path);
      }
      const snapshots = [];
      const willCreateParent = (path: string) => createDirectories.some(directory =>
        path.startsWith(`${directory}/`));
      for (const op of operations) {
        if (op.expectedRevision === null) {
          if (!willCreateParent(op.path)) await assertCreateTargetAbsent(project.root, op.path);
          snapshots.push({ bytes: null, revision: null });
          continue;
        }
        const snapshot = await snapshotTarget(project.root, op.path);
        if (snapshot.revision !== op.expectedRevision) {
          throw new AppError('REVISION_CONFLICT', 'A model target no longer matches the reviewed base revision.');
        }
        snapshots.push(snapshot);
      }
      for (const binding of modelTargetBindings(model)) {
        const current = await streamedTargetRevision(project.root, binding.path, model.directory);
        if (current !== binding.revision) {
          throw new AppError('REVISION_CONFLICT', 'A model entry or retained reference changed after the package was reviewed.');
        }
      }
      return snapshots;
    }
    const snapshots = [];
    for (const op of operations) {
      if (op.source) {
        await assertCreateTargetAbsent(project.root, op.path);
        snapshots.push({ bytes: null, revision: null });
        continue;
      }
      const snapshot = await snapshotTarget(project.root, op.path);
      if (snapshot.revision !== op.expectedRevision) throw new AppError(op.expectedRevision === null ? 'TARGET_EXISTS' : 'REVISION_CONFLICT', 'A target no longer matches the reviewed base revision.');
      snapshots.push(snapshot);
    }
    return snapshots;
  }
  async apply(ownerId: string, sessionId: string, planId: string, idempotencyKey: string): Promise<ApplyResult> {
    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(idempotencyKey)) throw new AppError('INVALID_ARGUMENT', 'Invalid idempotency key.');
    const plan = await this.readPlan(planId);
    const project = getProject(this.config, plan.projectId);
    const paths = plan.operations.map(op => op.path);
    const model = plan.modelBundle;
    const replayAuthorization = { allowPausedForReplay: model !== undefined && plan.sessionId === sessionId };
    this.sessions.require(sessionId, ownerId, plan.projectId, paths, replayAuthorization);
    if (plan.ownerId !== ownerId) throw new AppError('SESSION_MISMATCH', 'The plan belongs to another client.');
    await this.locks.validateIsolation(this.config);
    const action = async (): Promise<ApplyResult> => {
      this.sessions.require(sessionId, ownerId, plan.projectId, paths, replayAuthorization);
      if (await canonicalProjectKey(project.root) !== plan.projectKey) throw new AppError('PROJECT_NOT_AUTHORIZED', 'The project identity changed.');
      const keyHash = hash(idempotencyKey);
      const keyPath = `keys/${plan.projectKey}/${keyHash}.json`;
      let stored: unknown;
      try { stored = await this.store.readJson(keyPath); }
      catch (error) { if (!(error instanceof AppError) || error.code !== 'STATE_NOT_FOUND') throw error; }
      if (stored !== undefined) {
        const key = keySchema.safeParse(stored);
        if (!key.success) corrupt();
        if (key.data.version !== plan.version || key.data.projectKey !== plan.projectKey || key.data.planId !== plan.id || key.data.digest !== plan.digest) throw new AppError('IDEMPOTENCY_CONFLICT', 'This key belongs to a different write plan.');
        const { record: previous } = await this.readBatch(key.data.batchId, plan.projectId);
        if (previous.keyHash !== keyHash || previous.planId !== plan.id || previous.planDigest !== plan.digest) corrupt();
        const result = summarize(previous, true);
        if (previous.status === 'preparing' || previous.status === 'applying') return { ...result, status: 'uncertain', errorCode: 'RECOVERY_REQUIRED' };
        return result;
      }
      const authorize = () => { this.sessions.require(sessionId, ownerId, plan.projectId, paths); };
      if (model) authorize();
      if (plan.sessionId !== sessionId || plan.expiresAt <= this.now()) throw new AppError('SESSION_EXPIRED', 'Create a fresh plan after a new handoff.');
      if (!plan.restoresBatchId) plan.operations.forEach(op => assertReferenceableTarget(op.path));
      await this.fault('after-lock');
      if (await this.capabilityCheck(project) !== true) throw new AppError('UNSUPPORTED_CAPABILITY', 'Current Terre capabilities and project mapping could not be verified.');
      let snapshots;
      try {
        await this.validateSources(plan.sources);
        await this.validateStreamedSources(plan.operations);
        snapshots = await this.preflight(project, plan.operations, model);
      }
      catch (error) { this.sessions.pause(sessionId); throw error; }
      await this.fault('after-preflight');
      const record: BatchRecord = { version: plan.version, id: randomUUID(), projectId: plan.projectId, projectKey: plan.projectKey, ownerId, planId, planDigest: plan.digest, keyHash, status: 'preparing', operations: plan.operations.map(op => ({ path: op.path, expectedRevision: op.expectedRevision, newRevision: op.newRevision, ...(op.source ? { sourceBytes: op.source.bytes } : {}), phase: 'pending' })), createdAt: this.now(), ...(plan.restoresBatchId ? { restoresBatchId: plan.restoresBatchId } : {}) };
      if (model) record.directories = modelCreateDirectories(model, plan.operations).map(path => ({ path, phase: 'pending' }));
      const validateModelExistingDirectories = async () => {
        if (!model) return;
        for (const directory of modelExistingDirectories(model, plan.operations)) {
          if (await modelDirectoryIdentity(project.root, directory.path) !== directory.identity) {
            throw new AppError('FILE_CHANGED', 'An existing model directory changed after the package was reviewed.');
          }
        }
      };
      const validateAncestors = async (path: string) => {
        await validateModelExistingDirectories();
        for (const directory of record.directories ?? []) {
          if (path.startsWith(`${directory.path}/`) && (!directory.identity
            || await modelDirectoryIdentity(project.root, directory.path) !== directory.identity)) {
            throw new AppError('FILE_CHANGED', 'A model directory no longer matches the directory created by this batch.');
          }
        }
      };
      const validateModelTargetBindings = async () => {
        if (!model) return;
        for (const binding of modelTargetBindings(model)) {
          authorize();
          await validateAncestors(binding.path);
          const current = await streamedTargetRevision(project.root, binding.path, model.directory);
          if (current !== binding.revision) {
            throw new AppError('REVISION_CONFLICT', 'A model entry or retained reference changed before the dependency could be published.');
          }
        }
      };
      const journalPath = `batches/${record.id}/journal.json`;
      await this.store.createJson(journalPath, record);
      let backingUp = false;
      try {
        await this.store.createJson(keyPath, { version: plan.version, projectKey: plan.projectKey, planId, digest: plan.digest, batchId: record.id });
        backingUp = true;
        for (let index = 0; index < snapshots.length; index++) {
          const bytes = snapshots[index].bytes;
          if (bytes !== null) {
            await this.fault('before-backup', index);
            record.operations[index].backup = await this.store.writeBackup(record.id, index, bytes);
            await this.store.replaceJson(journalPath, record);
          }
        }
        backingUp = false;
        await this.fault('after-backups');
        await this.validateSources(plan.sources);
        if (model) await this.validateStreamedSources(plan.operations);
        await this.preflight(project, plan.operations, model);
        record.status = 'applying';
        await this.store.replaceJson(journalPath, record);
        for (const [index, directory] of (record.directories ?? []).entries()) {
          authorize();
          directory.phase = 'intent';
          await this.store.replaceJson(journalPath, record);
          await this.fault('before-model-directory', index);
          const directoryIdentity = await createModelDirectory(
            project.root,
            directory.path,
            record.id,
            index,
            authorize,
            () => validateAncestors(directory.path),
            () => this.fault('before-model-directory-publish', index),
          );
          await this.fault('after-model-directory', index);
          directory.identity = directoryIdentity;
          directory.phase = 'created';
          await this.store.replaceJson(journalPath, record);
        }
        for (let index = 0; index < plan.operations.length; index++) {
          authorize();
          const op = plan.operations[index];
          await validateModelTargetBindings();
          const validateModelDependencies = async () => {
            if (model && op.path === model.modelPath) {
              const dependencies = model.dependencies
                ?? plan.operations.slice(0, index).map(dependency => ({
                  path: dependency.path,
                  revision: dependency.newRevision,
                }));
              for (const dependency of dependencies) {
                authorize();
                await validateAncestors(dependency.path);
                const current = await streamedTargetRevision(project.root, dependency.path, model.directory);
                if (current !== dependency.revision) {
                  throw new AppError('REVISION_CONFLICT', 'A model dependency changed before the entry could be published.');
                }
              }
              await validateAncestors(op.path);
            }
          };
          if (op.source) {
            if (model) await validateAncestors(op.path);
            await assertCreateTargetAbsent(project.root, op.path);
          } else {
            const current = await snapshotTarget(project.root, op.path);
            if (current.revision !== op.expectedRevision) throw new AppError('REVISION_CONFLICT', 'A target changed during the batch. Inspect the recorded outcome.');
          }
          record.operations[index].phase = 'intent';
          await this.store.replaceJson(journalPath, record);
          await this.fault('before-write', index);
          authorize();
          if (op.source) {
            const source = op.source;
            await publishStreamedAsset(project.root, op.path, source, write =>
              copyAssetSource(this.config, source.sourceId, source.path, source, async chunk => {
                authorize();
                await write(chunk);
                await this.fault('after-stream-chunk', index);
              }), record.id, index, authorize, model && {
                directory: model.directory,
                validateBeforePublish: async () => {
                  await validateModelTargetBindings();
                  await validateModelDependencies();
                },
              });
          } else {
            await validateModelDependencies();
            await validateModelTargetBindings();
            await publishTarget(
              project.root,
              op.path,
              op.expectedRevision,
              Buffer.from(op.data, 'base64'),
              record.id,
              index,
              authorize,
              { replaceReferenceableTarget: model !== undefined && op.path === model.modelPath },
            );
          }
          await this.fault('after-write', index);
          record.operations[index].phase = 'applied';
          await this.store.replaceJson(journalPath, record);
          await this.fault('after-record', index);
        }
        await this.fault('before-complete');
        record.status = 'complete';
        await this.store.replaceJson(journalPath, record);
        return summarize(record);
      } catch (error) {
        this.sessions.pause(sessionId);
        const code = errorCode(error);
        if (code === 'SOURCE_CHANGED' || code === 'STORAGE_FULL') {
          const index = record.operations.findIndex(op => op.phase === 'intent' && op.sourceBytes !== undefined);
          if (index !== -1) {
            const op = record.operations[index];
            try {
              await assertCreateTargetAbsent(project.root, op.path);
              if (!(await inspectStreamedStaging(project.root, op.path, record.id, index, model?.directory)).present) op.phase = 'pending';
            } catch { /* keep an uncertain outcome if the disk state cannot be established */ }
          }
        }
        const pending = record.operations.some(op => op.phase === 'intent') || record.directories?.some(dir => dir.phase === 'intent');
        const changed = record.operations.some(op => op.phase === 'applied') || record.directories?.some(dir => dir.phase === 'created');
        record.status = pending ? 'uncertain' : changed ? 'partial' : 'failed';
        record.errorCode = backingUp ? 'BACKUP_FAILED' : code;
        try { await this.store.replaceJson(journalPath, record); }
        catch { record.status = 'uncertain'; record.errorCode = 'OUTCOME_UNKNOWN'; }
        return summarize(record);
      }
    };
    let observed: ApplyResult | undefined;
    try {
      return await this.locks.withLock(project.root, async () => { observed = await action(); return observed; });
    } catch (error) {
      if (observed && error instanceof AppError && error.code === 'LOCK_RELEASE_FAILED') {
        this.sessions.pause(sessionId);
        return { ...observed, warnings: ['LOCK_RELEASE_FAILED'] };
      }
      throw error;
    }
  }
  async inspect(projectId: string, batchId: string) {
    const { record, modelBundle } = await this.readBatch(batchId, projectId);
    const project = getProject(this.config, projectId);
    const directories = [];
    for (const [index, directory] of (record.directories ?? []).entries()) {
      let observed: string | null | undefined;
      try { observed = await modelDirectoryIdentity(project.root, directory.path); }
      catch { /* Preserve an unknown state when a path can no longer be verified. */ }
      const diskState = observed === undefined ? 'unreadable' : observed === null ? 'missing'
        : !directory.identity ? 'present' : observed === directory.identity ? 'planned' : 'changed';
      let stagingPath: string | null | undefined;
      if (directory.phase === 'intent') {
        try { stagingPath = await inspectModelDirectoryStaging(project.root, directory.path, record.id, index); }
        catch { /* A null stagingPath below denotes an unreadable staging state. */ }
      }
      directories.push({
        path: directory.path, phase: directory.phase, diskState,
        ...(directory.phase === 'intent' && stagingPath !== null ? { stagingPath: stagingPath ?? null } : {}),
      });
    }
    const operations = [];
    for (let index = 0; index < record.operations.length; index++) {
      const op = record.operations[index];
      const missingParent = directories.some(directory => directory.diskState === 'missing' && op.path.startsWith(`${directory.path}/`));
      let currentRevision: string | null | undefined;
      try {
        currentRevision = missingParent ? null : op.sourceBytes === undefined
          ? (await snapshotTarget(project.root, op.path)).revision
          : await streamedTargetRevision(project.root, op.path, modelBundle?.directory);
      } catch { currentRevision = undefined; }
      let backupVerified = false;
      if (op.backup) {
        try { backupVerified = hash(await this.store.readBackup(op.backup)) === op.expectedRevision; } catch { /* incomplete/corrupt backup remains unavailable */ }
      }
      const diskState = currentRevision === undefined ? 'unreadable' : currentRevision === null ? 'missing' : currentRevision === op.newRevision ? 'planned' : currentRevision === op.expectedRevision ? 'original' : 'changed';
      let stagingPresent: boolean | null = null;
      let staging: Awaited<ReturnType<typeof inspectStreamedStaging>> | undefined;
      try {
        if (missingParent) {
          stagingPresent = false;
        } else if (op.sourceBytes === undefined) {
          stagingPresent = await inspectStaging(project.root, op.path, record.id, index);
        } else {
          staging = await inspectStreamedStaging(project.root, op.path, record.id, index, modelBundle?.directory);
          stagingPresent = staging.present;
        }
      } catch { /* unknown is not absence */ }
      operations.push({
        path: op.path, phase: op.phase, currentRevision: currentRevision ?? null, diskState, backupVerified, stagingPresent,
        ...(op.sourceBytes === undefined ? {} : {
          sourceBytes: op.sourceBytes,
          stagingBytes: staging?.bytes ?? null,
          stagingVerified: staging?.present ? staging.bytes === op.sourceBytes && staging.revision === op.newRevision : null,
        }),
        canRestore: op.expectedRevision !== null && diskState === 'planned' && backupVerified,
        ...(op.expectedRevision === null ? { limitation: 'Created files are never automatically deleted.' } : {}),
      });
    }
    return {
      batchId: record.id, status: record.status, errorCode: record.errorCode ?? null, snapshotOnly: true, operations,
      ...(modelBundle ? { modelBundle, directories } : {}),
    };
  }
  async pending(projectId: string, options: { planId?: string; includeCompleted?: boolean } = {}) {
    if (options.planId) checkedId(options.planId);
    const key = await canonicalProjectKey(getProject(this.config, projectId).root);
    const batches = [];
    let unreadableRecords = 0;
    for (const id of await this.store.listBatchIds()) {
      try {
        const raw = batchSchema.parse(await this.store.readJson(`batches/${checkedId(id)}/journal.json`));
        if (raw.projectId === projectId && raw.projectKey === key && (!options.planId || raw.planId === options.planId) && (options.includeCompleted || options.planId || raw.status !== 'complete')) batches.push(await this.inspect(projectId, id));
      } catch { unreadableRecords++; }
    }
    return { batches, unreadableRecords };
  }
  async restore(ownerId: string, sessionId: string, projectId: string, batchId: string, selected: { path: string; expectedRevision: string }[], idempotencyKey: string) {
    if (!Array.isArray(selected) || selected.length < 1 || selected.length > WRITE_LIMITS.maxFiles) throw new AppError('INVALID_ARGUMENT', 'Select the files to restore.');
    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(idempotencyKey)) throw new AppError('INVALID_ARGUMENT', 'Invalid idempotency key.');
    const project = getProject(this.config, projectId);
    const projectKey = await canonicalProjectKey(project.root);
    let stored: unknown;
    try { stored = await this.store.readJson(`keys/${projectKey}/${hash(idempotencyKey)}.json`); }
    catch (error) { if (!(error instanceof AppError) || error.code !== 'STATE_NOT_FOUND') throw error; }
    if (stored !== undefined) {
      const key = keySchema.safeParse(stored);
      if (!key.success) corrupt();
      const previous = await this.readPlan(key.data.planId);
      if (key.data.version !== previous.version || key.data.projectKey !== projectKey || key.data.digest !== previous.digest || previous.projectId !== projectId || previous.restoresBatchId !== batchId || previous.operations.length !== selected.length || previous.operations.some((op, i) => op.path !== selected[i]?.path || op.expectedRevision !== selected[i]?.expectedRevision)) throw new AppError('IDEMPOTENCY_CONFLICT', 'This key belongs to a different recovery plan.');
      return this.apply(ownerId, sessionId, previous.id, idempotencyKey);
    }
    const report = await this.inspect(projectId, batchId);
    const { record } = await this.readBatch(batchId, projectId);
    const changes: ChangeInput[] = [];
    for (const selection of selected) {
      const observed = report.operations.find(op => op.path === selection.path);
      const original = record.operations.find(op => op.path === selection.path);
      if (!observed?.canRestore || observed.currentRevision !== selection.expectedRevision || !original?.backup) throw new AppError('RECOVERY_CONFLICT', 'A selected file no longer matches this batch. Nothing was restored.');
      const bytes = await this.store.readBackup(original.backup);
      if (hash(bytes) !== original.expectedRevision) throw new AppError('RECOVERY_CONFLICT', 'The selected backup no longer matches its original version.');
      changes.push({ path: selection.path, expectedRevision: selection.expectedRevision, bytes });
    }
    const plan = await this.plan(ownerId, sessionId, projectId, changes, batchId);
    return this.apply(ownerId, sessionId, plan.id, idempotencyKey);
  }
}
