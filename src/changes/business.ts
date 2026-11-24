import { createHash } from 'node:crypto';
import { stat } from 'node:fs/promises';
import { TextDecoder } from 'node:util';
import { z } from 'zod';
import { analyzeScene, parseGameConfig, type Diagnostic } from '../analysis.js';
import { describeAssetSource, readSource } from '../assets/source.js';
import { getProject } from '../config.js';
import { editGameConfig, type ConfigUpdate } from '../edits/config.js';
import { applySceneEdits, createScene, type TextEdit } from '../edits/scenes.js';
import { AppError } from '../errors.js';
import { resolveSafe, validateRelativePath } from '../filesystem.js';
import type { AppConfig, ProjectConfig } from '../types.js';
import type { WriteCoordinator } from './coordinator.js';
import { assertCreateTargetAbsent, assertReferenceableTarget, snapshotTarget, supportsOrdinaryAssetStreaming } from './targets.js';
import {
  LARGE_ASSET_LIMITS,
  WRITE_LIMITS,
  type ApplyResult,
  type CoordinatorChange,
  type SourceRevision,
  type WritePlan
} from './types.js';

export type BusinessAssetKind = 'background' | 'figure' | 'bgm' | 'vocal' | 'video';

export type BusinessOperation =
  | { type: 'create_scene'; path: string; text: string }
  | { type: 'edit_scene'; path: string; expectedRevision: string; edits: TextEdit[] }
  | { type: 'edit_config'; expectedRevision: string; updates: ConfigUpdate[] }
  | {
    type: 'import_asset';
    kind: BusinessAssetKind;
    path: string;
    sourceId: string;
    sourcePath: string;
    expectedSourceRevision: string;
  };

export interface BusinessReviewOperation {
  type: BusinessOperation['type'];
  path: string;
  beforeRevision: string | null;
  afterRevision: string;
  bytes: number;
  beforeText?: string;
  afterText?: string;
  textTruncated?: boolean;
  diff?: {
    start: number;
    before: string;
    after: string;
    truncated: boolean;
  };
  kind?: BusinessAssetKind;
  sourceId?: string;
  sourcePath?: string;
  sourceRevision?: string;
}

export interface BusinessReviewDiagnostic extends Diagnostic {
  path: string;
}

export interface BusinessReview {
  committable: boolean;
  planId: string | null;
  projectId: string;
  sessionId: string | null;
  operations: BusinessReviewOperation[];
  diagnostics: BusinessReviewDiagnostic[];
  diagnosticsTruncated: boolean;
}

export interface BusinessApplyResult {
  batchId: string;
  status: ApplyResult['status'];
  replayed: boolean;
  errorCode?: string;
  warnings?: string[];
  operations: Array<{
    path: string;
    beforeRevision: string | null;
    afterRevision: string;
    phase: 'pending' | 'intent' | 'applied';
    backupId?: string;
  }>;
}

export interface BusinessEndResult {
  sessionId: string;
  ended: true;
}

const revisionSchema = z.string().regex(/^[a-f0-9]{64}$/);
const textEditSchema = z.object({
  start: z.number().int().nonnegative(),
  end: z.number().int().nonnegative(),
  text: z.string().max(WRITE_LIMITS.maxFileBytes)
}).strict();
const configUpdateSchema = z.object({
  key: z.string().min(1).max(128),
  value: z.string().max(WRITE_LIMITS.maxFileBytes)
}).strict();
const businessOperationSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('create_scene'),
    path: z.string().min(1).max(1024),
    text: z.string().max(WRITE_LIMITS.maxFileBytes)
  }).strict(),
  z.object({
    type: z.literal('edit_scene'),
    path: z.string().min(1).max(1024),
    expectedRevision: revisionSchema,
    edits: z.array(textEditSchema).min(1).max(1000)
  }).strict(),
  z.object({
    type: z.literal('edit_config'),
    expectedRevision: revisionSchema,
    updates: z.array(configUpdateSchema).min(1).max(64)
  }).strict(),
  z.object({
    type: z.literal('import_asset'),
    kind: z.enum(['background', 'figure', 'bgm', 'vocal', 'video']),
    path: z.string().min(1).max(1024),
    sourceId: z.string().min(1).max(128),
    sourcePath: z.string().min(1).max(4096),
    expectedSourceRevision: revisionSchema
  }).strict()
]);

