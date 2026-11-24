import { execFile } from 'node:child_process';
import type { BigIntStats } from 'node:fs';
import {
  link,
  lstat,
  mkdir,
  open,
  realpath,
  rename,
  unlink
} from 'node:fs/promises';
import { createHash } from 'node:crypto';
import * as path from 'node:path';
import { promisify } from 'node:util';
import { AppError } from '../errors.js';
import { resolveSafe, validateRelativePath } from '../filesystem.js';
import { LARGE_ASSET_LIMITS, WRITE_LIMITS } from './types.js';

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const REVISION_PATTERN = /^[0-9a-f]{64}$/i;
const ASSET_DIRECTORIES = new Set([
  'background',
  'figure',
  'bgm',
  'vocal',
  'video'
]);
const STREAMED_ASSET_DIRECTORIES = new Set(['background', 'bgm']);
const STREAMED_REVISION_MAX_BYTES = 16 * 1024 * 1024;

interface WritePolicy {
  create: boolean;
  replace: boolean;
}

interface TargetContext {
  requestedRoot: string;
  canonicalRoot: string;
  rootIdentity: BigIntStats;
  parent: string;
  parentIdentity: BigIntStats;
  parentRelative: string;
  target: string;
}

interface FileSnapshot {
  revision: string;
  bytes: Buffer;
}

interface StreamedFileSnapshot {
  revision: string;
  bytes: number;
}

type CleanupResult = 'removed' | 'missing' | 'not-owned';

function fail(code: string, message: string): never {
  throw new AppError(code, message);
}

function isNodeError(error: unknown, codes: string[]): boolean {
  if (typeof error !== 'object' || error === null || !('code' in error)) {
    return false;
  }
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' && codes.includes(code);
}

function casefoldForPlatform(value: string): string {
  return process.platform === 'win32' ? value.toLowerCase() : value;
}

function samePath(left: string, right: string): boolean {
  return casefoldForPlatform(path.resolve(left))
    === casefoldForPlatform(path.resolve(right));
}

function isWithinRoot(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  const comparable = casefoldForPlatform(relative);
  return comparable === ''
    || (!path.isAbsolute(relative)
      && comparable !== '..'
      && !comparable.startsWith(`..${path.sep}`));
}

function sameFileIdentity(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.birthtimeNs === right.birthtimeNs;
}

function snapshotMatches(before: BigIntStats, after: BigIntStats): boolean {
  return sameFileIdentity(before, after)
    && before.size === after.size
    && before.mtimeNs === after.mtimeNs
    && before.ctimeNs === after.ctimeNs;
}

function parentRelative(relative: string): string {
  const parent = path.posix.dirname(relative);
  return parent === '.' ? '' : parent;
}

function policyFor(relative: string): WritePolicy {
  if (typeof relative !== 'string' || relative === '') {
    fail('PATH_INVALID', 'The write path is invalid.');
  }

  const validated = validateRelativePath(relative);
  const segments = validated.split('/');
  if (segments.some((segment) => segment.startsWith('.'))) {
    fail('PATH_INVALID', 'Hidden path segments are not allowed.');
  }

  if (validated === 'game/config.txt') {
    return { create: false, replace: true };
  }
  if (validated.startsWith('game/scene/')
    && validated.endsWith('.txt')
    && validated.length > 'game/scene/.txt'.length) {
    return { create: true, replace: true };
  }

  const assetMatch = /^game\/([^/]+)\/(.+)$/.exec(validated);
  if (assetMatch
    && ASSET_DIRECTORIES.has(assetMatch[1] as string)
    && (assetMatch[2] as string) !== '') {
    return { create: true, replace: false };
  }

  fail('PATH_INVALID', 'The path is outside the supported WebGAL write targets.');
}

function normalizeBatchId(batchId: string): string {
  if (typeof batchId !== 'string' || !UUID_PATTERN.test(batchId)) {
    fail('INVALID_ARGUMENT', 'The batch identifier must be a UUID.');
  }
  return batchId.toLowerCase();
}

function normalizeIndex(index: number): number {
  if (!Number.isSafeInteger(index) || index < 0 || index >= WRITE_LIMITS.maxFiles) {
    fail(
      'INVALID_ARGUMENT',
      `The operation index must be an integer from 0 to ${WRITE_LIMITS.maxFiles - 1}.`
    );
  }
  return index;
}

function normalizeRevision(expectedRevision: string | null): string | null {
  if (expectedRevision === null) {
    return null;
  }
  if (typeof expectedRevision !== 'string' || !REVISION_PATTERN.test(expectedRevision)) {
    fail('INVALID_ARGUMENT', 'The expected revision must be a SHA-256 hash or null.');
  }
  return expectedRevision.toLowerCase();
}

function streamedAssetPath(relative: string, modelDirectory?: string): string {
  const validated = assertWritePath(relative, true);
  if (modelDirectory !== undefined && validated.startsWith(`${checkedModelDirectory(modelDirectory)}/`)) {
    return validated;
  }
  const match = /^game\/([^/]+)\/(.+)$/.exec(validated);
  if (!match || !STREAMED_ASSET_DIRECTORIES.has(match[1] as string)) {
    fail(
      'PATH_INVALID',
      'Streamed assets are supported only under game/background and game/bgm.'
    );
  }
  return validated;
}

function normalizeStreamedExpectation(
  expected: { bytes: number; revision: string }
): { bytes: number; revision: string } {
  if (typeof expected !== 'object' || expected === null) {
    fail('INVALID_ARGUMENT', 'The expected streamed asset metadata is invalid.');
  }
  if (!Number.isSafeInteger(expected.bytes) || expected.bytes < 0) {
    fail('INVALID_ARGUMENT', 'The expected byte count must be a non-negative integer.');
  }
  if (expected.bytes > LARGE_ASSET_LIMITS.maxFileBytes
    || expected.bytes > LARGE_ASSET_LIMITS.maxBatchBytes) {
    fail('FILE_TOO_LARGE', 'The streamed asset exceeds the configured size limit.');
  }
  if (typeof expected.revision !== 'string'
    || !REVISION_PATTERN.test(expected.revision)) {
    fail('INVALID_ARGUMENT', 'The expected revision must be a SHA-256 hash.');
  }
  return {
    bytes: expected.bytes,
    revision: expected.revision.toLowerCase()
  };
}

