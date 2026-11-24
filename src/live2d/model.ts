import { posix } from 'node:path';
import { probeAssetSource, readSource } from '../assets/source.js';
import { getProject } from '../config.js';
import { AppError, publicError } from '../errors.js';
import { listFiles, probeRegularFile, readText, validateRelativePath } from '../filesystem.js';
import type { AppConfig, ProjectConfig } from '../types.js';
import type {
  Live2dCatalogItem,
  Live2dCatalogSnapshot,
  Live2dCounts,
  Live2dDependency,
  Live2dDependencyKind,
  Live2dEntryPage,
  Live2dEntryQuery,
  Live2dEntryStatus,
  Live2dExpression,
  Live2dFormat,
  Live2dIssue,
  Live2dLocation,
  Live2dModelReport,
  Live2dMotion,
  Live2dStatus,
  Live2dUnregisteredExpression,
} from './types.js';

export type {
  Live2dCatalogItem,
  Live2dCatalogSnapshot,
  Live2dCounts,
  Live2dDependency,
  Live2dDependencyKind,
  Live2dEntryPage,
  Live2dEntryQuery,
  Live2dEntryStatus,
  Live2dExpression,
  Live2dFormat,
  Live2dIssue,
  Live2dLocation,
  Live2dModelReport,
  Live2dMotion,
  Live2dStatus,
  Live2dUnregisteredExpression,
} from './types.js';

export type ModelLocation = Live2dLocation;

const dependencyExtensions: Record<Live2dDependencyKind, readonly string[]> = {
  moc: ['.moc3', '.moc'],
  texture: ['.png', '.jpg', '.jpeg', '.webp'],
  motion: ['.motion3.json', '.mtn'],
  expression: ['.exp3.json', '.exp.json'],
  sound: ['.wav', '.mp3', '.ogg', '.m4a', '.aac', '.flac', '.webm', '.opus'],
  physics: ['.physics3.json', '.physics.json', '.json'],
  pose: ['.pose3.json', '.pose.json'],
  motionSync: ['.motionsync3.json'],
  displayInfo: ['.cdi3.json'],
  userData: ['.userdata3.json'],
};
const cubism2KnownFields = new Set([
  'version',
  'layout',
  'hit_areas_custom',
  'model',
  'physics',
  'textures',
  'motions',
  'expressions',
]);
const cubism3SingletonFields = {
  Moc: 'moc',
  Physics: 'physics',
  Pose: 'pose',
  MotionSync: 'motionSync',
  DisplayInfo: 'displayInfo',
  UserData: 'userData',
} as const;
const cubism3KnownFields = new Set([
  ...Object.keys(cubism3SingletonFields),
  'Textures',
  'Motions',
  'Expressions',
]);
const maxPathLength = 1024;
const maxReportItems = 256;
const maxIssues = 128;
const invalidPathCodes = new Set([
  'PATH_INVALID',
  'PATH_OUTSIDE_PROJECT',
  'FILE_NOT_REGULAR',
  'FILE_NOT_DIRECTORY',
]);

interface LocationContext {
  config: AppConfig;
  location: Live2dLocation;
  modelPath: string;
  rootPath: string;
  storagePrefix: string;
  project?: ProjectConfig;
  root: string;
}

interface MotionEntry {
  group: string;
  index: number;
  path: string;
  locationPath: string;
  status: Live2dEntryStatus;
  sound?: string;
}

interface ModelAnalysis {
  context: LocationContext;
  report: Live2dModelReport;
  motionEntries: MotionEntry[];
  dependencyLocations: Map<string, string>;
  allDependencies: Live2dDependency[];
  allMotions: Live2dMotion[];
  allExpressions: Live2dExpression[];
  allUnregisteredExpressions: Live2dUnregisteredExpression[];
}

export interface Live2dModelSelectorInspection {
  report: Live2dModelReport;
  motionGroups: ReadonlySet<string>;
  registeredExpressions: ReadonlySet<string>;
  unregisteredExpressions: ReadonlySet<string>;
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExtension(path: string, suffixes: readonly string[]) {
  return suffixes.some(suffix => path.toLowerCase().endsWith(suffix));
}

function validName(value: unknown): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= 256
    && !/[\u0000-\u001f\u007f]/.test(value);
}

