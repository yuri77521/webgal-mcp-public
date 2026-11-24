import { createHash } from 'node:crypto';
import { posix } from 'node:path';
import { describeAssetSource, readSource } from '../assets/source.js';
import { checkedModelDirectories } from '../changes/coordinator.js';
import { checkedModelDirectory, modelDirectoryIdentity, streamedTargetRevision } from '../changes/targets.js';
import {
  LARGE_ASSET_LIMITS,
  WRITE_LIMITS,
  type ModelSourceMapping,
  type ModelBundle,
  type ModelDependencyRevision,
  type ModelDirectoryExpectation,
  type StreamedAssetSource,
  type WritePlan,
} from '../changes/types.js';
import { getProject } from '../config.js';
import { AppError, publicError } from '../errors.js';
import { readText, validateRelativePath } from '../filesystem.js';
import type { AppConfig } from '../types.js';
import {
  buildGameEntryReview,
  buildSelectedManifest,
  baseManifestReferences,
  live2dManifestReferences,
  makeManifestPortable,
  packageRelativePath,
  portablePackagePath,
  readAllLive2dEntries,
  selectExpressionEntries,
  selectMotionEntries,
  sourcePathForCatalogItem,
  type ExpressionImportSelection,
  type ExpressionMapping,
  type GameEntryReview,
  type MotionImportSelection,
  type MotionMapping,
} from './import-selection.js';
import {
  additionalModelAssetPath,
  inspectLive2dModel,
  modelEntryPath,
  modelFilePath,
  snapshotLive2dCatalog,
} from './model.js';
import type {
  Live2dCatalogItem,
  Live2dCounts,
  Live2dDependencyKind,
  Live2dFormat,
  Live2dLocation,
  Live2dModelReport,
  Live2dStatus,
} from './types.js';

interface ImportRequest {
  projectId: string;
  sourceId: string;
  modelPath: string;
  targetDirectory: string;
  extraPaths?: string[];
  sessionId?: string;
  expectedBundleRevision?: string;
  mode?: 'bundle' | 'curated';
  rootPath?: string;
  motions?: MotionImportSelection[];
  expressions?: ExpressionImportSelection[];
  batchIndex?: number;
  previousPlanId?: string;
}

type SourceChange = {
  path: string;
  expectedRevision: null;
  source: StreamedAssetSource;
};

type InlineChange = {
  path: string;
  expectedRevision: string | null;
  bytes: Buffer;
};

export type ImportChange = SourceChange | InlineChange;
type Persist = (sessionId: string, files: ImportChange[], model: ModelBundle) => Promise<WritePlan>;
type BlockingIssue = { code: string; path?: string };
interface ImportFile {
  path: string;
  bytes: number;
  revision: string;
}
interface ImportReview {
  projectId: string;
  mode: 'bundle' | 'curated';
  modelTargetPath: string | null;
  format?: Live2dFormat;
  status?: Live2dStatus;
  rootPath?: string;
  revision?: string | null;
  counts?: Live2dCounts;
  paths: string[];
  files: ImportFile[];
  totalBytes: number;
  blockingIssues: BlockingIssue[];
  bundleRevision: string | null;
  motions: MotionMapping[];
  expressions: ExpressionMapping[];
  gameEntry?: GameEntryReview;
  batch: {
    index: number;
    total: number;
    entryIncluded: boolean;
    nextBatchIndex: number | null;
  };
  noOp: boolean;
  committable: boolean;
  planId: string | null;
  expiresAt?: number;
}

function documentObject(bytes: Uint8Array) {
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    throw new AppError('MODEL_JSON_INVALID', 'The Live2D model entry is not valid UTF-8 JSON.');
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new AppError('MODEL_STRUCTURE_INVALID', 'The Live2D model entry is not a JSON object.');
  }
  return value as Record<string, unknown>;
}

function addError(blockingIssues: BlockingIssue[], error: unknown, path?: string) {
  const code = publicError(error).code;
  if (!blockingIssues.some(issue => issue.code === code && issue.path === path)) {
    blockingIssues.push({ code, ...(path === undefined ? {} : { path }) });
  }
}