function streamChunkBytes(): number {
  const maximum = LARGE_ASSET_LIMITS.chunkBytes;
  if (!Number.isSafeInteger(maximum) || maximum <= 0) {
    fail('WRITE_FAILED', 'The streamed asset chunk limit is invalid.');
  }
  return maximum;
}

function mapPathInspectionError(error: unknown): never {
  if (error instanceof AppError) {
    throw error;
  }
  if (isNodeError(error, ['ENOENT'])) {
    fail('FILE_NOT_FOUND', 'The requested file or directory was not found.');
  }
  if (isNodeError(error, ['ENOTDIR'])) {
    fail('FILE_NOT_DIRECTORY', 'A path component is not a directory.');
  }
  if (isNodeError(error, ['ELOOP'])) {
    fail('PATH_INVALID', 'Symbolic links are not allowed in write paths.');
  }
  if (isNodeError(error, ['EACCES', 'EPERM'])) {
    fail('FILE_NOT_READABLE', 'The requested path could not be inspected.');
  }
  fail('FILE_READ_FAILED', 'The requested path could not be inspected.');
}

async function assertNoSymlinkSegments(
  canonicalRoot: string,
  relative: string
): Promise<void> {
  if (relative === '') {
    return;
  }

  let current = canonicalRoot;
  for (const segment of relative.split('/')) {
    current = path.join(current, segment);
    let entryStat: BigIntStats;
    try {
      entryStat = await lstat(current, { bigint: true });
    } catch (error) {
      mapPathInspectionError(error);
    }
    if (entryStat.isSymbolicLink()) {
      fail('PATH_INVALID', 'Symbolic links are not allowed in write paths.');
    }
    if (!entryStat.isDirectory()) {
      fail('FILE_NOT_DIRECTORY', 'A path component is not a directory.');
    }
  }
}

async function readRootIdentity(root: string): Promise<{
  canonicalRoot: string;
  identity: BigIntStats;
}> {
  const canonicalRoot = await resolveSafe(root, '');
  let identity: BigIntStats;
  try {
    identity = await lstat(canonicalRoot, { bigint: true });
  } catch (error) {
    mapPathInspectionError(error);
  }
  if (identity.isSymbolicLink() || !identity.isDirectory()) {
    fail('PROJECT_NOT_AUTHORIZED', 'The project root is not a canonical directory.');
  }
  return { canonicalRoot, identity };
}

async function assertContextUnchanged(context: TargetContext): Promise<void> {
  const currentRoot = await readRootIdentity(context.requestedRoot);
  if (!samePath(currentRoot.canonicalRoot, context.canonicalRoot)
    || !sameFileIdentity(currentRoot.identity, context.rootIdentity)) {
    fail('PROJECT_NOT_AUTHORIZED', 'The authorized project root was replaced.');
  }

  await assertNoSymlinkSegments(context.canonicalRoot, context.parentRelative);

  let currentParent: BigIntStats;
  try {
    currentParent = await lstat(context.parent, { bigint: true });
  } catch (error) {
    mapPathInspectionError(error);
  }
  if (currentParent.isSymbolicLink()) {
    fail('PATH_INVALID', 'Symbolic links are not allowed in write paths.');
  }
  if (!currentParent.isDirectory()) {
    fail('FILE_NOT_DIRECTORY', 'The target parent is not a directory.');
  }
  if (!sameFileIdentity(currentParent, context.parentIdentity)) {
    fail('FILE_CHANGED', 'The target parent changed while the operation was in progress.');
  }

  let canonicalParent: string;
  try {
    canonicalParent = await realpath(context.parent);
  } catch (error) {
    mapPathInspectionError(error);
  }
  if (!samePath(canonicalParent, context.parent)
    || !isWithinRoot(context.canonicalRoot, canonicalParent)) {
    fail('PATH_OUTSIDE_PROJECT', 'The target parent is outside the authorized root.');
  }
}

async function resolveTargetContext(root: string, relative: string): Promise<TargetContext> {
  policyFor(relative);
  const { canonicalRoot, identity: rootIdentity } = await readRootIdentity(root);
  const parentRel = parentRelative(relative);
  await assertNoSymlinkSegments(canonicalRoot, parentRel);

  const parent = await resolveSafe(canonicalRoot, parentRel);
  let parentIdentity: BigIntStats;
  try {
    parentIdentity = await lstat(parent, { bigint: true });
  } catch (error) {
    mapPathInspectionError(error);
  }
  if (parentIdentity.isSymbolicLink()) {
    fail('PATH_INVALID', 'Symbolic links are not allowed in write paths.');
  }
  if (!parentIdentity.isDirectory()) {
    fail('FILE_NOT_DIRECTORY', 'The target parent is not a directory.');
  }

  const target = path.join(parent, path.posix.basename(relative));
  if (!isWithinRoot(canonicalRoot, target)) {
    fail('PATH_OUTSIDE_PROJECT', 'The requested path is outside the authorized root.');
  }

  const context: TargetContext = {
    requestedRoot: root,
    canonicalRoot,
    rootIdentity,
    parent,
    parentIdentity,
    parentRelative: parentRel,
    target
  };
  await assertContextUnchanged(context);
  return context;
}

async function readBounded(
  handle: Awaited<ReturnType<typeof open>>,
  maximum: number
): Promise<Buffer> {
  const buffer = Buffer.allocUnsafe(maximum + 1);
  let offset = 0;
  while (offset < buffer.byteLength) {
    const result = await handle.read(
      buffer,
      offset,
      buffer.byteLength - offset,
      offset
    );
    if (result.bytesRead === 0) {
      break;
    }
    offset += result.bytesRead;
  }
  return buffer.subarray(0, offset);
}