function withinRoot(rootPath: string, targetPath: string): boolean {
  return rootPath === ''
    || targetPath === rootPath
    || targetPath.startsWith(`${rootPath}/`);
}

function locationRoot(config: AppConfig, location: Live2dLocation): {
  root: string;
  storagePrefix: string;
  project?: ProjectConfig;
} {
  if (location.kind === 'project') {
    const project = getProject(config, location.projectId);
    return { root: project.root, storagePrefix: 'game/figure/', project };
  }
  const source = config.sources.find(candidate => candidate.id === location.sourceId);
  if (!source) {
    throw new AppError('SOURCE_NOT_AUTHORIZED', 'Source is not authorized.');
  }
  return { root: source.root, storagePrefix: '' };
}

function locationContext(config: AppConfig, location: Live2dLocation): LocationContext {
  const modelPath = modelEntryPath(location.modelPath);
  const inferredRootPath = posix.dirname(modelPath);
  const rootPath = location.rootPath === undefined
    ? inferredRootPath === '.'
      ? ''
      : inferredRootPath
    : validateRelativePath(location.rootPath);
  if (!withinRoot(rootPath, modelPath)) {
    throw new AppError('PATH_INVALID', 'The model entry must be inside rootPath.');
  }
  return {
    config,
    location,
    modelPath,
    rootPath,
    ...locationRoot(config, location),
  };
}

export function modelRelativePath(path: string) {
  if (!path
    || path.length > maxPathLength
    || !validateRelativePath(path)
    || path.split('/').some(segment => segment.startsWith('.'))) {
    throw new AppError('PATH_INVALID', 'The Live2D file path is invalid.');
  }
  return path;
}

export function modelFilePath(path: string) {
  if (!modelRelativePath(path).toLowerCase().endsWith('.model3.json')) {
    throw new AppError('INVALID_ARGUMENT', 'Choose a .model3.json model entry.');
  }
  return path;
}

export function modelEntryPath(path: string) {
  if (!path || path.length > maxPathLength) {
    throw new AppError('PATH_INVALID', 'The Live2D model entry path is invalid.');
  }
  const validated = validateRelativePath(path);
  if (!validated.toLowerCase().endsWith('.json')) {
    throw new AppError('INVALID_ARGUMENT', 'Choose a Live2D model JSON entry.');
  }
  return validated;
}

export function additionalModelAssetPath(path: string) {
  const valid = modelRelativePath(path);
  if (!Object.values(dependencyExtensions).some(suffixes => hasExtension(valid, suffixes))) {
    throw new AppError('INVALID_ARGUMENT', 'Additional files must be supported model, image, or audio assets.');
  }
  return valid;
}

function resolveReference(context: LocationContext, field: string, value: unknown): {
  locationPath: string;
  modelRelativePath: string;
} | undefined {
  if (typeof value !== 'string'
    || value.length === 0
    || value.length > maxPathLength
    || value.includes('\\')
    || value.includes('%')
    || /[\u0000-\u001f\u007f]/.test(value)
    || value.startsWith('/')
    || posix.isAbsolute(value)
    || /^[A-Za-z]:/.test(value)) {
    return undefined;
  }
  const locationPath = posix.normalize(posix.join(posix.dirname(context.modelPath), value));
  if (locationPath === '..'
    || locationPath.startsWith('../')
    || !withinRoot(context.rootPath, locationPath)) {
    return undefined;
  }
  try {
    validateRelativePath(locationPath);
  } catch {
    return undefined;
  }
  return {
    locationPath,
    modelRelativePath: posix.relative(posix.dirname(context.modelPath), locationPath),
  };
}

function storagePath(context: LocationContext, locationPath: string): string {
  return `${context.storagePrefix}${locationPath}`;
}

async function readEntry(context: LocationContext): Promise<{ text: string; revision: string }> {
  const target = storagePath(context, context.modelPath);
  if (context.location.kind === 'project') {
    const document = await readText(context.root, target);
    return { text: document.text, revision: document.revision };
  }
  const source = await readSource(context.config, context.location.sourceId, target);
  return {
    text: new TextDecoder('utf-8', { fatal: true }).decode(source.bytes),
    revision: source.revision,
  };
}

