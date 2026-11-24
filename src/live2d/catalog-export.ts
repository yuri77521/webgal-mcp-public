import { once } from 'node:events';
import { realpath } from 'node:fs/promises';
import path from 'node:path';
import { AppError } from '../errors.js';
import type { AppConfig } from '../types.js';
import { snapshotLive2dCatalog } from './model.js';
import { getSourceRoot } from './paths.js';

// This local pipe uses the MCP reader once for the entire catalog. Its output
// stays between the two processes, including for models with hundreds of cues.
export async function exportLive2dCatalog(config: AppConfig, sourceId: string,
  packageDirectory: string, entry: string, libraryDirectory: string) {
  const sourceRoot = getSourceRoot(config, sourceId);
  const library = await realpath(libraryDirectory);
  function libraryPath(relative: string) {
    const local = path.relative(library, path.resolve(sourceRoot, relative));
    if (path.isAbsolute(local) || local === '..' || local.startsWith('..' + path.sep)) {
      throw new AppError('PATH_INVALID', 'Choose a model package inside the library.');
    }
    return local.split(path.sep).join('/');
  }
  const rootPath = packageDirectory === '.' ? '' : packageDirectory;
  const catalogRoot = libraryPath(rootPath);
  const modelPath = libraryPath(entry);
  const { report, items } = await snapshotLive2dCatalog(config, {
    kind: 'source', sourceId, modelPath: entry, rootPath,
  });
  if (!report.revision || report.format === 'unknown') {
    throw new AppError('INVALID_ARGUMENT', 'Discover and select a readable model entry first.');
  }
  const model = { modelPath, rootPath: catalogRoot, status: report.status, revision: report.revision,
    format: report.format, counts: report.counts, issues: report.issues,
    sourceId, sourceModelPath: entry, sourceRootPath: rootPath };
  const pageSize = 100;
  for (let offset = 0; offset === 0 || offset < items.length; offset += pageSize) {
    const end = Math.min(offset + pageSize, items.length);
    const entryPage = { modelPath, rootPath: catalogRoot, format: report.format, revision: report.revision,
      offset, nextOffset: end < items.length ? end : null, total: items.length, counts: report.counts,
      items: items.slice(offset, end).map(item => ({ ...item,
        ...(item.rootRelativePath && { rootRelativePath: libraryPath(item.rootRelativePath) }) })) };
    if (!process.stdout.write(JSON.stringify({ model, entryPage }) + '\n')) {
      await once(process.stdout, 'drain');
    }
  }
}