function sourceLocation(input: ImportRequest): Live2dLocation {
  return {
    kind: 'source',
    sourceId: input.sourceId,
    modelPath: modelFilePath(input.modelPath),
    ...(input.rootPath === undefined ? {} : { rootPath: input.rootPath === '' ? '' : validateRelativePath(input.rootPath) }),
  };
}

function importedSourcePath(path: string) {
  return validateRelativePath(posix.normalize(path));
}

function importedTargetPath(path: string) {
  const validated = validateRelativePath(path);
  const segments = validated.split('/');
  if (segments.length < 4
    || segments[0] !== 'game'
    || segments[1] !== 'figure'
    || segments.some((segment, index) => index >= 2 && segment.startsWith('.'))) {
    throw new AppError('PATH_INVALID', 'The imported Live2D target path is invalid.');
  }
  return validated;
}

function curatedTargetEntryName(modelPackagePath: string) {
  const basename = posix.basename(modelPackagePath);
  const lower = basename.toLowerCase();
  return lower === 'model.json' || lower.endsWith('.model3.json') ? basename : 'model.json';
}

function publicReport(report: Live2dModelReport) {
  return {
    format: report.format,
    status: report.status,
    rootPath: report.rootPath,
    revision: report.revision,
    counts: report.counts,
  };
}

async function sourceDocument(config: AppConfig, input: ImportRequest) {
  const source = await readSource(config, input.sourceId, modelEntryPath(input.modelPath));
  return { document: documentObject(source.bytes), revision: source.revision };
}

async function allDependencies(
  config: AppConfig,
  location: Live2dLocation,
  blockingIssues: BlockingIssue[],
) {
  try {
    const page = await readAllLive2dEntries(config, location, 'dependency');
    for (const item of page.items) {
      if (item.status === 'missing') blockingIssues.push({ code: 'DEPENDENCY_MISSING', path: item.path });
      if (item.status === 'invalid') blockingIssues.push({ code: 'PATH_INVALID', path: item.path });
      if (item.status === 'unverified') blockingIssues.push({ code: 'DEPENDENCY_UNVERIFIED', path: item.path });
    }
    return page.items;
  } catch (error) {
    addError(blockingIssues, error);
    return [];
  }
}