async function probeDependency(context: LocationContext, locationPath: string): Promise<void> {
  const target = storagePath(context, locationPath);
  if (context.location.kind === 'project') {
    await probeRegularFile(context.root, target);
  } else {
    await probeAssetSource(context.config, context.location.sourceId, target);
  }
}

function expressionName(path: string): string {
  return posix.basename(path).replace(/\.exp3?\.json$/i, '');
}

async function scanUnregisteredExpressions(
  context: LocationContext,
  format: Live2dFormat,
): Promise<Live2dUnregisteredExpression[]> {
  if (format === 'unknown') return [];
  const scanRoot = posix.dirname(context.modelPath);
  const storageScanRoot = storagePath(context, scanRoot === '.' ? '' : scanRoot);
  const extensions = format === 'cubism3' ? ['.exp3.json'] : ['.exp.json'];
  let files;
  try {
    files = await listFiles(context.root, storageScanRoot, extensions, { statOnly: true });
  } catch (error) {
    const code = publicError(error).code;
    if (code === 'FILE_NOT_FOUND' || code === 'FILE_NOT_DIRECTORY') return [];
    throw error;
  }
  return files.map(file => {
    const locationPath = context.storagePrefix === ''
      ? file.path
      : file.path.slice(context.storagePrefix.length);
    return {
      name: expressionName(locationPath),
      file: posix.relative(posix.dirname(context.modelPath), locationPath),
    };
  });
}

function countsFor(
  dependencies: Live2dDependency[],
  motions: Live2dMotion[],
  motionFiles: number,
  expressions: Live2dExpression[],
  unregisteredExpressions: Live2dUnregisteredExpression[],
): Live2dCounts {
  const dependencyStatus = (status: Live2dDependency['status']) => (
    dependencies.filter(dependency => dependency.status === status).length
  );
  return {
    dependencies: dependencies.length,
    presentDependencies: dependencyStatus('present'),
    missingDependencies: dependencyStatus('missing'),
    invalidDependencies: dependencyStatus('invalid'),
    unverifiedDependencies: dependencyStatus('unverified'),
    motionGroups: motions.length,
    motionFiles,
    registeredExpressions: expressions.length,
    unregisteredExpressions: unregisteredExpressions.length,
  };
}

function emptyAnalysis(context: LocationContext, report: Live2dModelReport): ModelAnalysis {
  return {
    context,
    report,
    motionEntries: [],
    dependencyLocations: new Map(),
    allDependencies: [],
    allMotions: [],
    allExpressions: [],
    allUnregisteredExpressions: [],
  };
}

