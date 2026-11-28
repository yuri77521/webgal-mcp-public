import { lstat, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { WRITE_LIMITS } from '../changes/types.js';
import { AppError } from '../errors.js';
import { probeRegularFile, readText } from '../filesystem.js';

const uuid = z.string().uuid();
const revision = z.string().regex(/^[a-f0-9]{64}$/);
const authorizationSchema = z.object({ id: uuid, expiresAt: z.number().int() });
const plannedFile = z.object({
  path: z.string().min(1).max(1024),
  beforeRevision: revision.nullable(),
  afterRevision: revision,
});
const intentSchema = z.object({ planId: uuid, operations: z.array(plannedFile).min(1).max(WRITE_LIMITS.maxFiles) });
const resultSchema = z.object({
  batchId: uuid,
  status: z.literal('complete'),
  operations: z.array(plannedFile.extend({ phase: z.literal('applied') })).min(1).max(WRITE_LIMITS.maxFiles)
});

async function readReceipt<T>(directory: string, name: string, schema: z.ZodType<T>): Promise<T | undefined> {
  try {
    await probeRegularFile(directory, name);
    if ((await lstat(path.join(directory, name))).nlink !== 1) return undefined;
    const { text } = await readText(directory, name);
    const parsed = schema.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined; // A missing, damaged or interrupted receipt never establishes success.
  }
}

/** Reports persisted receipts without opening a coordinator or enrolling the run in a new connection. */
export async function inspectArchivedBuild(root: string, runId: string) {
  if (!uuid.safeParse(runId).success) throw new AppError('FIRST_BUILD_NOT_FOUND', '找不到此首版记录。');
  const directory = path.join(root, runId);
  const entry = await lstat(directory).catch(() => undefined);
  if (!entry?.isDirectory() || path.relative(directory, await realpath(directory)) !== '') {
    throw new AppError('FIRST_BUILD_NOT_FOUND', '找不到此首版记录。');
  }
  const authorization = await readReceipt(directory, 'authorization.json', authorizationSchema);
  if (authorization?.id !== runId) throw new AppError('FIRST_BUILD_NOT_FOUND', '找不到可核对的首版授权记录。');
  const files = (await readdir(directory)).sort();
  const planIds = new Set<string>();
  for (const file of files) {
    const match = /^(.+)\.(?:pending|result)\.json$/.exec(file);
    if (match && uuid.safeParse(match[1]).success) planIds.add(match[1]);
  }
  const batches = [];
  for (const planId of planIds) {
    const intent = await readReceipt(directory, planId + '.pending.json', intentSchema);
    const result = await readReceipt(directory, planId + '.result.json', resultSchema);
    const paths = intent?.planId === planId ? intent.operations.map(operation => operation.path) : [];
    const verified = intent?.planId === planId && result !== undefined && result.operations.length === intent.operations.length &&
      result.operations.every(({ path, beforeRevision, afterRevision }, index) => {
        const expected = intent.operations[index];
        return path === expected.path && beforeRevision === expected.beforeRevision && afterRevision === expected.afterRevision;
      });
    batches.push({ planId, ...(verified ? { batchId: result?.batchId } : {}), verified, paths });
  }
  return {
    state: 'archived', requiresUserConfirmation: true, expiresAt: authorization.expiresAt, batches,
    reason: '这是上一连接保留的批次回执。verified 表示当时已完成读回，当前文件状态需另行核对。'
  };
}
