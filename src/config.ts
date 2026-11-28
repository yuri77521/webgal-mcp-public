import type { BigIntStats } from 'node:fs';
import { open, realpath, stat } from 'node:fs/promises';
import * as path from 'node:path';
import { TextDecoder } from 'node:util';
import { z } from 'zod';
import { AppError } from './errors.js';
import { validateRelativePath } from './filesystem.js';
import { normalizeTerreUrl } from './terre.js';
import type { AppConfig, ProjectConfig, SourceConfig } from './types.js';
import { LIMITS } from './types.js';

const MAX_CONFIG_ENTRIES = 64;
const idSchema = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/);
const nameSchema = z.string().min(1).max(256);
const rootSchema = z.string().min(1).max(4096);
const terreUrlSchema = z.string().min(1).max(4096);
const terreGameDirSchema = z.string().min(1).max(255);

const projectSchema = z
  .object({
    id: idSchema,
    name: nameSchema.optional(),
    root: rootSchema,
    terreUrl: terreUrlSchema.optional(),
    terreGameDir: terreGameDirSchema.optional()
  })
  .strict()
  .superRefine((project, context) => {
    if ((project.terreUrl === undefined) !== (project.terreGameDir === undefined)) {
      context.addIssue({
        code: 'custom',
        message: 'Terre URL and game directory must be configured together.'
      });
    }
  });

const sourceSchema = z
  .object({
    id: idSchema,
    root: rootSchema
  })
  .strict();

const configSchema = z
  .object({
    version: z.literal(1),
    projects: z.array(projectSchema).max(MAX_CONFIG_ENTRIES),
    sources: z.array(sourceSchema).max(MAX_CONFIG_ENTRIES).default([]),
    firstBuild: z.object({
      root: rootSchema,
      templateRoot: rootSchema,
      terreGamesRoots: z.array(rootSchema).max(MAX_CONFIG_ENTRIES)
    }).strict().optional()
  })
  .strict();

function invalidConfig(): never {
  throw new AppError('INVALID_CONFIG', 'Configuration is invalid.');
}

function configReadError(error: unknown): never {
  if (error instanceof AppError) {
    throw error;
  }

  if (isNodeError(error, ['ENOENT', 'ENOTDIR'])) {
    throw new AppError('CONFIG_NOT_FOUND', 'Configuration file was not found.');
  }
  if (isNodeError(error, ['EISDIR'])) {
    invalidConfig();
  }

  throw new AppError('CONFIG_READ_FAILED', 'Configuration file could not be read.');
}

function isNodeError(error: unknown, codes: string[]): boolean {
  if (typeof error !== 'object' || error === null || !('code' in error)) {
    return false;
  }

  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' && codes.includes(code);
}

function snapshotMatches(before: BigIntStats, after: BigIntStats): boolean {
  return before.dev === after.dev
    && before.ino === after.ino
    && before.size === after.size
    && before.mtimeNs === after.mtimeNs
    && before.ctimeNs === after.ctimeNs;
}

async function readLimited(handle: Awaited<ReturnType<typeof open>>): Promise<Buffer> {
  const buffer = Buffer.allocUnsafe(LIMITS.textBytes + 1);
  let offset = 0;

  while (offset < buffer.byteLength) {
    const result = await handle.read(buffer, offset, buffer.byteLength - offset, offset);
    if (result.bytesRead === 0) {
      break;
    }
    offset += result.bytesRead;
  }

  return buffer.subarray(0, offset);
}

async function readConfigText(configPath: string): Promise<string> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  let result: string | undefined;
  try {
    handle = await open(configPath, 'r');
    const before = await handle.stat({ bigint: true });
    if (!before.isFile()) {
      invalidConfig();
    }
    if (before.size > BigInt(LIMITS.textBytes)) {
      invalidConfig();
    }

    const data = await readLimited(handle);
    const after = await handle.stat({ bigint: true });
    if (!snapshotMatches(before, after) || BigInt(data.byteLength) !== after.size) {
      throw new AppError('CONFIG_READ_FAILED', 'Configuration file changed while it was being read.');
    }
    if (data.byteLength > LIMITS.textBytes) {
      invalidConfig();
    }

    const content = data[0] === 0xef && data[1] === 0xbb && data[2] === 0xbf
      ? data.subarray(3)
      : data;

    try {
      result = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(content);
    } catch {
      invalidConfig();
    }
  } catch (error) {
    configReadError(error);
  } finally {
    await handle?.close().catch(() => undefined);
  }
  return result ?? invalidConfig();
}

async function resolveConfiguredRoot(root: string, configDirectory: string): Promise<string> {
  try {
    const resolved = await realpath(path.resolve(configDirectory, root));
    const rootStat = await stat(resolved);
    if (!rootStat.isDirectory()) {
      invalidConfig();
    }
    return resolved;
  } catch (error) {
    if (error instanceof AppError) {
      throw error;
    }
    invalidConfig();
  }
}

function assertUniqueIds(ids: string[]): void {
  if (new Set(ids).size !== ids.length) {
    invalidConfig();
  }
}

function validateTerreMapping(project: ProjectConfig): ProjectConfig {
  if (project.terreUrl === undefined || project.terreGameDir === undefined) {
    return project;
  }

  let normalizedUrl: string;
  try {
    normalizedUrl = normalizeTerreUrl(project.terreUrl);
  } catch {
    invalidConfig();
  }

  try {
    const gameDir = validateRelativePath(project.terreGameDir);
    if (gameDir === '' || gameDir.includes('/')) {
      invalidConfig();
    }
  } catch {
    invalidConfig();
  }

  return {
    ...project,
    terreUrl: normalizedUrl
  };
}

export async function loadConfig(configPath: string): Promise<AppConfig> {
  const absoluteConfigPath = path.resolve(configPath);
  const configDirectory = path.dirname(absoluteConfigPath);
  const rawText = await readConfigText(absoluteConfigPath);

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(rawText);
  } catch {
    invalidConfig();
  }

  const parsed = configSchema.safeParse(parsedJson);
  if (!parsed.success) {
    invalidConfig();
  }

  assertUniqueIds(parsed.data.projects.map((project) => project.id));
  assertUniqueIds(parsed.data.sources.map((source) => source.id));

  const projects: ProjectConfig[] = [];
  for (const project of parsed.data.projects) {
    const validatedProject = validateTerreMapping(project);
    projects.push({
      ...validatedProject,
      root: await resolveConfiguredRoot(validatedProject.root, configDirectory)
    });
  }

  const sources: SourceConfig[] = [];
  for (const source of parsed.data.sources) {
    sources.push({
      ...source,
      root: await resolveConfiguredRoot(source.root, configDirectory)
    });
  }

  const firstBuild = parsed.data.firstBuild;
  return {
    version: 1,
    projects,
    sources,
    ...(firstBuild ? {
      firstBuild: {
        root: await resolveConfiguredRoot(firstBuild.root, configDirectory),
        templateRoot: await resolveConfiguredRoot(firstBuild.templateRoot, configDirectory),
        terreGamesRoots: await Promise.all(firstBuild.terreGamesRoots.map(root => resolveConfiguredRoot(root, configDirectory)))
      }
    } : {})
  };
}

export function getProject(config: AppConfig, id: string): ProjectConfig {
  const project = config.projects.find((candidate) => candidate.id === id);
  if (!project) {
    throw new AppError('PROJECT_NOT_AUTHORIZED', 'Project is not authorized.');
  }
  return project;
}