async function analyzeLive2dModel(
  config: AppConfig,
  location: Live2dLocation,
  checkpoint?: () => void,
): Promise<ModelAnalysis> {
  const context = locationContext(config, location);
  const report: Live2dModelReport = {
    status: 'valid',
    format: 'unknown',
    modelPath: context.modelPath,
    rootPath: context.rootPath,
    version: null,
    revision: null,
    dependencies: [],
    motions: [],
    expressions: [],
    unregisteredExpressions: [],
    counts: {
      dependencies: 0,
      presentDependencies: 0,
      missingDependencies: 0,
      invalidDependencies: 0,
      unverifiedDependencies: 0,
      motionGroups: 0,
      motionFiles: 0,
      registeredExpressions: 0,
      unregisteredExpressions: 0,
    },
    issues: [],
  };
  const dependencyLocations = new Map<string, string>();
  const dependencyByPath = new Map<string, Live2dDependency>();
  const motionEntries: MotionEntry[] = [];
  const addIssue = (code: string, status: Exclude<Live2dStatus, 'valid'>, field: string, path?: string) => {
    if (report.issues.length < maxIssues) {
      report.issues.push({ code, status, field, ...(path === undefined ? {} : { path }) });
    }
    if (status === 'invalid' || report.status === 'valid') report.status = status;
  };

  checkpoint?.();
  let entry: { text: string; revision: string };
  try {
    entry = await readEntry(context);
    report.revision = entry.revision;
  } catch (error) {
    const code = error instanceof TypeError ? 'UNSUPPORTED_FORMAT' : publicError(error).code;
    if (code === 'SOURCE_NOT_AUTHORIZED') throw error;
    addIssue(
      code === 'FILE_NOT_FOUND' ? 'MODEL_MISSING' : code,
      code === 'FILE_NOT_FOUND' || code === 'UNSUPPORTED_FORMAT' || invalidPathCodes.has(code)
        ? 'invalid'
        : 'unverified',
      'model',
    );
    return emptyAnalysis(context, report);
  }

  checkpoint?.();
  let document: unknown;
  try {
    document = JSON.parse(entry.text);
  } catch {
    addIssue('MODEL_JSON_INVALID', 'invalid', 'model');
    return emptyAnalysis(context, report);
  }
  if (!object(document)) {
    addIssue('MODEL_STRUCTURE_INVALID', 'invalid', 'model');
    return emptyAnalysis(context, report);
  }

  const isCubism3 = Object.hasOwn(document, 'FileReferences')
    || Object.hasOwn(document, 'Version')
    || Object.hasOwn(document, 'Moc');
  const isCubism2 = typeof document.model === 'string'
    && Array.isArray(document.textures);
  report.format = isCubism3 ? 'cubism3' : isCubism2 ? 'cubism2' : 'unknown';
  if (report.format === 'unknown') {
    addIssue('MODEL_FORMAT_UNVERIFIED', 'invalid', 'model');
    return emptyAnalysis(context, report);
  }

  const addDependency = (
    value: unknown,
    kind: Live2dDependencyKind,
    field: string,
  ): { path: string; locationPath: string } | undefined => {
    const resolved = resolveReference(context, field, value);
    if (!resolved) {
      addIssue('DEPENDENCY_PATH_INVALID', 'invalid', field);
      return undefined;
    }
    if (!hasExtension(resolved.locationPath, dependencyExtensions[kind])) {
      addIssue('DEPENDENCY_TYPE_UNVERIFIED', 'unverified', field, resolved.modelRelativePath);
      return undefined;
    }
    if (!dependencyByPath.has(resolved.modelRelativePath)) {
      const dependency: Live2dDependency = {
        kind,
        path: resolved.modelRelativePath,
        status: 'unverified',
      };
      dependencyByPath.set(resolved.modelRelativePath, dependency);
      dependencyLocations.set(resolved.modelRelativePath, resolved.locationPath);
      report.dependencies.push(dependency);
    }
    return { path: resolved.modelRelativePath, locationPath: resolved.locationPath };
  };

  const array = (value: unknown, field: string): unknown[] => {
    if (!Array.isArray(value)) {
      addIssue('MODEL_STRUCTURE_INVALID', 'invalid', field);
      return [];
    }
    return value;
  };

  if (report.format === 'cubism3') {
    report.version = typeof document.Version === 'number'
      && Number.isInteger(document.Version)
      ? document.Version
      : null;
    if (report.version !== 3) {
      addIssue(
        report.version === null ? 'MODEL_STRUCTURE_INVALID' : 'MODEL_VERSION_UNVERIFIED',
        report.version === null ? 'invalid' : 'unverified',
        'Version',
      );
    }
    const refs = document.FileReferences;
    if (!object(refs)) {
      addIssue('MODEL_STRUCTURE_INVALID', 'invalid', 'FileReferences');
      return emptyAnalysis(context, report);
    }
    if (Object.keys(refs).some(key => !cubism3KnownFields.has(key))) {
      addIssue('UNKNOWN_DEPENDENCY_FIELD', 'unverified', 'FileReferences');
    }
    for (const [field, kind] of Object.entries(cubism3SingletonFields)) {
      if (field === 'Moc' || Object.hasOwn(refs, field)) addDependency(refs[field], kind, field);
    }
    const textures = array(refs.Textures, 'Textures');
    if (!textures.length) addIssue('MODEL_STRUCTURE_INVALID', 'invalid', 'Textures');
    for (const texture of textures) addDependency(texture, 'texture', 'Textures');

    const expressionNames = new Set<string>();
    for (const expression of Object.hasOwn(refs, 'Expressions')
      ? array(refs.Expressions, 'Expressions')
      : []) {
      if (!object(expression)
        || !validName(expression.Name)
        || expressionNames.has(expression.Name)) {
        addIssue('MODEL_STRUCTURE_INVALID', 'invalid', 'Expressions');
        continue;
      }
      expressionNames.add(expression.Name);
      const file = addDependency(expression.File, 'expression', 'Expressions.File');
      if (file) report.expressions.push({ name: expression.Name, file: file.path });
    }
    if (Object.hasOwn(refs, 'Motions')) {
      if (!object(refs.Motions)) {
        addIssue('MODEL_STRUCTURE_INVALID', 'invalid', 'Motions');
      } else {
        for (const [group, rawEntries] of Object.entries(refs.Motions)) {
          if (!validName(group)) {
            addIssue('MODEL_STRUCTURE_INVALID', 'invalid', 'Motions');
            continue;
          }
          const entries = array(rawEntries, 'Motions');
          const files: string[] = [];
          for (let index = 0; index < entries.length; index += 1) {
            const motion = entries[index];
            if (!object(motion)) {
              addIssue('MODEL_STRUCTURE_INVALID', 'invalid', 'Motions');
              continue;
            }
            const file = addDependency(motion.File, 'motion', 'Motions.File');
            let sound: string | undefined;
            if (Object.hasOwn(motion, 'Sound')) {
              sound = addDependency(motion.Sound, 'sound', 'Motions.Sound')?.path;
            }
            if (file) {
              files.push(file.path);
              motionEntries.push({
                group,
                index,
                path: file.path,
                locationPath: file.locationPath,
                status: 'unverified',
                ...(sound ? { sound } : {}),
              });
            }
          }
          report.motions.push({ name: group, files });
        }
      }
    }
  } else {
    if (Object.keys(document).some(key => !cubism2KnownFields.has(key))) {
      addIssue('UNKNOWN_DEPENDENCY_FIELD', 'unverified', 'model');
    }
    addDependency(document.model, 'moc', 'model');
    if (Object.hasOwn(document, 'physics')) addDependency(document.physics, 'physics', 'physics');
    if (Object.hasOwn(document, 'pose')) addDependency(document.pose, 'pose', 'pose');
    const textures = array(document.textures, 'textures');
    if (!textures.length) addIssue('MODEL_STRUCTURE_INVALID', 'invalid', 'textures');
    for (const texture of textures) addDependency(texture, 'texture', 'textures');

    const expressionNames = new Set<string>();
    for (const expression of Object.hasOwn(document, 'expressions')
      ? array(document.expressions, 'expressions')
      : []) {
      if (!object(expression)
        || !validName(expression.name)
        || expressionNames.has(expression.name)) {
        addIssue('MODEL_STRUCTURE_INVALID', 'invalid', 'expressions');
        continue;
      }
      expressionNames.add(expression.name);
      const file = addDependency(expression.file, 'expression', 'expressions.file');
      if (file) report.expressions.push({ name: expression.name, file: file.path });
    }
    if (Object.hasOwn(document, 'motions')) {
      if (!object(document.motions)) {
        addIssue('MODEL_STRUCTURE_INVALID', 'invalid', 'motions');
      } else {
        for (const [group, rawEntry] of Object.entries(document.motions)) {
          if (!validName(group)) {
            addIssue('MODEL_STRUCTURE_INVALID', 'invalid', 'motions');
            continue;
          }
          const entries = Array.isArray(rawEntry) ? rawEntry : [rawEntry];
          const files: string[] = [];
          for (let index = 0; index < entries.length; index += 1) {
            const motion = entries[index];
            if (!object(motion)) {
              addIssue('MODEL_STRUCTURE_INVALID', 'invalid', 'motions');
              continue;
            }
            const file = addDependency(motion.file, 'motion', 'motions.file');
            let sound: string | undefined;
            if (Object.hasOwn(motion, 'sound')) {
              sound = addDependency(motion.sound, 'sound', 'motions.sound')?.path;
            }
            if (file) {
              files.push(file.path);
              motionEntries.push({
                group,
                index,
                path: file.path,
                locationPath: file.locationPath,
                status: 'unverified',
                ...(sound ? { sound } : {}),
              });
            }
          }
          report.motions.push({ name: group, files });
        }
      }
    }
  }

  for (const dependency of report.dependencies) {
    checkpoint?.();
    const locationPath = dependencyLocations.get(dependency.path);
    if (!locationPath) continue;
    try {
      await probeDependency(context, locationPath);
      dependency.status = 'present';
    } catch (error) {
      const code = publicError(error).code;
      const status = code === 'FILE_NOT_FOUND'
        ? 'missing'
        : invalidPathCodes.has(code)
          ? 'invalid'
          : 'unverified';
      dependency.status = status;
      addIssue(
        status === 'missing' ? 'DEPENDENCY_MISSING' : code,
        status === 'unverified' ? 'unverified' : 'invalid',
        dependency.kind,
        dependency.path,
      );
    }
  }
  for (const motion of motionEntries) {
    motion.status = dependencyByPath.get(motion.path)?.status ?? 'unverified';
  }

  checkpoint?.();
  const registeredExpressionPaths = new Set(
    report.expressions.map(expression => posix.normalize(posix.join(
      posix.dirname(context.modelPath),
      expression.file,
    ))),
  );
  const unregistered = await scanUnregisteredExpressions(context, report.format);
  report.unregisteredExpressions = unregistered.filter(expression => (
    !registeredExpressionPaths.has(posix.normalize(posix.join(
      posix.dirname(context.modelPath),
      expression.file,
    )))
  ));

  const allDependencies = [...report.dependencies];
  const allMotions = [...report.motions];
  const allExpressions = [...report.expressions];
  const allUnregisteredExpressions = [...report.unregisteredExpressions];
  report.counts = countsFor(
    allDependencies,
    allMotions,
    motionEntries.length,
    allExpressions,
    allUnregisteredExpressions,
  );
  report.dependencies = allDependencies.slice(0, maxReportItems);
  report.motions = allMotions.slice(0, maxReportItems);
  report.expressions = allExpressions.slice(0, maxReportItems);
  report.unregisteredExpressions = allUnregisteredExpressions.slice(0, maxReportItems);
  return {
    context,
    report,
    motionEntries,
    dependencyLocations,
    allDependencies,
    allMotions,
    allExpressions,
    allUnregisteredExpressions,
  };
}