async function readRegularFile(
  canonicalRoot: string,
  target: string,
  missingCode: 'FILE_NOT_FOUND' | 'FILE_CHANGED'
): Promise<FileSnapshot> {
  const pathBefore = await lstat(target, { bigint: true }).catch((error: unknown) => {
    if (isNodeError(error, ['ENOENT'])) {
      return fail(missingCode, 'The requested target was not found.');
    }
    return mapPathInspectionError(error);
  });
  if (pathBefore.isSymbolicLink()) {
    fail('PATH_INVALID', 'Symbolic links are not allowed in write paths.');
  }
  if (!pathBefore.isFile()) {
    fail('FILE_NOT_REGULAR', 'The requested target is not a regular file.');
  }
  if (pathBefore.size > BigInt(WRITE_LIMITS.maxFileBytes)) {
    fail('FILE_TOO_LARGE', 'The target exceeds the configured size limit.');
  }

  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(target, 'r');
    const before = await handle.stat({ bigint: true });
    if (!before.isFile()) {
      fail('FILE_NOT_REGULAR', 'The requested target is not a regular file.');
    }
    if (!snapshotMatches(pathBefore, before)) {
      fail('FILE_CHANGED', 'The target changed while it was being opened.');
    }
    if (before.size > BigInt(WRITE_LIMITS.maxFileBytes)) {
      fail('FILE_TOO_LARGE', 'The target exceeds the configured size limit.');
    }

    const canonicalTarget = await realpath(target);
    if (!samePath(canonicalTarget, target)
      || !isWithinRoot(canonicalRoot, canonicalTarget)) {
      fail('PATH_OUTSIDE_PROJECT', 'The target is outside the authorized root.');
    }

    const pathAfterOpen = await lstat(target, { bigint: true });
    if (pathAfterOpen.isSymbolicLink()
      || !pathAfterOpen.isFile()
      || !snapshotMatches(before, pathAfterOpen)) {
      fail('FILE_CHANGED', 'The target changed while it was being opened.');
    }

    const bytes = await readBounded(handle, WRITE_LIMITS.maxFileBytes);
    const after = await handle.stat({ bigint: true });
    const pathAfter = await lstat(target, { bigint: true }).catch((error: unknown) => {
      if (isNodeError(error, ['ENOENT', 'ENOTDIR'])) {
        return fail('FILE_CHANGED', 'The target changed while it was being read.');
      }
      return mapPathInspectionError(error);
    });

    if (pathAfter.isSymbolicLink()
      || !pathAfter.isFile()
      || !snapshotMatches(before, after)
      || !snapshotMatches(before, pathAfter)
      || BigInt(bytes.byteLength) !== after.size) {
      fail('FILE_CHANGED', 'The target changed while it was being read.');
    }
    if (bytes.byteLength > WRITE_LIMITS.maxFileBytes) {
      fail('FILE_TOO_LARGE', 'The target exceeds the configured size limit.');
    }

    return {
      revision: createHash('sha256').update(bytes).digest('hex'),
      bytes
    };
  } catch (error) {
    if (error instanceof AppError) {
      throw error;
    }
    if (isNodeError(error, ['ENOENT', 'ENOTDIR'])) {
      fail('FILE_CHANGED', 'The target changed while it was being read.');
    }
    if (isNodeError(error, ['EACCES', 'EPERM'])) {
      fail('FILE_NOT_READABLE', 'The target could not be read.');
    }
    if (isNodeError(error, ['EISDIR'])) {
      fail('FILE_NOT_REGULAR', 'The requested target is not a regular file.');
    }
    return fail('FILE_READ_FAILED', 'The target could not be read.');
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function hashRegularFile(
  canonicalRoot: string,
  target: string,
  maximum: number,
  missingCode: 'FILE_NOT_FOUND' | 'FILE_CHANGED'
): Promise<StreamedFileSnapshot> {
  const pathBefore = await lstat(target, { bigint: true }).catch((error: unknown) => {
    if (isNodeError(error, ['ENOENT'])) {
      return fail(missingCode, 'The requested target was not found.');
    }
    return mapPathInspectionError(error);
  });
  if (pathBefore.isSymbolicLink()) {
    fail('PATH_INVALID', 'Symbolic links are not allowed in write paths.');
  }
  if (!pathBefore.isFile()) {
    fail('FILE_NOT_REGULAR', 'The requested target is not a regular file.');
  }
  if (pathBefore.size > BigInt(maximum)) {
    fail('FILE_TOO_LARGE', 'The target exceeds the configured size limit.');
  }

  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(target, 'r');
    const before = await handle.stat({ bigint: true });
    if (!before.isFile()) {
      fail('FILE_NOT_REGULAR', 'The requested target is not a regular file.');
    }
    if (!snapshotMatches(pathBefore, before)) {
      fail('FILE_CHANGED', 'The target changed while it was being opened.');
    }
    if (before.size > BigInt(maximum)) {
      fail('FILE_TOO_LARGE', 'The target exceeds the configured size limit.');
    }

    const canonicalTarget = await realpath(target);
    if (!samePath(canonicalTarget, target)
      || !isWithinRoot(canonicalRoot, canonicalTarget)) {
      fail('PATH_OUTSIDE_PROJECT', 'The target is outside the authorized root.');
    }

    const pathAfterOpen = await lstat(target, { bigint: true });
    if (pathAfterOpen.isSymbolicLink()
      || !pathAfterOpen.isFile()
      || !snapshotMatches(before, pathAfterOpen)) {
      fail('FILE_CHANGED', 'The target changed while it was being opened.');
    }

    const digest = createHash('sha256');
    const buffer = Buffer.allocUnsafe(Math.min(streamChunkBytes(), 256 * 1024));
    let bytes = 0;
    while (bytes <= maximum) {
      const result = await handle.read(buffer, 0, buffer.byteLength, null);
      if (result.bytesRead === 0) {
        break;
      }
      bytes += result.bytesRead;
      if (bytes > maximum) {
        fail('FILE_TOO_LARGE', 'The target exceeds the configured size limit.');
      }
      digest.update(buffer.subarray(0, result.bytesRead));
    }

    const after = await handle.stat({ bigint: true });
    const pathAfter = await lstat(target, { bigint: true }).catch((error: unknown) => {
      if (isNodeError(error, ['ENOENT', 'ENOTDIR'])) {
        return fail('FILE_CHANGED', 'The target changed while it was being read.');
      }
      return mapPathInspectionError(error);
    });

    if (pathAfter.isSymbolicLink()
      || !pathAfter.isFile()
      || !snapshotMatches(before, after)
      || !snapshotMatches(before, pathAfter)
      || BigInt(bytes) !== after.size) {
      fail('FILE_CHANGED', 'The target changed while it was being read.');
    }
    if (bytes > maximum) {
      fail('FILE_TOO_LARGE', 'The target exceeds the configured size limit.');
    }

    return {
      revision: digest.digest('hex'),
      bytes
    };
  } catch (error) {
    if (error instanceof AppError) {
      throw error;
    }
    if (isNodeError(error, ['ENOENT', 'ENOTDIR'])) {
      fail('FILE_CHANGED', 'The target changed while it was being read.');
    }
    if (isNodeError(error, ['EACCES', 'EPERM'])) {
      fail('FILE_NOT_READABLE', 'The target could not be read.');
    }
    if (isNodeError(error, ['EISDIR'])) {
      fail('FILE_NOT_REGULAR', 'The requested target is not a regular file.');
    }
    return fail('FILE_READ_FAILED', 'The target could not be read.');
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function snapshotContext(context: TargetContext): Promise<FileSnapshot | null> {
  let targetStat: BigIntStats;
  try {
    targetStat = await lstat(context.target, { bigint: true });
  } catch (error) {
    if (isNodeError(error, ['ENOENT'])) {
      await assertContextUnchanged(context);
      return null;
    }
    mapPathInspectionError(error);
  }
  if (targetStat.isSymbolicLink()) {
    fail('PATH_INVALID', 'Symbolic links are not allowed in write paths.');
  }
  if (!targetStat.isFile()) {
    fail('FILE_NOT_REGULAR', 'The requested target is not a regular file.');
  }

  const snapshot = await readRegularFile(
    context.canonicalRoot,
    context.target,
    'FILE_NOT_FOUND'
  );
  await assertContextUnchanged(context);
  return snapshot;
}

async function assertTargetAbsentInContext(context: TargetContext): Promise<void> {
  try {
    await lstat(context.target, { bigint: true });
  } catch (error) {
    if (isNodeError(error, ['ENOENT'])) {
      await assertContextUnchanged(context);
      return;
    }
    mapPathInspectionError(error);
  }

  await assertContextUnchanged(context);
  fail('TARGET_EXISTS', 'The create-only target already exists.');
}

function stagingPath(
  context: TargetContext,
  relative: string,
  batchId: string,
  index: number
): string {
  const relativePath = stagingRelative(relative, batchId, index);
  return path.join(context.parent, path.posix.basename(relativePath));
}

function rethrowStreamedIoError(error: unknown): never {
  if (error instanceof AppError) {
    throw error;
  }
  if (isNodeError(error, ['ENOSPC'])) {
    fail('STORAGE_FULL', 'The target could not be published because storage is full.');
  }
  if (isNodeError(error, ['EDQUOT'])) {
    fail('STORAGE_FULL', 'The target could not be published because the storage quota was exceeded.');
  }
  fail('WRITE_FAILED', 'The streamed asset could not be published.');
}

async function publishCreateOnly(
  temporaryPath: string,
  target: string,
  mapUnknownError: (error: unknown) => never
): Promise<void> {
  try {
    await link(temporaryPath, target);
  } catch (error) {
    if (isNodeError(error, ['EEXIST'])) {
      fail('TARGET_EXISTS', 'The create-only target already exists.');
    }
    if (isNodeError(error, [
      'EACCES',
      'ENOSYS',
      'ENOTSUP',
      'EOPNOTSUPP',
      'EPERM',
      'EXDEV'
    ])) {
      fail(
        'CREATE_ONLY_UNSUPPORTED',
        'Atomic create-only publication is unavailable; the target was not written.'
      );
    }
    mapUnknownError(error);
  }
}

async function writeAll(
  handle: Awaited<ReturnType<typeof open>>,
  bytes: Buffer,
  position = 0
): Promise<void> {
  let offset = 0;
  while (offset < bytes.byteLength) {
    const result = await handle.write(
      bytes,
      offset,
      bytes.byteLength - offset,
      position + offset
    );
    if (result.bytesWritten === 0) {
      fail('WRITE_FAILED', 'The temporary file could not be written.');
    }
    offset += result.bytesWritten;
  }
}

async function syncDirectory(directory: string): Promise<void> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(directory, 'r');
    await handle.sync();
  } catch (error) {
    if (isNodeError(error, [
      'EACCES',
      'EBADF',
      'EINVAL',
      'EISDIR',
      'ENOTSUP',
      'EPERM'
    ])) {
      return;
    }
    throw error;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function removeOwnedFile(
  target: string,
  identity: BigIntStats
): Promise<CleanupResult> {
  let current: BigIntStats;
  try {
    current = await lstat(target, { bigint: true });
  } catch (error) {
    if (isNodeError(error, ['ENOENT', 'ENOTDIR'])) {
      return 'missing';
    }
    return 'not-owned';
  }
  if (current.isSymbolicLink()
    || !current.isFile()
    || !sameFileIdentity(current, identity)) {
    return 'not-owned';
  }

  try {
    await unlink(target);
    return 'removed';
  } catch {
    return 'not-owned';
  }
}

/** New business targets must also be usable by Terre's file chooser.
 * Keep this separate from the historical journal/recovery path policy.
 */
export function assertReferenceableTarget(relative: string): string {
  policyFor(relative);
  // ChooseFile.tsx: commonCheckFileName. Check parent segments as well.
  if (/ -|[*#%&?@"<>|:]/.test(relative)) {
    fail('TARGET_NAME_UNSUPPORTED', 'The target name cannot be referenced safely by Terre. Choose another target name.');
  }
  return relative;
}

export function assertWritePath(relative: string, creating: boolean): string {
  if (typeof creating !== 'boolean') {
    fail('INVALID_ARGUMENT', 'The creating flag must be a boolean.');
  }
  const validated = policyFor(relative);
  if (creating ? !validated.create : !validated.replace) {
    fail(
      'PATH_INVALID',
      creating
        ? 'This WebGAL target cannot be created.'
        : 'This WebGAL target cannot be replaced.'
    );
  }
  return relative;
}

export async function assertCreateTargetAbsent(
  root: string,
  relative: string
): Promise<void> {
  const validated = assertWritePath(relative, true);
  const context = await resolveTargetContext(root, validated);
  await assertTargetAbsentInContext(context);
}

export function checkedModelDirectory(directory: string): string {
  if (!/^game\/figure\/[^/]+$/.test(directory)) {
    fail('PATH_INVALID', 'Choose one new model directory under game/figure.');
  }
  return assertReferenceableTarget(directory);
}

const execFileAsync = promisify(execFile);

function modelDirectoryStagingRelative(relative: string, batchId: string, index: number): string {
  const name = ['.wgmcp-dir', normalizeBatchId(batchId), index].join('-') + '.tmp';
  return path.posix.join(parentRelative(relative), name);
}

function envValueCaseInsensitive(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const lower = name.toLowerCase();
  for (const [key, value] of Object.entries(env)) {
    if (key.toLowerCase() === lower && value !== undefined && value.trim() !== '') {
      return value;
    }
  }
  return undefined;
}

type DirectoryPublisher =
  | { kind: 'win32'; command: string }
  | { kind: 'linux'; command: string };

const LINUX_RENAME_NOREPLACE_SCRIPT = [
  'import ctypes, errno, os, sys',
  'libc = ctypes.CDLL(None, use_errno=True)',
  'fn = getattr(libc, "renameat2", None)',
  'if fn is None:',
  '    sys.exit(64)',
  'fn.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint]',
  'fn.restype = ctypes.c_int',
  'src = os.fsencode(os.environ["WGMCP_DIRECTORY_STAGE"])',
  'dst = os.fsencode(os.environ["WGMCP_DIRECTORY_TARGET"])',
  'if fn(-100, src, -100, dst, 1) == 0:',
  '    sys.exit(0)',
  'err = ctypes.get_errno()',
  'if err in (errno.ENOSYS, errno.EINVAL, errno.EOPNOTSUPP, errno.EXDEV):',
  '    sys.exit(64)',
  'sys.exit(65 if err == errno.EEXIST else 66)',
].join('\n');

function execExitCode(error: unknown): number | undefined {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === 'number') {
      return code;
    }
  }
  return undefined;
}

export function directoryPublisherEnv(
  baseEnv: NodeJS.ProcessEnv,
  staged: string,
  target: string,
  platform: NodeJS.Platform = process.platform,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...baseEnv };
  if (platform === 'win32') {
    if (!envValueCaseInsensitive(env, 'ProgramFiles')) {
      env.ProgramFiles = envValueCaseInsensitive(env, 'ProgramW6432') ?? 'C:\\Program Files';
    }
    if (!envValueCaseInsensitive(env, 'SystemRoot')) {
      env.SystemRoot = envValueCaseInsensitive(env, 'WINDIR') ?? 'C:\\Windows';
    }
  } else if (platform === 'linux') {
    if (!env.PATH || env.PATH.trim() === '') {
      env.PATH = '/usr/local/bin:/usr/bin:/bin';
    }
  }
  env.WGMCP_DIRECTORY_STAGE = staged;
  env.WGMCP_DIRECTORY_TARGET = target;
  return env;
}