async function legacyBundle(
  config: AppConfig,
  input: ImportRequest,
  directory: string,
  persist: Persist,
): Promise<ImportReview> {
  const location = sourceLocation(input);
  const report = await inspectLive2dModel(config, location);
  const blockingIssues: BlockingIssue[] = report.issues.map(({ code, path }) => ({ code, ...(path ? { path } : {}) }));
  const dependencies = await allDependencies(config, location, blockingIssues);
  const manifest = modelFilePath(input.modelPath);
  const filename = posix.basename(manifest);
  const modelTargetPath = importedTargetPath(`${directory}/${filename}`);
  const model: ModelBundle = { directory, modelPath: modelTargetPath };
  if (input.sessionId !== undefined && input.expectedBundleRevision === undefined) {
    throw new AppError('INVALID_ARGUMENT', 'Review a draft and provide its bundleRevision before making a committable plan.');
  }
  const extras: string[] = [];
  for (const path of input.extraPaths ?? []) {
    try { extras.push(additionalModelAssetPath(path)); }
    catch (error) { addError(blockingIssues, error); }
  }
  const relativePaths = [...new Set([...dependencies.map(item => item.path), ...extras])].sort();
  relativePaths.push(filename);
  if (relativePaths.length > WRITE_LIMITS.maxFiles) blockingIssues.push({ code: 'LIMIT_EXCEEDED' });
  const files: SourceChange[] = [];
  let totalBytes = 0;
  let bundleRevision: string | null = null;
  if (!blockingIssues.length) {
    for (const relative of relativePaths) {
      let targetPath: string | undefined;
      try {
        targetPath = importedTargetPath(`${directory}/${relative}`);
        const sourcePath = importedSourcePath(posix.join(posix.dirname(manifest), relative));
        const source = await describeAssetSource(config, input.sourceId, sourcePath);
        totalBytes += source.bytes;
        if (totalBytes > LARGE_ASSET_LIMITS.maxBatchBytes) {
          blockingIssues.push({ code: 'LIMIT_EXCEEDED', path: targetPath });
          break;
        }
        files.push({
          path: targetPath,
          expectedRevision: null,
          source: { sourceId: input.sourceId, path: sourcePath, ...source },
        });
      } catch (error) {
        addError(blockingIssues, error, targetPath);
      }
    }
    if (!blockingIssues.length) {
      try {
        if (files.at(-1)?.source.revision !== report.revision) {
          throw new AppError('SOURCE_CHANGED', 'The model entry changed while preparing this draft.');
        }
        checkedModelDirectories(model, files);
        if (await modelDirectoryIdentity(getProject(config, input.projectId).root, directory) !== null) {
          blockingIssues.push({ code: 'TARGET_EXISTS', path: directory });
          throw new AppError('TARGET_EXISTS', 'Choose a new model directory for a bundle import.');
        }
        bundleRevision = createHash('sha256').update(JSON.stringify([input.projectId, model, files])).digest('hex');
      } catch (error) {
        addError(blockingIssues, error, error instanceof AppError && error.code === 'TARGET_EXISTS' ? directory : undefined);
      }
    }
  }
  if (input.sessionId !== undefined && bundleRevision !== input.expectedBundleRevision) {
    throw new AppError('SOURCE_CHANGED', 'The reviewed model package no longer matches. Generate and review a new draft.');
  }
  const plan = input.sessionId !== undefined && !blockingIssues.length
    ? await persist(input.sessionId, files, model)
    : null;
  return {
    projectId: input.projectId,
    mode: 'bundle',
    modelTargetPath,
    ...publicReport(report),
    paths: files.map(file => file.path),
    files: files.map(({ path, source }) => ({ path, bytes: source.bytes, revision: source.revision })),
    totalBytes,
    blockingIssues,
    bundleRevision: blockingIssues.length ? null : bundleRevision,
    motions: [],
    expressions: [],
    batch: {
      index: 0,
      total: 1,
      entryIncluded: true,
      nextBatchIndex: null,
    },
    noOp: false,
    committable: plan !== null,
    planId: plan?.id ?? null,
    ...(plan ? { expiresAt: plan.expiresAt } : {}),
  };
}

function dependencyByPath(items: Live2dCatalogItem[], path: string, kind?: Live2dDependencyKind) {
  return items.find(item => item.kind === 'dependency'
    && item.path === path
    && (kind === undefined || item.name === kind));
}

function requiredSourcePaths(
  dependencies: Live2dCatalogItem[],
  motions: ReturnType<typeof selectMotionEntries>,
  expressions: ReturnType<typeof selectExpressionEntries>,
  extraPaths: string[],
  modelPath: string,
  rootPath: string,
) {
  const sourcePaths = new Set<string>();
  for (const item of dependencies) {
    if (!['motion', 'expression', 'sound'].includes(item.name)
      && item.status === 'present') {
      sourcePaths.add(sourcePathForCatalogItem(modelPath, item));
    }
  }
  for (const { item } of motions) {
    for (const [path, kind] of [[item.path, 'motion'], [item.sound, 'sound']] as const) {
      if (!path) continue;
      const dependency = dependencyByPath(dependencies, path, kind);
      sourcePaths.add(sourcePathForCatalogItem(modelPath, dependency ?? item));
    }
  }
  for (const { item } of expressions) {
    const dependency = dependencyByPath(dependencies, item.path, 'expression');
    sourcePaths.add(sourcePathForCatalogItem(modelPath, dependency ?? item));
  }
  for (const extra of extraPaths) {
    const checkedExtra = additionalModelAssetPath(extra);
    const sourcePath = validateRelativePath(posix.normalize(posix.join(posix.dirname(modelPath), checkedExtra)));
    packageRelativePath(rootPath, sourcePath);
    sourcePaths.add(sourcePath);
  }
  return [...sourcePaths].sort();
}