export async function inspectLive2dModel(
  config: AppConfig,
  location: Live2dLocation,
  checkpoint?: () => void,
): Promise<Live2dModelReport> {
  return (await analyzeLive2dModel(config, location, checkpoint)).report;
}

export async function inspectLive2dModelSelectors(
  config: AppConfig,
  location: Live2dLocation,
  checkpoint?: () => void,
): Promise<Live2dModelSelectorInspection> {
  const analysis = await analyzeLive2dModel(config, location, checkpoint);
  return {
    report: analysis.report,
    motionGroups: new Set(analysis.allMotions.map(motion => motion.name)),
    registeredExpressions: new Set(analysis.allExpressions.map(expression => expression.name)),
    unregisteredExpressions: new Set(
      analysis.allUnregisteredExpressions.map(expression => expression.name),
    ),
  };
}

function catalogItems(analysis: ModelAnalysis): Live2dCatalogItem[] {
  const items: Live2dCatalogItem[] = [];
  const dependencyStatus = new Map(analysis.allDependencies.map(file => [file.path, file.status]));
  for (const motion of analysis.motionEntries) {
    items.push({
      kind: 'motion',
      id: `motion:${motion.group}:${motion.index}`,
      name: motion.group,
      path: motion.path,
      status: motion.status,
      fingerprint: null,
      rootRelativePath: motion.locationPath,
      motionGroup: motion.group,
      motionIndex: motion.index,
      ...(motion.sound === undefined ? {} : { sound: motion.sound }),
    });
  }
  for (const expression of analysis.allExpressions) {
    const fileStatus = dependencyStatus.get(expression.file);
    items.push({
      kind: 'expression',
      id: `expression:registered:${expression.name}:${expression.file}`,
      name: expression.name,
      path: expression.file,
      status: fileStatus === 'present' ? 'registered' : fileStatus ?? 'unverified',
      fingerprint: null,
      rootRelativePath: posix.normalize(posix.join(
        posix.dirname(analysis.report.modelPath),
        expression.file,
      )),
    });
  }
  for (const expression of analysis.allUnregisteredExpressions) {
    items.push({
      kind: 'expression',
      id: `expression:unregistered:${expression.file}`,
      name: expression.name,
      path: expression.file,
      status: 'unregistered',
      fingerprint: null,
      rootRelativePath: posix.normalize(posix.join(
        posix.dirname(analysis.report.modelPath),
        expression.file,
      )),
    });
  }
  for (const dependency of analysis.allDependencies) {
    const locationPath = analysis.dependencyLocations.get(dependency.path);
    items.push({
      kind: 'dependency',
      id: `dependency:${dependency.kind}:${dependency.path}`,
      name: dependency.kind,
      path: dependency.path,
      status: dependency.status,
      fingerprint: null,
      ...(locationPath ? { rootRelativePath: locationPath } : {}),
    });
  }
  return items;
}