const REVIEW_PREVIEW_CHARS = 1024;
const REVIEW_DIFF_CHARS = 1024;
const REVIEW_DIAGNOSTIC_LIMIT = 100;
const BOM = Buffer.from([0xef, 0xbb, 0xbf]);
const OPERATION_RANK: Record<BusinessOperation['type'], number> = {
  import_asset: 0,
  create_scene: 1,
  edit_scene: 2,
  edit_config: 3
};

function invalidArgument(message: string): never {
  throw new AppError('INVALID_ARGUMENT', message);
}

function hash(bytes: Uint8Array | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function casefold(value: string): string {
  return process.platform === 'win32' ? value.toLowerCase() : value;
}

function boundedText(text: string, maximum: number): { text: string; truncated: boolean } {
  if (text.length <= maximum) {
    return { text, truncated: false };
  }
  let end = maximum;
  const previous = text.charCodeAt(end - 1);
  const current = text.charCodeAt(end);
  if (previous >= 0xd800 && previous <= 0xdbff
    && current >= 0xdc00 && current <= 0xdfff) {
    end -= 1;
  }
  return { text: text.slice(0, end), truncated: true };
}

function splitsSurrogatePair(text: string, index: number): boolean {
  if (index <= 0 || index >= text.length) {
    return false;
  }
  const previous = text.charCodeAt(index - 1);
  const current = text.charCodeAt(index);
  return previous >= 0xd800 && previous <= 0xdbff
    && current >= 0xdc00 && current <= 0xdfff;
}

function boundedDiff(
  before: string,
  after: string
): { start: number; before: string; after: string; truncated: boolean } {
  let start = 0;
  const commonLength = Math.min(before.length, after.length);
  while (start < commonLength
    && before.charCodeAt(start) === after.charCodeAt(start)) {
    start += 1;
  }
  if (splitsSurrogatePair(before, start) || splitsSurrogatePair(after, start)) {
    start -= 1;
  }

  let beforeEnd = before.length;
  let afterEnd = after.length;
  while (beforeEnd > start
    && afterEnd > start
    && before.charCodeAt(beforeEnd - 1) === after.charCodeAt(afterEnd - 1)) {
    beforeEnd -= 1;
    afterEnd -= 1;
  }
  if (splitsSurrogatePair(before, beforeEnd)) {
    beforeEnd += 1;
  }
  if (splitsSurrogatePair(after, afterEnd)) {
    afterEnd += 1;
  }

  const beforeChange = before.slice(start, beforeEnd);
  const afterChange = after.slice(start, afterEnd);
  const boundedBefore = boundedText(beforeChange, REVIEW_DIFF_CHARS);
  const boundedAfter = boundedText(afterChange, REVIEW_DIFF_CHARS);
  return {
    start,
    before: boundedBefore.text,
    after: boundedAfter.text,
    truncated: boundedBefore.truncated || boundedAfter.truncated
  };
}

function decodeText(bytes: Uint8Array): string {
  const buffer = Buffer.from(bytes);
  const content = buffer.length >= 3
    && buffer[0] === BOM[0]
    && buffer[1] === BOM[1]
    && buffer[2] === BOM[2]
    ? buffer.subarray(3)
    : buffer;
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(content);
  } catch {
    throw new AppError('UNSUPPORTED_FORMAT', 'The target is not valid UTF-8 text.');
  }
}

function sceneTarget(relative: string): string {
  const validated = validateRelativePath(relative);
  const folded = validated.toLowerCase();
  if (validated === ''
    || folded.startsWith('game/')
    || !folded.endsWith('.txt')) {
    invalidArgument('Scene paths must be relative .txt paths without a game/ prefix.');
  }
  return assertReferenceableTarget('game/scene/' + validated);
}

function assetTarget(kind: BusinessAssetKind, relative: string): string {
  const validated = validateRelativePath(relative);
  if (validated === '' || validated.toLowerCase().startsWith('game/')) {
    invalidArgument('Asset paths must be relative paths without a game/ prefix.');
  }
  return assertReferenceableTarget('game/' + kind + '/' + validated);
}

