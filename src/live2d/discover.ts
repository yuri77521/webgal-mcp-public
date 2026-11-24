import { posix } from 'node:path';
import { readSource } from '../assets/source.js';
import { getProject } from '../config.js';
import { AppError } from '../errors.js';
import { listFiles, readText, validateRelativePath } from '../filesystem.js';
import type { AppConfig } from '../types.js';
import { inspectLive2dModel } from './model.js';
import type {
  Live2dDiscoverInput,
  Live2dDiscoverItem,
  Live2dDiscoverPage,
} from './types.js';

const modelEntryNames = new Set(['model.json']);
const auxiliaryJsonName = /(?:\.exp3?|\.physics3?|\.motion3?|\.pose3?|\.cdi3|\.userdata3)\.json$/i;

function explicitlyNamedModelEntry(path: string): boolean {
  const basename = posix.basename(path).toLowerCase();
  return basename.endsWith('.model3.json') || modelEntryNames.has(basename);
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasCubismStructure(document: unknown): boolean {
  if (!object(document)) return false;
  const cubism3 = document.Version === 3 && object(document.FileReferences);
  const cubism2 = typeof document.model === 'string'
    && Array.isArray(document.textures)
    && object(document.motions);
  return cubism3 || cubism2;
}

async function readCandidate(
  config: AppConfig,
  input: Live2dDiscoverInput,
  root: string,
  storagePath: string,
): Promise<unknown> {
  if (input.location.kind === 'project') {
    return JSON.parse((await readText(root, storagePath)).text);
  }
  const source = await readSource(config, input.location.sourceId, storagePath);
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(source.bytes));
}

function displayName(modelPath: string): string {
  const directory = posix.basename(posix.dirname(modelPath));
  if (directory !== '.' && directory !== '') return directory;
  return posix.basename(modelPath).replace(/\.model3?\.json$/i, '');
}

export async function discoverLive2dModels(
  config: AppConfig,
  input: Live2dDiscoverInput,
  checkpoint?: () => void,
): Promise<Live2dDiscoverPage> {
  const directory = input.directory === undefined ? '' : validateRelativePath(input.directory);
  const offset = input.offset ?? 0;
  const limit = input.limit ?? 100;
  if (!Number.isSafeInteger(offset) || offset < 0) {
    throw new AppError('INVALID_ARGUMENT', 'offset must be a non-negative integer.');
  }
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw new AppError('INVALID_ARGUMENT', 'limit must be between 1 and 100.');
  }

  let root: string;
  let storageDirectory: string;
  let storagePrefix: string;
  const sourceId = input.location.kind === 'source' ? input.location.sourceId : '';
  if (input.location.kind === 'project') {
    root = getProject(config, input.location.projectId).root;
    storagePrefix = 'game/figure/';
    storageDirectory = `${storagePrefix}${directory}`;
  } else {
    const source = config.sources.find(candidate => candidate.id === sourceId);
    if (!source) {
      throw new AppError('SOURCE_NOT_AUTHORIZED', 'Source is not authorized.');
    }
    root = source.root;
    storagePrefix = '';
    storageDirectory = directory;
  }

  checkpoint?.();
  const files = await listFiles(root, storageDirectory, ['.json'], {
    checkpoint,
    statOnly: true,
  });
  const candidates: Array<{ modelPath: string }> = [];
  for (const file of files) {
    checkpoint?.();
    const explicit = explicitlyNamedModelEntry(file.path);
    if (!explicit && auxiliaryJsonName.test(posix.basename(file.path))) continue;
    if (!explicit) {
      try {
        if (!hasCubismStructure(await readCandidate(
          config,
          input,
          root,
          file.path,
        ))) continue;
      } catch {
        continue;
      }
    }
    candidates.push({
      modelPath: storagePrefix === '' ? file.path : file.path.slice(storagePrefix.length),
    });
  }
  candidates.sort((left, right) => left.modelPath < right.modelPath
      ? -1
      : left.modelPath > right.modelPath
        ? 1
        : 0);

  const end = Math.min(offset + limit, candidates.length);
  const items: Live2dDiscoverItem[] = [];
  for (const candidate of candidates.slice(offset, end)) {
    checkpoint?.();
    const location = input.location.kind === 'project'
      ? {
        kind: 'project' as const,
        projectId: input.location.projectId,
        modelPath: candidate.modelPath,
        rootPath: directory,
      }
      : {
        kind: 'source' as const,
        sourceId,
        modelPath: candidate.modelPath,
        rootPath: directory,
      };
    const report = await inspectLive2dModel(config, location, checkpoint);
    items.push({
      modelPath: candidate.modelPath,
      rootPath: directory,
      format: report.format,
      displayName: displayName(candidate.modelPath),
      status: report.status,
      counts: report.counts,
      missingFiles: report.dependencies
        .filter(dependency => dependency.status === 'missing')
        .map(dependency => dependency.path),
    });
  }

  return {
    items,
    total: candidates.length,
    offset,
    limit,
    nextOffset: end < candidates.length ? end : null,
  };
}