async function fingerprintFile(
  context: LocationContext,
  locationPath: string,
): Promise<string | null> {
  const target = storagePath(context, locationPath);
  try {
    if (context.location.kind === 'project') {
      return (await readText(context.root, target)).revision;
    }
    return (await readSource(context.config, context.location.sourceId, target)).revision;
  } catch {
    return null;
  }
}

async function attachFingerprints(
  analysis: ModelAnalysis,
  items: Live2dCatalogItem[],
  checkpoint?: () => void,
): Promise<Live2dCatalogItem[]> {
  const fingerprints = new Map<string, string | null>();
  const result: Live2dCatalogItem[] = [];
  for (const item of items) {
    checkpoint?.();
    if (item.kind === 'dependency' || item.rootRelativePath === undefined) {
      result.push(item);
      continue;
    }
    let fingerprint = fingerprints.get(item.rootRelativePath);
    if (fingerprint === undefined) {
      fingerprint = await fingerprintFile(analysis.context, item.rootRelativePath);
      fingerprints.set(item.rootRelativePath, fingerprint);
    }
    result.push({ ...item, fingerprint });
  }
  return result;
}

export async function snapshotLive2dCatalog(
  config: AppConfig,
  location: Live2dLocation,
  checkpoint?: () => void,
): Promise<Live2dCatalogSnapshot> {
  const analysis = await analyzeLive2dModel(config, location, checkpoint);
  return {
    report: analysis.report,
    items: await attachFingerprints(analysis, catalogItems(analysis), checkpoint),
  };
}