function targetPath(operation: BusinessOperation): string {
  switch (operation.type) {
    case 'create_scene':
    case 'edit_scene':
      return sceneTarget(operation.path);
    case 'edit_config':
      return 'game/config.txt';
    case 'import_asset':
      return assetTarget(operation.kind, operation.path);
  }
}

function orderedOperations(operations: BusinessOperation[]): BusinessOperation[] {
  return operations
    .map((operation, index) => ({ operation, index }))
    .sort((left, right) => (
      OPERATION_RANK[left.operation.type] - OPERATION_RANK[right.operation.type]
      || left.index - right.index
    ))
    .map((entry) => entry.operation);
}

async function assertProjectLayout(project: ProjectConfig): Promise<void> {
  const sceneDirectory = await resolveSafe(project.root, 'game/scene');
  const sceneStat = await stat(sceneDirectory);
  if (!sceneStat.isDirectory()) {
    throw new AppError('FILE_NOT_DIRECTORY', 'The project scene directory is not a directory.');
  }
  const configPath = await resolveSafe(project.root, 'game/config.txt');
  const configStat = await stat(configPath);
  if (!configStat.isFile()) {
    throw new AppError('FILE_NOT_REGULAR', 'The project config.txt is not a regular file.');
  }
}

async function projectFileExists(project: ProjectConfig, relative: string): Promise<boolean> {
  try {
    const target = await resolveSafe(project.root, relative);
    return (await stat(target)).isFile();
  } catch (error) {
    if (error instanceof AppError && error.code === 'FILE_NOT_FOUND') {
      return false;
    }
    throw error;
  }
}

function reviewDiagnostics(
  path: string,
  diagnostics: Diagnostic[]
): BusinessReviewDiagnostic[] {
  return diagnostics.map((diagnostic) => ({ path, ...diagnostic }));
}

function addReviewText(
  review: BusinessReviewOperation,
  beforeText: string | undefined,
  afterText: string | undefined
): void {
  if (beforeText !== undefined) {
    const before = boundedText(beforeText, REVIEW_PREVIEW_CHARS);
    review.beforeText = before.text;
    review.textTruncated = before.truncated;
  }
  if (afterText !== undefined) {
    const after = boundedText(afterText, REVIEW_PREVIEW_CHARS);
    review.afterText = after.text;
    review.textTruncated = Boolean(review.textTruncated || after.truncated);
  }
  if (beforeText !== undefined && afterText !== undefined) {
    review.diff = boundedDiff(beforeText, afterText);
  }
}

export class BusinessWriteService {
  private readonly config: AppConfig;
  private readonly coordinator: WriteCoordinator;
  private readonly ownerId: string;

  constructor(config: AppConfig, coordinator: WriteCoordinator, ownerId: string) {
    if (typeof ownerId !== 'string' || ownerId.trim() === '') {
      invalidArgument('ownerId must be a non-empty string.');
    }
    this.config = structuredClone(config);
    this.coordinator = coordinator;
    this.ownerId = ownerId;
  }