function directoryPublisher(env: NodeJS.ProcessEnv = process.env): DirectoryPublisher {
  if (process.platform === 'win32') {
    const programFiles = envValueCaseInsensitive(env, 'ProgramFiles')
      ?? envValueCaseInsensitive(env, 'ProgramW6432')
      ?? 'C:\\Program Files';
    return { kind: 'win32', command: path.join(programFiles, 'PowerShell', '7', 'pwsh.exe') };
  }
  if (process.platform === 'linux') {
    return { kind: 'linux', command: 'python3' };
  }
  fail(
    'CREATE_ONLY_UNSUPPORTED',
    'Publishing a model directory requires Windows with PowerShell 7 or Linux with Python 3 (renameat2).',
  );
}

async function publishModelDirectory(
  publisher: DirectoryPublisher,
  staged: string,
  context: TargetContext,
): Promise<void> {
  // Windows uses Directory.Move; Linux uses renameat2(RENAME_NOREPLACE) via python3.
  // Both refuse an occupied name (empty dir, non-empty dir, file, or symlink), unlike POSIX rename(2)
  // and Node's fs.rename. Keep paths out of the command text via environment variables.
  const args = publisher.kind === 'win32'
    ? [
        '-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
        '$ErrorActionPreference = "Stop"; [System.IO.Directory]::Move($env:WGMCP_DIRECTORY_STAGE, $env:WGMCP_DIRECTORY_TARGET)',
      ]
    : ['-I', '-c', LINUX_RENAME_NOREPLACE_SCRIPT];
  try {
    await execFileAsync(publisher.command, args, {
      env: directoryPublisherEnv(process.env, staged, context.target, publisher.kind),
      windowsHide: true,
      timeout: 30_000,
    });
  } catch (error) {
    await assertTargetAbsentInContext(context);
    if (publisher.kind === 'linux') {
      const exitCode = execExitCode(error);
      if (exitCode === 65) {
        fail('TARGET_EXISTS', 'The create-only target already exists.');
      }
      if (exitCode === 64) {
        fail(
          'CREATE_ONLY_UNSUPPORTED',
          'Atomic create-only directory publication (renameat2 RENAME_NOREPLACE) is unavailable on this Linux environment.',
        );
      }
      if (isNodeError(error, ['ENOENT', 'EACCES', 'EPERM'])) {
        fail('CREATE_ONLY_UNSUPPORTED', 'Install Python 3 on Linux to import model directories.');
      }
    } else if (isNodeError(error, ['ENOENT', 'EACCES', 'EPERM'])) {
      fail('CREATE_ONLY_UNSUPPORTED', 'Install PowerShell 7 in its standard Windows location to import model directories.');
    }
    fail('WRITE_FAILED', 'The staged model directory could not be published.');
  }
}