function splitOperations(operations: ImportChange[]) {
  const batches: ImportChange[][] = [];
  let batch: ImportChange[] = [];
  let batchBytes = 0;
  for (const operation of operations) {
    const bytes = operationBytes(operation);
    if (batch.length && (batch.length >= WRITE_LIMITS.maxFiles || batchBytes + bytes > LARGE_ASSET_LIMITS.maxBatchBytes)) {
      batches.push(batch);
      batch = [];
      batchBytes = 0;
    }
    batch.push(operation);
    batchBytes += bytes;
  }
  if (batch.length) batches.push(batch);
  return batches;
}

function operationBytes(operation: ImportChange) {
  return 'source' in operation ? operation.source.bytes : operation.bytes.byteLength;
}

function directoriesFor(operations: ImportChange[], root: string) {
  const directories = new Set<string>([root]);
  for (const operation of operations) {
    for (let parent = posix.dirname(operation.path); parent !== root; parent = posix.dirname(parent)) {
      directories.add(parent);
    }
  }
  return [...directories].sort((left, right) => left.length - right.length || left.localeCompare(right));
}

async function directoryExpectations(projectRoot: string, operations: ImportChange[], root: string) {
  const expectations: ModelDirectoryExpectation[] = [];
  for (const path of directoriesFor(operations, root)) {
    const identity = await modelDirectoryIdentity(projectRoot, path);
    if (identity === null) expectations.push({ path, state: 'create' });
    else expectations.push({ path, state: 'existing', identity });
  }
  return expectations;
}