  async plan(
    projectId: string,
    sessionId: string | undefined,
    operations: BusinessOperation[]
  ): Promise<BusinessReview> {
    if (typeof projectId !== 'string' || projectId === '') {
      invalidArgument('projectId must be a non-empty string.');
    }
    if (sessionId !== undefined && (typeof sessionId !== 'string' || sessionId === '')) {
      invalidArgument('sessionId must be a non-empty string when provided.');
    }
    const parsed = businessOperationSchema.array()
      .min(1)
      .max(WRITE_LIMITS.maxFiles)
      .safeParse(operations);
    if (!parsed.success) {
      invalidArgument('Business operations are invalid.');
    }

    const project = getProject(this.config, projectId);
    await assertProjectLayout(project);
    const normalized = orderedOperations(parsed.data as BusinessOperation[]);
    const plannedTargets = new Set(
      normalized
        .filter((operation) => (
          operation.type === 'create_scene' || operation.type === 'import_asset'
        ))
        .map((operation) => casefold(targetPath(operation)))
    );
    const plannedExists = (relative: string): Promise<boolean> => (
      plannedTargets.has(casefold(relative))
        ? Promise.resolve(true)
        : projectFileExists(project, relative)
    );
    const seenTargets = new Set<string>();
    const changes: CoordinatorChange[] = [];
    const sourceRevisions: SourceRevision[] = [];
    const reviewOperations: BusinessReviewOperation[] = [];
    const diagnostics: BusinessReviewDiagnostic[] = [];
    let totalBytes = 0;
    let streamedBytes = 0;

    for (const operation of normalized) {
      const path = targetPath(operation);
      const identity = casefold(path);
      if (seenTargets.has(identity)) {
        throw new AppError('TARGET_COLLISION', 'A batch cannot contain duplicate target paths.');
      }
      seenTargets.add(identity);

      if (operation.type === 'import_asset') {
        const sourcePath = validateRelativePath(operation.sourcePath);
        if (sourcePath === '') {
          invalidArgument('Asset source paths must be non-empty relative paths.');
        }
        const description = await describeAssetSource(this.config, operation.sourceId, sourcePath);
        if (description.revision !== operation.expectedSourceRevision) {
          throw new AppError('SOURCE_CHANGED', 'An asset source changed after it was reviewed.');
        }
        const sourceIdentity: SourceRevision = {
          sourceId: operation.sourceId,
          path: sourcePath,
          revision: description.revision,
          rootKey: description.rootKey,
        };
        if (description.bytes > WRITE_LIMITS.maxFileBytes) {
          if (!supportsOrdinaryAssetStreaming(path)) {
            throw new AppError('FILE_TOO_LARGE', 'Figure JSON exceeds the 1 MiB limit for ordinary imports.');
          }
          streamedBytes += description.bytes;
          if (streamedBytes > LARGE_ASSET_LIMITS.maxBatchBytes) {
            throw new AppError('LIMIT_EXCEEDED', 'Large assets exceed the streaming batch limit.');
          }
          await assertCreateTargetAbsent(project.root, path);
          changes.push({ path, expectedRevision: null, source: { ...sourceIdentity, bytes: description.bytes } });
        } else {
          const source = await readSource(this.config, operation.sourceId, sourcePath);
          if (source.revision !== description.revision || source.rootKey !== description.rootKey) {
            throw new AppError('SOURCE_CHANGED', 'An asset source changed after it was reviewed.');
          }
          const current = await snapshotTarget(project.root, path);
          if (current.revision !== null) {
            throw new AppError('TARGET_EXISTS', 'The imported asset target already exists.');
          }
          totalBytes += source.bytes.byteLength;
          changes.push({ path, expectedRevision: null, bytes: source.bytes });
          sourceRevisions.push(sourceIdentity);
        }
        reviewOperations.push({
          type: operation.type,
          path,
          beforeRevision: null,
          afterRevision: description.revision,
          bytes: description.bytes,
          kind: operation.kind,
          sourceId: operation.sourceId,
          sourcePath,
          sourceRevision: description.revision
        });
        continue;
      }

      if (operation.type === 'create_scene') {
        const current = await snapshotTarget(project.root, path);
        if (current.revision !== null) {
          throw new AppError('TARGET_EXISTS', 'The scene target already exists.');
        }
        const bytes = createScene(operation.text);
        totalBytes += bytes.byteLength;
        changes.push({ path, expectedRevision: null, bytes });
        const analysis = await analyzeScene(
          operation.text,
          operation.path,
          plannedExists
        );
        diagnostics.push(...reviewDiagnostics(path, analysis.diagnostics));
        const review: BusinessReviewOperation = {
          type: operation.type,
          path,
          beforeRevision: null,
          afterRevision: hash(bytes),
          bytes: bytes.byteLength
        };
        addReviewText(review, undefined, operation.text);
        reviewOperations.push(review);
        continue;
      }

      if (operation.type === 'edit_scene') {
        const current = await snapshotTarget(project.root, path);
        if (current.revision === null || current.revision !== operation.expectedRevision) {
          throw new AppError('REVISION_CONFLICT', 'The scene revision no longer matches.');
        }
        const beforeText = decodeText(current.bytes as Buffer);
        const bytes = applySceneEdits(current.bytes as Buffer, operation.edits);
        const afterText = decodeText(bytes);
        totalBytes += bytes.byteLength;
        changes.push({ path, expectedRevision: current.revision, bytes });
        const analysis = await analyzeScene(
          afterText,
          operation.path,
          plannedExists
        );
        diagnostics.push(...reviewDiagnostics(path, analysis.diagnostics));
        const review: BusinessReviewOperation = {
          type: operation.type,
          path,
          beforeRevision: current.revision,
          afterRevision: hash(bytes),
          bytes: bytes.byteLength
        };
        addReviewText(review, beforeText, afterText);
        reviewOperations.push(review);
        continue;
      }

      const current = await snapshotTarget(project.root, path);
      if (current.revision === null || current.revision !== operation.expectedRevision) {
        throw new AppError('REVISION_CONFLICT', 'The config revision no longer matches.');
      }
      const beforeText = decodeText(current.bytes as Buffer);
      const bytes = editGameConfig(current.bytes as Buffer, operation.updates);
      const afterText = decodeText(bytes);
      totalBytes += bytes.byteLength;
      changes.push({ path, expectedRevision: current.revision, bytes });
      diagnostics.push(...reviewDiagnostics(path, parseGameConfig(afterText).diagnostics));
      const review: BusinessReviewOperation = {
        type: operation.type,
        path,
        beforeRevision: current.revision,
        afterRevision: hash(bytes),
        bytes: bytes.byteLength
      };
      addReviewText(review, beforeText, afterText);
      reviewOperations.push(review);
    }

    if (totalBytes > WRITE_LIMITS.maxBatchBytes) {
      throw new AppError('LIMIT_EXCEEDED', 'The business batch exceeds the configured byte limit.');
    }
    for (const change of changes) {
      if ('bytes' in change && change.bytes.byteLength > WRITE_LIMITS.maxFileBytes) {
        throw new AppError('FILE_TOO_LARGE', 'A business operation exceeds the file size limit.');
      }
    }

    if (sessionId !== undefined) {
      this.coordinator.sessions.require(
        sessionId,
        this.ownerId,
        projectId,
        changes.map((change) => change.path)
      );
    }

    let plan: WritePlan | null = null;
    if (sessionId !== undefined) {
      plan = await this.coordinator.plan(
        this.ownerId,
        sessionId,
        projectId,
        changes,
        undefined,
        sourceRevisions.length > 0 ? sourceRevisions : undefined
      );
    }

    const boundedDiagnostics = diagnostics.slice(0, REVIEW_DIAGNOSTIC_LIMIT);
    return {
      committable: sessionId !== undefined,
      planId: plan?.id ?? null,
      projectId,
      sessionId: sessionId ?? null,
      operations: reviewOperations,
      diagnostics: boundedDiagnostics,
      diagnosticsTruncated: diagnostics.length > boundedDiagnostics.length
    };
  }