function directoryIdentity(entry: BigIntStats): string {
  return createHash('sha256').update(`${entry.dev}:${entry.ino}:${entry.birthtimeNs}`).digest('hex');
}

export async function modelDirectoryIdentity(root: string, relative: string): Promise<string | null> {
  let context: TargetContext;
  let entry: BigIntStats;
  try {
    context = await resolveTargetContext(root, relative);
    entry = await lstat(context.target, { bigint: true });
  } catch (error) {
    if (isNodeError(error, ['ENOENT']) || (error instanceof AppError && error.code === 'FILE_NOT_FOUND')) return null;
    throw error;
  }
  if (!entry.isDirectory() || entry.isSymbolicLink()) {
    fail('PATH_INVALID', 'A model directory is no longer an ordinary directory.');
  }
  await assertContextUnchanged(context);
  const current = await lstat(context.target, { bigint: true });
  if (!current.isDirectory() || !sameFileIdentity(entry, current)) {
    fail('FILE_CHANGED', 'A model directory changed during inspection.');
  }
  return directoryIdentity(entry);
}

export async function createModelDirectory(
  root: string,
  relative: string,
  batchId: string,
  index: number,
  authorize: () => void,
  validateAncestors: () => Promise<void>,
  beforePublish: () => void | Promise<void>,
): Promise<string> {
  const context = await resolveTargetContext(root, relative);
  await assertTargetAbsentInContext(context);
  const publisher = directoryPublisher();
  const staged = path.join(context.parent, path.posix.basename(modelDirectoryStagingRelative(relative, batchId, index)));
  await validateAncestors();
  await assertContextUnchanged(context);
  authorize();
  try {
    await mkdir(staged, { mode: 0o700 });
  } catch (error) {
    if (isNodeError(error, ['EEXIST'])) fail('TARGET_EXISTS', 'The model staging directory already exists.');
    throw error;
  }
  const created = await lstat(staged, { bigint: true });
  const identity = directoryIdentity(created);
  if (!created.isDirectory() || created.isSymbolicLink()) {
    fail('FILE_CHANGED', 'The staged model directory no longer matches.');
  }

  await beforePublish();
  await validateAncestors();
  await assertContextUnchanged(context);
  const current = await lstat(staged, { bigint: true });
  if (!current.isDirectory() || !sameFileIdentity(created, current)) {
    fail('FILE_CHANGED', 'The staged model directory no longer matches.');
  }
  authorize();
  await publishModelDirectory(publisher, staged, context);
  await assertContextUnchanged(context);
  await syncDirectory(context.parent);
  if (await modelDirectoryIdentity(root, relative) !== identity) {
    fail('FILE_CHANGED', 'A newly created model directory no longer matches.');
  }
  return identity;
}

