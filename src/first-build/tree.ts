import { createHash } from 'node:crypto';
import { open, lstat, readdir, realpath } from 'node:fs/promises';
import type { BigIntStats } from 'node:fs';
import path from 'node:path';
import { AppError } from '../errors.js';

export interface TreeEntry {
  identity: string;
  revision: string | null;
  fingerprint?: string;
}
export type Tree = Map<string, TreeEntry>;

export function within(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === '' || (relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative));
}

function identity(stat: BigIntStats): string {
  return JSON.stringify([String(stat.dev), String(stat.ino), String(stat.birthtimeNs)]);
}

export function fileFingerprint(stat: BigIntStats): string {
  return [identity(stat), stat.size, stat.mtimeNs, stat.ctimeNs, stat.nlink].join(':');
}

function stableFile(before: BigIntStats, after: BigIntStats): boolean {
  return after.isFile() && identity(before) === identity(after) && before.size === after.size &&
    before.mtimeNs === after.mtimeNs && before.ctimeNs === after.ctimeNs && before.nlink === after.nlink;
}

function changed(): never {
  throw new AppError('FIRST_BUILD_TREE_CHANGED', '隔离目录包含链接、特殊文件，或扫描期间发生了变化。');
}

/** Captures file contents and identities, including untouched paths and directories. */
export async function captureTree(root: string, allowSourceHardlinks = false): Promise<Tree> {
  const tree: Tree = new Map();
  async function visit(relative: string): Promise<void> {
    const file = path.join(root, relative);
    const before = await lstat(file, { bigint: true });
    if (before.isSymbolicLink() || path.relative(file, await realpath(file)) !== '') changed();
    if (before.isDirectory()) {
      tree.set(relative, { identity: identity(before), revision: null });
      for (const name of await readdir(file)) {
        await visit(relative ? relative + '/' + name : name);
      }
      const after = await lstat(file, { bigint: true });
      if (!after.isDirectory() || identity(before) !== identity(after) ||
        before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) changed();
      return;
    }
    if (!before.isFile() || (!allowSourceHardlinks && before.nlink !== 1n)) changed();
    const handle = await open(file, 'r');
    try {
      if (!stableFile(before, await handle.stat({ bigint: true }))) changed();
      const hash = createHash('sha256');
      for await (const chunk of handle.createReadStream({ autoClose: false })) hash.update(chunk);
      if (!stableFile(before, await handle.stat({ bigint: true })) ||
        !stableFile(before, await lstat(file, { bigint: true }))) changed();
      tree.set(relative, { identity: identity(before), revision: hash.digest('hex'), fingerprint: fileFingerprint(before) });
    } finally {
      await handle.close();
    }
  }
  await visit('');
  return tree;
}

export function treeDifference(before: Tree, after: Tree, updates = new Map<string, string>()): string | undefined {
  for (const [name, old] of before) {
    const current = after.get(name);
    if (updates.has(name)) {
      if (current?.revision !== updates.get(name)) return name;
    } else if (current?.revision !== old.revision || current?.identity !== old.identity) {
      return name || '工程根目录';
    }
  }
  for (const [name, current] of after) {
    if (!before.has(name) && (current.revision === null || current.revision !== updates.get(name))) return name;
  }
  for (const name of updates.keys()) {
    if (!after.has(name)) return name;
  }
}

/** A copy has the same bytes and layout, and deliberately different file identities. */
export function sameContents(source: Tree, copy: Tree): boolean {
  return source.size === copy.size && [...source].every(([name, entry]) => copy.get(name)?.revision === entry.revision);
}