  async apply(sessionId: string, planId: string, key: string): Promise<BusinessApplyResult> {
    if (typeof sessionId !== 'string' || sessionId === '') {
      invalidArgument('sessionId must be a non-empty string.');
    }
    if (typeof planId !== 'string' || planId === '') {
      invalidArgument('planId must be a non-empty string.');
    }
    if (typeof key !== 'string' || key === '') {
      invalidArgument('An idempotency key is required.');
    }

    const result = await this.coordinator.apply(this.ownerId, sessionId, planId, key);
    return {
      batchId: result.batchId,
      status: result.status,
      replayed: result.replayed,
      ...(result.errorCode ? { errorCode: result.errorCode } : {}),
      ...(result.warnings ? { warnings: [...result.warnings] } : {}),
      operations: result.operations.map((operation, index) => ({
        path: operation.path,
        beforeRevision: operation.expectedRevision,
        afterRevision: operation.newRevision,
        phase: operation.phase,
        ...(operation.backup ? { backupId: result.batchId + ':' + index } : {})
      }))
    };
  }

  end(sessionId: string): BusinessEndResult {
    if (typeof sessionId !== 'string' || sessionId === '') {
      invalidArgument('sessionId must be a non-empty string.');
    }
    this.coordinator.sessions.end(sessionId, this.ownerId);
    return { sessionId, ended: true };
  }
}