export async function inspectModelDirectoryStaging(
  root: string, relative: string, batchId: string, index: number,
): Promise<string | null> {
  const context = await resolveTargetContext(root, relative);
  const staged = modelDirectoryStagingRelative(relative, batchId, index);
  return await stagingExists(context, path.join(context.parent, path.posix.basename(staged))) ? staged : null;
}

export function stagingRelative(
  relative: string,
  batchId: string,
  index: number
): string {
  policyFor(relative);
  const normalizedBatchId = normalizeBatchId(batchId);
  const normalizedIndex = normalizeIndex(index);
  const parent = parentRelative(relative);
  const temporaryName = `.wgmcp-${normalizedBatchId}-${normalizedIndex}.tmp`;
  return parent === '' ? temporaryName : `${parent}/${temporaryName}`;
}

export async function snapshotTarget(
  root: string,
  relative: string
): Promise<{ revision: string | null; bytes: Buffer | null }> {
  const context = await resolveTargetContext(root, relative);
  const snapshot = await snapshotContext(context);
  return snapshot === null
    ? { revision: null, bytes: null }
    : { revision: snapshot.revision, bytes: snapshot.bytes };
}

export async function streamedTargetRevision(
  root: string,
  relative: string,
  modelDirectory?: string
): Promise<string | null> {
  const context = await resolveTargetContext(root, streamedAssetPath(relative, modelDirectory));
  let snapshot: StreamedFileSnapshot;
  try {
    snapshot = await hashRegularFile(
      context.canonicalRoot,
      context.target,
      STREAMED_REVISION_MAX_BYTES,
      'FILE_NOT_FOUND'
    );
  } catch (error) {
    if (error instanceof AppError && error.code === 'FILE_NOT_FOUND') {
      await assertContextUnchanged(context);
      return null;
    }
    throw error;
  }
  await assertContextUnchanged(context);
  return snapshot.revision;
}

/** Inspect only this batch's deterministic staging path; never read/follow its contents. */
export async function inspectStaging(root: string, relative: string, batchId: string, index: number): Promise<boolean> {
  const context = await resolveTargetContext(root, relative);
  return stagingExists(context, stagingPath(context, relative, batchId, index));
}

async function stagingExists(context: TargetContext, target: string): Promise<boolean> {
  try {
    await lstat(target);
    await assertContextUnchanged(context);
    return true;
  } catch (error) {
    if (isNodeError(error, ['ENOENT'])) {
      await assertContextUnchanged(context);
      return false;
    }
    throw error;
  }
}

export async function inspectStreamedStaging(
  root: string,
  relative: string,
  batchId: string,
  index: number,
  modelDirectory?: string
): Promise<{ present: boolean; bytes: number | null; revision: string | null }> {
  const context = await resolveTargetContext(root, streamedAssetPath(relative, modelDirectory));
  const target = stagingPath(
    context,
    relative,
    normalizeBatchId(batchId),
    normalizeIndex(index)
  );

  let targetStat: BigIntStats;
  try {
    targetStat = await lstat(target, { bigint: true });
  } catch (error) {
    if (isNodeError(error, ['ENOENT'])) {
      await assertContextUnchanged(context);
      return { present: false, bytes: null, revision: null };
    }
    mapPathInspectionError(error);
  }

  if (targetStat.isSymbolicLink()
    || !targetStat.isFile()
    || targetStat.size > BigInt(LARGE_ASSET_LIMITS.maxFileBytes)) {
    await assertContextUnchanged(context);
    return { present: true, bytes: null, revision: null };
  }

  try {
    const snapshot = await hashRegularFile(
      context.canonicalRoot,
      target,
      LARGE_ASSET_LIMITS.maxFileBytes,
      'FILE_CHANGED'
    );
    await assertContextUnchanged(context);
    return {
      present: true,
      bytes: snapshot.bytes,
      revision: snapshot.revision
    };
  } catch (error) {
    if (error instanceof AppError
      && [
        'FILE_CHANGED',
        'FILE_NOT_READABLE',
        'FILE_NOT_REGULAR',
        'FILE_READ_FAILED',
        'FILE_TOO_LARGE',
        'PATH_INVALID',
        'PATH_OUTSIDE_PROJECT'
      ].includes(error.code)) {
      await assertContextUnchanged(context);
      return { present: true, bytes: null, revision: null };
    }
    throw error;
  }
}