export async function listLive2dModelEntries(
  config: AppConfig,
  location: Live2dLocation,
  query: Live2dEntryQuery = {},
  checkpoint?: () => void,
): Promise<Live2dEntryPage> {
  const offset = query.offset ?? 0;
  const limit = query.limit ?? 100;
  if (!Number.isSafeInteger(offset) || offset < 0) {
    throw new AppError('INVALID_ARGUMENT', 'offset must be a non-negative integer.');
  }
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw new AppError('INVALID_ARGUMENT', 'limit must be between 1 and 100.');
  }
  if (query.prefix !== undefined
    && (typeof query.prefix !== 'string'
      || query.prefix.length > 256
      || /[\u0000-\u001f\u007f]/.test(query.prefix))) {
    throw new AppError('INVALID_ARGUMENT', 'prefix is invalid.');
  }
  const includeUnregistered = query.includeUnregistered ?? true;
  const analysis = await analyzeLive2dModel(config, location, checkpoint);
  if (query.expectedRevision !== undefined && query.expectedRevision !== analysis.report.revision) {
    throw new AppError('SOURCE_CHANGED', 'The model entry changed. Restart the entry list.');
  }
  let items = catalogItems(analysis);
  if (query.kind !== undefined) items = items.filter(item => item.kind === query.kind);
  if (query.prefix !== undefined) {
    items = items.filter(item => item.name.startsWith(query.prefix!));
  }
  if (!includeUnregistered) {
    items = items.filter(item => item.status !== 'unregistered');
  }
  const end = Math.min(offset + limit, items.length);
  const pageItems = await attachFingerprints(analysis, items.slice(offset, end), checkpoint);
  return {
    modelPath: analysis.report.modelPath,
    rootPath: analysis.report.rootPath,
    format: analysis.report.format,
    revision: analysis.report.revision,
    query: {
      kind: query.kind ?? null,
      prefix: query.prefix ?? null,
      includeUnregistered,
    },
    total: items.length,
    offset,
    limit,
    nextOffset: end < items.length ? end : null,
    counts: analysis.report.counts,
    items: pageItems,
  };
}