async function curatedImport(
  config: AppConfig,
  input: ImportRequest,
  directory: string,
  persist: Persist,
): Promise<ImportReview> {
  const project = getProject(config, input.projectId);
  const blockingIssues: BlockingIssue[] = [];
  const rootPath = input.rootPath;
  if (rootPath === undefined) {
    blockingIssues.push({ code: 'PACKAGE_ROOT_REQUIRED' });
    return {
      projectId: input.projectId,
      mode: 'curated',
      modelTargetPath: null,
      paths: [],
      files: [],
      totalBytes: 0,
      blockingIssues,
      bundleRevision: null,
      motions: [],
      expressions: [],
      batch: { index: 0, total: 0, entryIncluded: false, nextBatchIndex: null },
      noOp: false,
      committable: false,
      planId: null,
    };
  }
  if (rootPath !== '') validateRelativePath(rootPath);
  const location: Live2dLocation = { kind: 'source', sourceId: input.sourceId, modelPath: modelEntryPath(input.modelPath), rootPath };
  const catalog = await snapshotLive2dCatalog(config, location);
  const report = catalog.report;
  blockingIssues.push(...report.issues.map(({ code, path }) => ({ code, ...(path ? { path } : {}) })));
  const sourceManifest = await sourceDocument(config, input);
  if (sourceManifest.revision !== report.revision) {
    throw new AppError('SOURCE_CHANGED', 'The model entry changed while preparing this draft.');
  }
  const portableSource = makeManifestPortable(
    sourceManifest.document,
    report.format,
    modelEntryPath(input.modelPath),
    rootPath,
  );
  const targetEntryName = curatedTargetEntryName(portableSource.modelPackagePath);
  const targetModelPath = importedTargetPath(
    `${directory}/${posix.join(posix.dirname(portableSource.modelPackagePath), targetEntryName)}`,
  );
  let targetDocument: Record<string, unknown> | null = null;
  let targetRevision: string | null = null;
  try {
    const target = await readText(project.root, targetModelPath);
    targetRevision = target.revision;
    let parsed: unknown;
    try { parsed = JSON.parse(target.text); }
    catch { throw new AppError('MODEL_JSON_INVALID', 'The target model entry is not valid JSON.'); }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new AppError('MODEL_STRUCTURE_INVALID', 'The target model entry is not a JSON object.');
    }
    targetDocument = parsed as Record<string, unknown>;
  } catch (error) {
    if (!(error instanceof AppError) || error.code !== 'FILE_NOT_FOUND') addError(blockingIssues, error, targetModelPath);
  }
  const targetAssembly = await modelDirectoryIdentity(project.root, directory);
  if (targetAssembly !== null && targetDocument === null && input.previousPlanId === undefined) {
    blockingIssues.push({ code: 'TARGET_EXISTS', path: directory });
  }

  const dependencies = catalog.items.filter(item => item.kind === 'dependency');
  const motionEntries = catalog.items.filter(item => item.kind === 'motion');
  const expressionEntries = catalog.items.filter(item => item.kind === 'expression');
  const motions = selectMotionEntries(motionEntries, input.motions ?? []);
  const expressions = selectExpressionEntries(expressionEntries, input.expressions ?? []);
  const manifest = buildSelectedManifest(
    portableSource.document,
    report.format,
    motions,
    expressions,
    targetDocument,
    portableSource.rewriteReference,
  );
  if (targetDocument
    && JSON.stringify(baseManifestReferences(portableSource.document, report.format))
      !== JSON.stringify(baseManifestReferences(targetDocument, report.format))) {
    blockingIssues.push({ code: 'TARGET_CONFLICT', path: targetModelPath });
  }
  const manifestRevision = createHash('sha256').update(manifest.bytes).digest('hex');
  const gameEntry = buildGameEntryReview(
    targetModelPath,
    targetDocument,
    manifest.document,
    report.format,
    targetRevision,
    manifest.changed ? manifestRevision : targetRevision ?? manifestRevision,
    manifest,
  );
  const sourcePaths = requiredSourcePaths(
    dependencies,
    motions,
    expressions,
    input.extraPaths ?? [],
    modelEntryPath(input.modelPath),
    rootPath,
  );
  const logicalChanges: ImportChange[] = [];
  const changes: ImportChange[] = [];
  const plannedSources: Array<{
    path: string;
    sourcePath: string;
    revision: string;
    bytes: number;
  }> = [];
  for (const sourcePath of sourcePaths) {
    try {
      const packagePath = portablePackagePath(packageRelativePath(rootPath, sourcePath));
      const path = importedTargetPath(`${directory}/${packagePath}`);
      if (path === targetModelPath) {
        throw new AppError('TARGET_CONFLICT', 'A model dependency collides with the model entry.');
      }
      const source = await describeAssetSource(config, input.sourceId, sourcePath);
      if (source.bytes > LARGE_ASSET_LIMITS.maxFileBytes) {
        blockingIssues.push({ code: 'FILE_TOO_LARGE', path });
      } else {
        plannedSources.push({
          path,
          sourcePath,
          revision: source.revision,
          bytes: source.bytes,
        });
        const sourceChange: SourceChange = {
          path,
          expectedRevision: null,
          source: { sourceId: input.sourceId, path: sourcePath, ...source },
        };
        logicalChanges.push(sourceChange);
        let current: string | null = null;
        if (targetAssembly !== null) {
          try {
            current = await streamedTargetRevision(project.root, path, directory);
          } catch (error) {
            if (!(error instanceof AppError) || error.code !== 'FILE_NOT_FOUND') throw error;
          }
        }
        if (current === null) {
          changes.push(sourceChange);
        } else if (current !== source.revision) {
          blockingIssues.push({ code: 'TARGET_CONFLICT', path });
        }
      }
    } catch (error) {
      addError(blockingIssues, error, sourcePath);
    }
  }
  const targetReferences = new Map<string, ModelDependencyRevision>();
  const plannedTargetPaths = new Set([targetModelPath, ...plannedSources.map(source => source.path)]);
  for (const reference of live2dManifestReferences(manifest.document, report.format)) {
    let path: string;
    try {
      path = validateRelativePath(posix.normalize(posix.join(posix.dirname(targetModelPath), reference.path)));
      if (!path.startsWith(`${directory}/`)) {
        throw new AppError('PATH_INVALID', 'The target manifest references a file outside the model directory.');
      }
    } catch (error) {
      addError(blockingIssues, error, reference.path);
      continue;
    }
    if (plannedTargetPaths.has(path)) continue;
    try {
      const revision = await streamedTargetRevision(project.root, path, directory);
      if (revision === null) {
        blockingIssues.push({ code: 'DEPENDENCY_MISSING', path });
      } else {
        targetReferences.set(path, { path, revision });
      }
    } catch (error) {
      addError(blockingIssues, error, path);
    }
  }
  if (manifest.changed) {
    if (manifest.bytes.byteLength > WRITE_LIMITS.maxFileBytes) {
      blockingIssues.push({ code: 'FILE_TOO_LARGE', path: targetModelPath });
    } else {
      const entryChange: InlineChange = {
        path: targetModelPath,
        expectedRevision: targetRevision,
        bytes: manifest.bytes,
      };
      logicalChanges.push(entryChange);
      changes.push(entryChange);
    }
  } else if (targetDocument && changes.length === 0) {
    return {
      projectId: input.projectId,
      mode: 'curated',
      modelTargetPath: targetModelPath,
      ...publicReport(report),
      paths: [],
      files: [],
      totalBytes: 0,
      blockingIssues,
      bundleRevision: null,
      motions: manifest.motions,
      expressions: manifest.expressions,
      gameEntry,
      batch: { index: 0, total: 0, entryIncluded: false, nextBatchIndex: null },
      noOp: blockingIssues.length === 0,
      committable: false,
      planId: null,
    };
  }
  const sortChanges = (items: ImportChange[]) => items.sort((left, right) => {
    if (left.path === targetModelPath) return 1;
    if (right.path === targetModelPath) return -1;
    return left.path.localeCompare(right.path);
  });
  sortChanges(logicalChanges);
  sortChanges(changes);
  const batches = splitOperations(logicalChanges);
  const bundleRevision = createHash('sha256').update(JSON.stringify({
    projectId: input.projectId,
    sourceId: input.sourceId,
    sourceModelPath: input.modelPath,
    sourceRootPath: rootPath,
    sourceRevision: report.revision,
    files: plannedSources,
    targetModelPath,
    targetRevision,
    targetReferences: [...targetReferences.values()],
    sourcePaths,
    motions: manifest.motions,
    expressions: manifest.expressions,
    manifestRevision,
  })).digest('hex');
  if (input.sessionId !== undefined && input.expectedBundleRevision === undefined) {
    throw new AppError('INVALID_ARGUMENT', 'Review a draft and provide its bundleRevision before making a committable plan.');
  }
  if (input.sessionId !== undefined && bundleRevision !== input.expectedBundleRevision) {
    throw new AppError('SOURCE_CHANGED', 'The reviewed model selection no longer matches. Generate and review a new draft.');
  }
  const changedPaths = new Set(changes.map(change => change.path));
  const nonEmptyBatchIndices = batches.flatMap((batch, index) => (
    batch.some(change => changedPaths.has(change.path)) ? [index] : []
  ));
  const batchIndex = input.batchIndex ?? nonEmptyBatchIndices[0] ?? 0;
  if (!Number.isSafeInteger(batchIndex) || batchIndex < 0 || batchIndex >= batches.length) {
    addError(blockingIssues, new AppError('INVALID_ARGUMENT', 'The model batch index is outside the current plan.'));
  }
  if (batchIndex > 0 && input.previousPlanId === undefined
    && nonEmptyBatchIndices.some(index => index < batchIndex)) {
    blockingIssues.push({ code: 'HANDOFF_REQUIRED' });
  }
  const skippedBatchIndices = batches.flatMap((batch, index) => (
    index < batchIndex && !batch.some(change => changedPaths.has(change.path)) ? [index] : []
  ));
  const nextBatchIndex = nonEmptyBatchIndices.find(index => index > batchIndex) ?? null;
  const selectedLogical = blockingIssues.length ? [] : batches[batchIndex] ?? [];
  const selectedPaths = new Set(selectedLogical.map(change => change.path));
  const selected = blockingIssues.length
    ? []
    : changes.filter(change => selectedPaths.has(change.path));
  const entryIncluded = selected.some(change => change.path === targetModelPath);
  const sourceMappings: ModelSourceMapping[] = selected
    .filter((change): change is SourceChange => 'source' in change)
    .map(change => ({
      targetRelativePath: change.path.slice(directory.length + 1),
      sourceRelativePath: packageRelativePath(rootPath, change.source.path),
    }))
    .sort((left, right) => left.targetRelativePath.localeCompare(right.targetRelativePath));
  let plan: WritePlan | null = null;
  if (!blockingIssues.length && selected.length) {
    try {
      const directories = await directoryExpectations(project.root, selected, directory);
      const mode: 'create' | 'update' = directories.find(item => item.path === directory)?.state === 'create'
        ? 'create'
        : 'update';
      if (mode === 'create' && input.previousPlanId !== undefined && targetAssembly !== null) {
        throw new AppError('FILE_CHANGED', 'The model directory was created outside the reviewed continuation.');
      }
      const model: ModelBundle = {
        directory,
        modelPath: targetModelPath,
        mode,
        directories,
        sourceId: input.sourceId,
        sourceRootPath: rootPath,
        bundleRevision,
        batchIndex,
        batchCount: batches.length,
        ...(skippedBatchIndices.length ? { skippedBatchIndices } : {}),
        ...(input.previousPlanId ? { previousPlanId: input.previousPlanId } : {}),
        entryIncluded,
        ...(sourceMappings.length ? { sourceMappings } : {}),
        ...(entryIncluded ? {
          dependencies: plannedSources
            .map(({ path, revision }) => ({ path, revision }))
            .sort((left, right) => left.path.localeCompare(right.path)),
        } : {}),
        ...(!entryIncluded && targetRevision !== null ? { targetEntryRevision: targetRevision } : {}),
        ...(targetReferences.size ? {
          targetReferences: [...targetReferences.values()]
            .sort((left, right) => left.path.localeCompare(right.path)),
        } : {}),
      };
      if (input.sessionId !== undefined) plan = await persist(input.sessionId, selected, model);
    } catch (error) {
      addError(blockingIssues, error);
    }
  }
  return {
    projectId: input.projectId,
    mode: 'curated',
    modelTargetPath: targetModelPath,
    ...publicReport(report),
    paths: selected.map(change => change.path),
    files: selected.map(change => 'source' in change
      ? { path: change.path, bytes: change.source.bytes, revision: change.source.revision }
      : { path: change.path, bytes: change.bytes.byteLength, revision: createHash('sha256').update(change.bytes).digest('hex') }),
    totalBytes: selected.reduce((total, change) => total + operationBytes(change), 0),
    blockingIssues,
    bundleRevision: blockingIssues.length ? null : bundleRevision,
    motions: manifest.motions,
    expressions: manifest.expressions,
    gameEntry,
    batch: {
      index: batchIndex,
      total: batches.length,
      entryIncluded,
      nextBatchIndex,
    },
    noOp: blockingIssues.length === 0 && selected.length === 0,
    committable: plan !== null,
    planId: plan?.id ?? null,
    ...(plan ? { expiresAt: plan.expiresAt } : {}),
  };
}

export async function planLive2dImport(
  config: AppConfig,
  input: ImportRequest,
  persist: Persist,
): Promise<ImportReview> {
  const directory = checkedModelDirectory(`game/figure/${input.targetDirectory}`);
  if ((input.mode ?? 'bundle') === 'bundle') {
    if (input.motions?.length || input.expressions?.length || input.batchIndex !== undefined || input.previousPlanId) {
      throw new AppError('INVALID_ARGUMENT', 'Use mode "curated" for selections and incremental model batches.');
    }
    return legacyBundle(config, input, directory, persist);
  }
  return curatedImport(config, input, directory, persist);
}