export async function publishStreamedAsset(
  root: string,
  relative: string,
  expected: { bytes: number; revision: string },
  stream: (write: (chunk: Buffer) => Promise<void>) => Promise<void>,
  batchId: string,
  index: number,
  authorize?: () => void,
  model?: { directory: string; validateBeforePublish: () => Promise<void> }
): Promise<void> {
  const validated = streamedAssetPath(relative, model?.directory);
  const normalizedExpected = normalizeStreamedExpectation(expected);
  const normalizedBatchId = normalizeBatchId(batchId);
  const normalizedIndex = normalizeIndex(index);
  if (typeof stream !== 'function') {
    fail('INVALID_ARGUMENT', 'The streamed asset producer must be a function.');
  }
  if (authorize !== undefined && typeof authorize !== 'function') {
    fail('INVALID_ARGUMENT', 'The authorization callback must be a function.');
  }

  const context = await resolveTargetContext(root, validated);
  await assertTargetAbsentInContext(context);
  const temporaryPath = stagingPath(
    context,
    validated,
    normalizedBatchId,
    normalizedIndex
  );

  let handle: Awaited<ReturnType<typeof open>> | undefined;
  let temporaryIdentity: BigIntStats | undefined;
  let stagingCreated = false;
  let published = false;
  let streamedBytes = 0;
  let writeChain = Promise.resolve();
  let writeFailed = false;
  let writeError: unknown;

  const queueWrite = (chunk: Buffer): Promise<void> => {
    const operation = writeChain.then(async () => {
      if (!Buffer.isBuffer(chunk)) {
        fail('INVALID_ARGUMENT', 'Streamed asset chunks must be Buffers.');
      }
      if (chunk.byteLength > streamChunkBytes()) {
        fail('INVALID_ARGUMENT', 'A streamed asset chunk exceeds the configured chunk limit.');
      }
      if (streamedBytes + chunk.byteLength > normalizedExpected.bytes) {
        fail('FILE_TOO_LARGE', 'The streamed asset produced more bytes than expected.');
      }
      if (!handle) {
        fail('WRITE_FAILED', 'The staging file is no longer available.');
      }
      await writeAll(handle, chunk, streamedBytes);
      streamedBytes += chunk.byteLength;
    });
    writeChain = operation.catch((error: unknown) => {
      if (!writeFailed) {
        writeFailed = true;
        writeError = error;
      }
    });
    return operation;
  };

  try {
    await assertContextUnchanged(context);
    try {
      handle = await open(temporaryPath, 'wx', 0o600);
      stagingCreated = true;
    } catch (error) {
      if (isNodeError(error, ['EEXIST'])) {
        fail('STAGING_EXISTS', 'The deterministic staging file already exists.');
      }
      rethrowStreamedIoError(error);
    }

    const before = await handle.stat({ bigint: true });
    temporaryIdentity = before;
    if (!before.isFile() || before.size !== 0n) {
      fail('WRITE_FAILED', 'The staging target is not a new regular file.');
    }

    try {
      await stream(queueWrite);
    } finally {
      await writeChain;
    }
    if (writeFailed) {
      throw writeError;
    }
    if (streamedBytes !== normalizedExpected.bytes) {
      fail('WRITE_FAILED', 'The streamed asset did not produce the expected number of bytes.');
    }

    await handle.sync();
    const after = await handle.stat({ bigint: true });
    if (!sameFileIdentity(before, after)
      || after.size !== BigInt(normalizedExpected.bytes)) {
      fail('WRITE_FAILED', 'The staging file failed write-back verification.');
    }
    await handle.close();
    handle = undefined;
    await syncDirectory(context.parent);

    const staged = await hashRegularFile(
      context.canonicalRoot,
      temporaryPath,
      normalizedExpected.bytes,
      'FILE_CHANGED'
    );
    const stagedStat = await lstat(temporaryPath, { bigint: true });
    if (!sameFileIdentity(stagedStat, temporaryIdentity)
      || staged.bytes !== normalizedExpected.bytes
      || staged.revision !== normalizedExpected.revision) {
      fail('WRITE_FAILED', 'The streamed staging file did not match its expected content.');
    }

    await assertContextUnchanged(context);
    await assertTargetAbsentInContext(context);
    await assertContextUnchanged(context);

    if (model) {
      await model.validateBeforePublish();
      await assertContextUnchanged(context);
    }
    authorize?.();
    await publishCreateOnly(temporaryPath, context.target, rethrowStreamedIoError);
    published = true;
    await syncDirectory(context.parent);
    await assertContextUnchanged(context);

    const targetStat = await lstat(context.target, { bigint: true });
    if (targetStat.isSymbolicLink()
      || !targetStat.isFile()
      || !sameFileIdentity(targetStat, temporaryIdentity)) {
      fail('OUTCOME_UNKNOWN', 'The published target does not have the expected identity.');
    }
    const targetSnapshot = await hashRegularFile(
      context.canonicalRoot,
      context.target,
      normalizedExpected.bytes,
      'FILE_CHANGED'
    );
    if (targetSnapshot.bytes !== normalizedExpected.bytes
      || targetSnapshot.revision !== normalizedExpected.revision) {
      fail('OUTCOME_UNKNOWN', 'The published target failed streamed write-back verification.');
    }

    const cleanup = await removeOwnedFile(temporaryPath, temporaryIdentity);
    if (cleanup === 'not-owned') {
      fail('OUTCOME_UNKNOWN', 'The published target could not be safely detached from staging.');
    }
    await syncDirectory(context.parent);
    await assertContextUnchanged(context);

    const finalStat = await lstat(context.target, { bigint: true });
    if (finalStat.isSymbolicLink()
      || !finalStat.isFile()
      || !sameFileIdentity(finalStat, temporaryIdentity)) {
      fail('OUTCOME_UNKNOWN', 'The published target changed after publication.');
    }
    const finalSnapshot = await hashRegularFile(
      context.canonicalRoot,
      context.target,
      normalizedExpected.bytes,
      'FILE_CHANGED'
    );
    if (finalSnapshot.bytes !== normalizedExpected.bytes
      || finalSnapshot.revision !== normalizedExpected.revision) {
      fail('OUTCOME_UNKNOWN', 'The published target changed after publication.');
    }
    await assertContextUnchanged(context);
  } catch (error) {
    await handle?.close().catch(() => undefined);

    let cleanup: CleanupResult | 'identity-unknown' | undefined;
    if (temporaryIdentity) {
      cleanup = await removeOwnedFile(temporaryPath, temporaryIdentity);
    } else if (stagingCreated) {
      cleanup = await lstat(temporaryPath, { bigint: true }).then(
        () => 'identity-unknown' as const,
        (inspectionError: unknown) => isNodeError(inspectionError, ['ENOENT', 'ENOTDIR'])
          ? 'missing'
          : 'identity-unknown'
      );
    }

    if (cleanup === 'not-owned' || cleanup === 'identity-unknown') {
      fail('OUTCOME_UNKNOWN', 'The staging file may remain and its ownership could not be confirmed.');
    }
    if (published) {
      if (error instanceof AppError && error.code === 'OUTCOME_UNKNOWN') {
        throw error;
      }
      fail('OUTCOME_UNKNOWN', 'The target may have been published, but final verification failed.');
    }
    rethrowStreamedIoError(error);
  }
}

export async function publishTarget(
  root: string,
  relative: string,
  expectedRevision: string | null,
  bytes: Uint8Array,
  batchId: string,
  index: number,
  authorize?: () => void
): Promise<void> {
  const creating = expectedRevision === null;
  const validated = assertWritePath(relative, creating);
  const normalizedExpectedRevision = normalizeRevision(expectedRevision);
  const normalizedBatchId = normalizeBatchId(batchId);
  const normalizedIndex = normalizeIndex(index);
  if (!(bytes instanceof Uint8Array)) {
    fail('INVALID_ARGUMENT', 'Target content must be bytes.');
  }
  if (bytes.byteLength > WRITE_LIMITS.maxFileBytes) {
    fail('FILE_TOO_LARGE', 'The target exceeds the configured size limit.');
  }
  const content = Buffer.from(bytes);

  const context = await resolveTargetContext(root, validated);
  if (creating) {
    await assertTargetAbsentInContext(context);
  } else {
    const initial = await snapshotContext(context);
    if (initial === null || initial.revision !== normalizedExpectedRevision) {
      fail('REVISION_CONFLICT', 'The target revision no longer matches the expected revision.');
    }
  }

  const temporaryPath = stagingPath(
    context,
    validated,
    normalizedBatchId,
    normalizedIndex
  );

  let handle: Awaited<ReturnType<typeof open>> | undefined;
  let temporaryIdentity: BigIntStats | undefined;
  let published = false;
  try {
    await assertContextUnchanged(context);
    try {
      handle = await open(temporaryPath, 'wx', 0o600);
    } catch (error) {
      if (isNodeError(error, ['EEXIST'])) {
        fail('STAGING_EXISTS', 'The deterministic staging file already exists.');
      }
      fail('WRITE_FAILED', 'The staging file could not be created.');
    }

    const before = await handle.stat({ bigint: true });
    if (!before.isFile()) {
      fail('WRITE_FAILED', 'The staging target is not a regular file.');
    }
    temporaryIdentity = before;

    await writeAll(handle, content);
    await handle.sync();

    const after = await handle.stat({ bigint: true });
    if (!sameFileIdentity(before, after)
      || after.size !== BigInt(content.byteLength)) {
      fail('WRITE_FAILED', 'The staging file failed write-back verification.');
    }
    await handle.close();
    handle = undefined;
    await syncDirectory(context.parent);

    const staged = await readRegularFile(
      context.canonicalRoot,
      temporaryPath,
      'FILE_CHANGED'
    );
    if (!sameFileIdentity(
      (await lstat(temporaryPath, { bigint: true })),
      temporaryIdentity
    ) || !staged.bytes.equals(content)) {
      fail('FILE_CHANGED', 'The staging file changed before publication.');
    }

    await assertContextUnchanged(context);
    if (creating) {
      await assertTargetAbsentInContext(context);
    } else {
      const current = await snapshotContext(context);
      if (current === null || current.revision !== normalizedExpectedRevision) {
        fail('REVISION_CONFLICT', 'The target revision changed before publication.');
      }
    }
    await assertContextUnchanged(context);

    // Revoke expired/disconnected host sessions after staging IO, before publication.
    authorize?.();
    if (creating) {
      await publishCreateOnly(
        temporaryPath,
        context.target,
        () => fail('WRITE_FAILED', 'The create-only target could not be published.')
      );
      published = true;
      await syncDirectory(context.parent);
      await assertContextUnchanged(context);
    } else {
      try {
        await rename(temporaryPath, context.target);
      } catch (error) {
        if (isNodeError(error, ['EEXIST'])) {
          fail('REVISION_CONFLICT', 'The target appeared before replacement.');
        }
        fail('WRITE_FAILED', 'The target could not be replaced.');
      }
      published = true;
      await syncDirectory(context.parent);
      await assertContextUnchanged(context);
    }

    const verified = await readRegularFile(
      context.canonicalRoot,
      context.target,
      'FILE_CHANGED'
    );
    if (!verified.bytes.equals(content)) {
      fail('OUTCOME_UNKNOWN', 'The published target failed write-back verification.');
    }

    if (creating) {
      const cleanup = await removeOwnedFile(temporaryPath, temporaryIdentity);
      if (cleanup === 'not-owned') {
        fail('OUTCOME_UNKNOWN', 'The published target could not be safely detached from staging.');
      }
      await syncDirectory(context.parent);
      await assertContextUnchanged(context);
      const finalSnapshot = await readRegularFile(
        context.canonicalRoot,
        context.target,
        'FILE_CHANGED'
      );
      if (!finalSnapshot.bytes.equals(content)) {
        fail('OUTCOME_UNKNOWN', 'The published target changed after publication.');
      }
    }
    await assertContextUnchanged(context);
  } catch (error) {
    await handle?.close().catch(() => undefined);
    if (temporaryIdentity) {
      await removeOwnedFile(temporaryPath, temporaryIdentity);
    }
    if (published) {
      if (error instanceof AppError && error.code === 'OUTCOME_UNKNOWN') {
        throw error;
      }
      fail('OUTCOME_UNKNOWN', 'The target may have been published, but final verification failed.');
    }
    if (error instanceof AppError) {
      throw error;
    }
    fail('WRITE_FAILED', 'The target could not be published.');
  }
}
