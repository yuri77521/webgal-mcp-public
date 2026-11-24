import { posix } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { listLive2dModelEntries } from './model.js';
import type {
  Live2dCatalogItem,
  Live2dEntryKind,
  Live2dEntryQuery,
  Live2dFormat,
  Live2dLocation,
} from './types.js';
import { AppError } from '../errors.js';
import { validateRelativePath } from '../filesystem.js';
import type { AppConfig } from '../types.js';

export interface MotionImportSelection {
  name: string;
  memberIndex?: number;
  outputName?: string;
}

export interface ExpressionImportSelection {
  name: string;
  file?: string;
}

export interface MotionMapping {
  sourceGroup: string;
  sourceMemberIndex: number;
  targetGroup: string;
  targetMemberIndex: number;
  sourceFile: string;
  file: string;
  sourceSound?: string;
  sound?: string;
  action: 'add' | 'unchanged';
  value: Record<string, unknown>;
}

export interface ExpressionMapping {
  name: string;
  sourceFile: string;
  file: string;
  previouslyUnregistered: boolean;
  targetExpressionIndex: number;
  action: 'add' | 'unchanged';
  value: Record<string, unknown>;
}

export interface ManifestReference {
  kind: string;
  path: string;
}

export interface GameEntryReview {
  action: 'create' | 'update' | 'unchanged';
  path: string;
  revisions: {
    before: string | null;
    after: string;
  };
  motions: MotionMapping[];
  expressions: ExpressionMapping[];
  references: Array<ManifestReference & { action: 'add' | 'unchanged' }>;
  unchanged: {
    motionGroups: number;
    motionMembers: number;
    expressions: number;
    references: number;
  };
}

export interface BuiltManifest {
  document: Record<string, unknown>;
  bytes: Buffer;
  changed: boolean;
  motions: MotionMapping[];
  expressions: ExpressionMapping[];
}

export interface PortableManifest {
  document: Record<string, unknown>;
  modelPackagePath: string;
  pathMap: ReadonlyMap<string, string>;
  rewriteReference: (value: string) => string;
}

const controlCharacters = /[\u0000-\u001f\u007f]/;
const unportableNameCharacters = /\s-|[;{}\\*#%&?@"<>|:]/u;

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validCallableName(value: string, label: string) {
  if (!value || value.trim() !== value || value.length > 256 || controlCharacters.test(value)
    || unportableNameCharacters.test(value)) {
    throw new AppError('INVALID_ARGUMENT', `${label} is not a safe WebGAL callable name.`);
  }
  return value;
}

function safeMemberIndex(value: number | undefined) {
  const index = value ?? 0;
  if (!Number.isSafeInteger(index) || index < 0) {
    throw new AppError('INVALID_ARGUMENT', 'A motion memberIndex must be a non-negative integer.');
  }
  return index;
}

function cloneDocument(value: unknown): Record<string, unknown> {
  if (!object(value)) throw new AppError('MODEL_STRUCTURE_INVALID', 'The Live2D manifest is not a JSON object.');
  return structuredClone(value);
}

function cubism3References(document: Record<string, unknown>) {
  const refs = document.FileReferences;
  if (!object(refs)) throw new AppError('MODEL_STRUCTURE_INVALID', 'The Cubism 3 FileReferences object is missing.');
  return refs;
}

function manifestFileKey(item: Live2dCatalogItem) {
  if (typeof item.path !== 'string' || item.path.length === 0) {
    throw new AppError('MODEL_STRUCTURE_INVALID', 'A selected Live2D entry has no file path.');
  }
  return item.path;
}

function motionMembers(value: unknown, format: Live2dFormat): unknown[] {
  if (format === 'cubism2' && object(value)) return [value];
  return Array.isArray(value) ? value : [];
}

function motionMember(value: unknown, index: number, format: Live2dFormat) {
  const members = motionMembers(value, format);
  const member = members[index];
  if (!object(member)) {
    throw new AppError('MOTION_NOT_FOUND', 'The selected motion member disappeared from the source manifest.');
  }
  return structuredClone(member);
}

function motionMemberFile(value: Record<string, unknown>, format: Live2dFormat) {
  const file = format === 'cubism3' ? value.File : value.file;
  if (typeof file !== 'string' || !file) {
    throw new AppError('MODEL_STRUCTURE_INVALID', 'A selected motion member has no file reference.');
  }
  return file;
}

function motionMemberSound(value: Record<string, unknown>, format: Live2dFormat) {
  const sound = format === 'cubism3' ? value.Sound : value.sound;
  return typeof sound === 'string' && sound ? sound : undefined;
}

function expressionObject(
  sourceRefs: Record<string, unknown>,
  item: Live2dCatalogItem,
  name: string,
  format: Live2dFormat,
  rewriteReference: (value: string) => string,
) {
  if (item.status === 'registered') {
    const match = sourceExpressions(sourceRefs).find(entry => object(entry)
      && (format === 'cubism3'
        ? entry.Name === name
        : entry.name === name));
    if (object(match)) return structuredClone(match);
  }
  return format === 'cubism3'
    ? { Name: name, File: rewriteReference(manifestFileKey(item)) }
    : { name, file: rewriteReference(manifestFileKey(item)) };
}

function sourceMotions(refs: Record<string, unknown>): Record<string, unknown> {
  const motions = object(refs.Motions) ? refs.Motions : object(refs.motions) ? refs.motions : {};
  return motions;
}

function sourceExpressions(refs: Record<string, unknown>) {
  if (Array.isArray(refs.Expressions)) return refs.Expressions;
  if (Array.isArray(refs.expressions)) return refs.expressions;
  return [];
}

function assignMotions(refs: Record<string, unknown>, format: Live2dFormat, motions: Record<string, unknown>) {
  if (format === 'cubism3') refs.Motions = motions;
  else refs.motions = motions;
}

function assignExpressions(refs: Record<string, unknown>, format: Live2dFormat, expressions: Record<string, unknown>[]) {
  if (format === 'cubism3') refs.Expressions = expressions;
  else refs.expressions = expressions;
}

function referencesOf(document: Record<string, unknown>, format: Live2dFormat) {
  if (format === 'cubism3') return cubism3References(document);
  return document;
}

function defaultTargetGroup(
  selection: MotionImportSelection,
  duplicateSourceGroup: boolean,
) {
  if (selection.outputName) return validCallableName(selection.outputName, 'The motion outputName');
  const index = safeMemberIndex(selection.memberIndex);
  if (duplicateSourceGroup || index > 0) {
    return validCallableName(`${selection.name}_${index + 1}`, 'The generated motion outputName');
  }
  return validCallableName(selection.name, 'The motion group name');
}

export async function readAllLive2dEntries(
  config: AppConfig,
  location: Live2dLocation,
  kind?: Live2dEntryKind,
  includeUnregistered = true,
) {
  const items: Live2dCatalogItem[] = [];
  let offset = 0;
  let revision: string | null = null;
  for (;;) {
    const query: Live2dEntryQuery = {
      ...(kind ? { kind } : {}),
      includeUnregistered,
      offset,
      limit: 100,
      ...(revision ? { expectedRevision: revision } : {}),
    };
    const page = await listLive2dModelEntries(config, location, query);
    revision ??= page.revision;
    items.push(...page.items);
    if (page.nextOffset === null) return { items, page };
    offset = page.nextOffset;
  }
}

export function selectMotionEntries(entries: Live2dCatalogItem[], selections: MotionImportSelection[]) {
  const selected = selections.map(selection => {
    const memberIndex = safeMemberIndex(selection.memberIndex);
    const matches = entries.filter(entry => entry.kind === 'motion'
      && entry.motionGroup === selection.name
      && entry.motionIndex === memberIndex);
    if (matches.length !== 1) {
      throw new AppError(matches.length ? 'AMBIGUOUS_MOTION' : 'MOTION_NOT_FOUND',
        matches.length ? 'The requested motion member is ambiguous.' : 'The requested motion member was not found.');
    }
    return { selection, item: matches[0]!, memberIndex };
  });
  const counts = new Map<string, number>();
  for (const { selection } of selected) counts.set(selection.name, (counts.get(selection.name) ?? 0) + 1);
  return selected.map(entry => ({ ...entry, duplicateSourceGroup: (counts.get(entry.selection.name) ?? 0) > 1 }));
}

export function selectExpressionEntries(entries: Live2dCatalogItem[], selections: ExpressionImportSelection[]) {
  return selections.map(selection => {
    const matches = entries.filter(entry => entry.kind === 'expression'
      && entry.name === selection.name
      && (selection.file === undefined || entry.path === selection.file));
    if (matches.length !== 1) {
      throw new AppError(matches.length ? 'AMBIGUOUS_EXPRESSION' : 'EXPRESSION_NOT_FOUND',
        matches.length ? 'The requested expression is ambiguous; provide its file path.' : 'The requested expression was not found.');
    }
    return { selection, item: matches[0]! };
  });
}

export function buildSelectedManifest(
  sourceDocument: Record<string, unknown>,
  format: Live2dFormat,
  motions: ReturnType<typeof selectMotionEntries>,
  expressions: ReturnType<typeof selectExpressionEntries>,
  existingDocument: Record<string, unknown> | null,
  rewriteReference: (value: string) => string,
): BuiltManifest {
  const sourceView = cloneDocument(sourceDocument);
  const sourceRefs = referencesOf(sourceView, format);
  const target = cloneDocument(existingDocument ?? sourceDocument);
  const targetRefs = referencesOf(target, format);
  const targetMotions = existingDocument ? { ...sourceMotions(targetRefs) } : {};
  const targetExpressions = existingDocument ? [...sourceExpressions(targetRefs)] : [];
  const motionMappings: MotionMapping[] = [];

  for (const { selection, item, memberIndex, duplicateSourceGroup } of motions) {
    const sourceGroup = sourceMotions(sourceRefs)[selection.name];
    const candidate = motionMember(sourceGroup, memberIndex, format);
    const targetGroup = defaultTargetGroup(selection, duplicateSourceGroup);
    let action: 'add' | 'unchanged' = 'add';
    let targetMemberIndex = 0;
    if (Object.hasOwn(targetMotions, targetGroup)) {
      const entries = targetMotions[targetGroup];
      if (motionMembers(entries, format).length !== 1
        || !isDeepStrictEqual(motionMembers(entries, format)[0], candidate)) {
        throw new AppError('TARGET_CONFLICT', `The target motion group ${targetGroup} already exists with different content.`);
      }
      action = 'unchanged';
    } else {
      targetMotions[targetGroup] = [candidate];
    }
    motionMappings.push({
      sourceGroup: selection.name,
      sourceMemberIndex: memberIndex,
      targetGroup,
      targetMemberIndex,
      sourceFile: manifestFileKey(item),
      file: motionMemberFile(candidate, format),
      ...(item.sound ? { sourceSound: item.sound } : {}),
      ...(motionMemberSound(candidate, format) ? { sound: motionMemberSound(candidate, format)! } : {}),
      action,
      value: candidate,
    });
  }
  assignMotions(targetRefs, format, targetMotions);

  const expressionMappings: ExpressionMapping[] = [];
  for (const { selection, item } of expressions) {
    const name = validCallableName(selection.name, 'The expression name');
    const candidate = expressionObject(sourceRefs, item, name, format, rewriteReference);
    let action: 'add' | 'unchanged' = 'add';
    const existing = targetExpressions.find(entry => object(entry)
      && (format === 'cubism3' ? entry.Name === name : entry.name === name));
    if (existing) {
      if (!isDeepStrictEqual(existing, candidate)) {
        throw new AppError('TARGET_CONFLICT', `The target expression ${name} already exists with different content.`);
      }
      action = 'unchanged';
    } else {
      targetExpressions.push(candidate);
    }
    const targetExpressionIndex = targetExpressions.indexOf(
      existing ?? targetExpressions[targetExpressions.length - 1],
    );
    expressionMappings.push({
      name,
      sourceFile: manifestFileKey(item),
      file: format === 'cubism3' ? String(candidate.File) : String(candidate.file),
      previouslyUnregistered: item.status === 'unregistered',
      targetExpressionIndex,
      action,
      value: candidate,
    });
  }
  assignExpressions(targetRefs, format, targetExpressions);

  const bytes = Buffer.from(`${JSON.stringify(target, null, 2)}\n`);
  return {
    document: target,
    bytes,
    changed: !existingDocument || JSON.stringify(target) !== JSON.stringify(existingDocument),
    motions: motionMappings,
    expressions: expressionMappings,
  };
}

function portableSegment(segment: string) {
  return segment.startsWith('.') ? `_${segment.slice(1)}` : segment;
}

export function portablePackagePath(path: string) {
  return path.split('/').map(portableSegment).join('/');
}

function rewriteValue(
  value: unknown,
  rewriteReference: (value: string) => string | undefined,
) {
  if (typeof value !== 'string') return value;
  return rewriteReference(value) ?? value;
}

export function makeManifestPortable(
  sourceDocument: Record<string, unknown>,
  format: Live2dFormat,
  modelPath: string,
  rootPath: string,
): PortableManifest {
  const document = cloneDocument(sourceDocument);
  const pathMap = new Map<string, string>();
  const portableBySource = new Map<string, string>();
  const modelPackagePath = packageRelativePath(rootPath, modelPath);
  const portableModelPath = portablePackagePath(modelPackagePath);
  const addPortablePath = (sourcePath: string, value: string) => {
    const locationPath = validateRelativePath(posix.normalize(posix.join(posix.dirname(sourcePath), value)));
    if (locationPath === '..'
      || locationPath.startsWith('../')
      || (rootPath !== '' && locationPath !== rootPath && !locationPath.startsWith(`${rootPath}/`))) {
      return undefined;
    }
    const packagePath = packageRelativePath(rootPath, locationPath);
    const portable = portablePackagePath(packagePath);
    const previous = portableBySource.get(packagePath);
    if (previous && previous !== portable) return undefined;
    portableBySource.set(packagePath, portable);
    pathMap.set(locationPath, portable);
    return portable;
  };
  addPortablePath(modelPath, modelPackagePath);
  const rewriteReference = (value: string) => {
    const portable = addPortablePath(modelPath, value);
    return portable === undefined
      ? undefined
      : posix.relative(posix.dirname(portableModelPath), portable);
  };
  const refs = referencesOf(document, format);
  if (format === 'cubism3') {
    for (const field of ['Moc', 'Physics', 'Pose', 'MotionSync', 'DisplayInfo', 'UserData']) {
      refs[field] = rewriteValue(refs[field], rewriteReference);
    }
    refs.Textures = Array.isArray(refs.Textures)
      ? refs.Textures.map(value => rewriteValue(value, rewriteReference))
      : refs.Textures;
    if (Array.isArray(refs.Expressions)) {
      refs.Expressions = refs.Expressions.map(entry => object(entry)
        ? { ...entry, File: rewriteValue(entry.File, rewriteReference) }
        : entry);
    }
    if (object(refs.Motions)) {
      refs.Motions = Object.fromEntries(Object.entries(refs.Motions).map(([group, value]) => [
        group,
        motionMembers(value, format).map(entry => object(entry)
          ? {
            ...entry,
            File: rewriteValue(entry.File, rewriteReference),
            ...(Object.hasOwn(entry, 'Sound')
              ? { Sound: rewriteValue(entry.Sound, rewriteReference) }
              : {}),
          }
          : entry),
      ]));
    }
  } else {
    for (const field of ['model', 'physics', 'pose']) {
      refs[field] = rewriteValue(refs[field], rewriteReference);
    }
    refs.textures = Array.isArray(refs.textures)
      ? refs.textures.map(value => rewriteValue(value, rewriteReference))
      : refs.textures;
    if (Array.isArray(refs.expressions)) {
      refs.expressions = refs.expressions.map(entry => object(entry)
        ? { ...entry, file: rewriteValue(entry.file, rewriteReference) }
        : entry);
    }
    if (object(refs.motions)) {
      refs.motions = Object.fromEntries(Object.entries(refs.motions).map(([group, value]) => [
        group,
        motionMembers(value, format).map(entry => object(entry)
          ? {
            ...entry,
            file: rewriteValue(entry.file, rewriteReference),
            ...(Object.hasOwn(entry, 'sound')
              ? { sound: rewriteValue(entry.sound, rewriteReference) }
              : {}),
          }
          : entry),
      ]));
    }
  }
  const collision = new Map<string, string>();
  for (const [sourcePath, portablePath] of pathMap) {
    const key = portablePath.normalize('NFC').toLowerCase();
    const previous = collision.get(key);
    if (previous && previous !== sourcePath) {
      throw new AppError('TARGET_CONFLICT', 'Portable Live2D paths collide after hidden-directory renaming.');
    }
    collision.set(key, sourcePath);
  }
  return {
    document,
    modelPackagePath: portableModelPath,
    pathMap,
    rewriteReference: (value: string) => {
      const rewritten = rewriteReference(value);
      if (rewritten === undefined) {
        throw new AppError('TARGET_CONFLICT', 'The selected Live2D entry changed during path rewriting.');
      }
      return rewritten;
    },
  };
}

function addReference(
  references: ManifestReference[],
  seen: Set<string>,
  kind: string,
  value: unknown,
) {
  if (typeof value !== 'string') return;
  const path = value;
  const key = `${kind}\0${path}`;
  if (seen.has(key)) return;
  seen.add(key);
  references.push({ kind, path });
}

function manifestReferences(document: Record<string, unknown> | null, format: Live2dFormat) {
  const references: ManifestReference[] = [];
  const seen = new Set<string>();
  if (!document || format === 'unknown') return references;
  const refs = referencesOf(document, format);
  if (format === 'cubism3') {
    for (const [field, kind] of [
      ['Moc', 'moc'],
      ['Physics', 'physics'],
      ['Pose', 'pose'],
      ['MotionSync', 'motionSync'],
      ['DisplayInfo', 'displayInfo'],
      ['UserData', 'userData'],
    ] as const) {
      addReference(references, seen, kind, refs[field]);
    }
    for (const texture of Array.isArray(refs.Textures) ? refs.Textures : []) {
      addReference(references, seen, 'texture', texture);
    }
    for (const entry of sourceExpressions(refs)) {
      if (object(entry)) addReference(references, seen, 'expression', entry.File);
    }
    for (const entries of Object.values(sourceMotions(refs))) {
      for (const entry of motionMembers(entries, format)) {
        if (!object(entry)) continue;
        addReference(references, seen, 'motion', entry.File);
        addReference(references, seen, 'sound', entry.Sound);
      }
    }
  } else {
    for (const [field, kind] of [
      ['model', 'moc'],
      ['physics', 'physics'],
      ['pose', 'pose'],
    ] as const) {
      addReference(references, seen, kind, refs[field]);
    }
    for (const texture of Array.isArray(refs.textures) ? refs.textures : []) {
      addReference(references, seen, 'texture', texture);
    }
    for (const entry of sourceExpressions(refs)) {
      if (object(entry)) addReference(references, seen, 'expression', entry.file);
    }
    for (const entries of Object.values(sourceMotions(refs))) {
      for (const entry of motionMembers(entries, format)) {
        if (!object(entry)) continue;
        addReference(references, seen, 'motion', entry.file);
        addReference(references, seen, 'sound', entry.sound);
      }
    }
  }
  return references.sort((left, right) => (
    left.kind.localeCompare(right.kind) || left.path.localeCompare(right.path)
  ));
}

export function live2dManifestReferences(
  document: Record<string, unknown> | null,
  format: Live2dFormat,
) {
  return manifestReferences(document, format);
}

export function baseManifestReferences(
  document: Record<string, unknown> | null,
  format: Live2dFormat,
) {
  const references: ManifestReference[] = [];
  if (!document || format === 'unknown') return references;
  const refs = referencesOf(document, format);
  const push = (kind: string, value: unknown) => {
    if (typeof value === 'string') references.push({ kind, path: value });
  };
  if (format === 'cubism3') {
    for (const [field, kind] of [
      ['Moc', 'moc'],
      ['Physics', 'physics'],
      ['Pose', 'pose'],
      ['MotionSync', 'motionSync'],
      ['DisplayInfo', 'displayInfo'],
      ['UserData', 'userData'],
    ] as const) push(kind, refs[field]);
    for (const texture of Array.isArray(refs.Textures) ? refs.Textures : []) {
      push('texture', texture);
    }
  } else {
    for (const [field, kind] of [
      ['model', 'moc'],
      ['physics', 'physics'],
      ['pose', 'pose'],
    ] as const) push(kind, refs[field]);
    for (const texture of Array.isArray(refs.textures) ? refs.textures : []) {
      push('texture', texture);
    }
  }
  return references;
}

export function buildGameEntryReview(
  targetPath: string,
  beforeDocument: Record<string, unknown> | null,
  afterDocument: Record<string, unknown>,
  format: Live2dFormat,
  beforeRevision: string | null,
  afterRevision: string,
  manifest: BuiltManifest,
): GameEntryReview {
  const action = beforeDocument === null
    ? 'create'
    : manifest.changed ? 'update' : 'unchanged';
  const beforeReferences = manifestReferences(beforeDocument, format);
  const beforeReferenceKeys = new Set(beforeReferences.map(item => `${item.kind}\0${item.path}`));
  const references = manifestReferences(afterDocument, format).map(item => ({
    ...item,
    action: beforeReferenceKeys.has(`${item.kind}\0${item.path}`) ? 'unchanged' as const : 'add' as const,
  }));
  const afterMotionGroups = sourceMotions(referencesOf(afterDocument, format));
  const afterMotionMembers = Object.values(afterMotionGroups)
    .reduce<number>((total, entries) => total + motionMembers(entries, format).length, 0);
  const afterExpressions = referencesOf(afterDocument, format);
  const addedMotionGroups = new Set(manifest.motions
    .filter(item => item.action === 'add')
    .map(item => item.targetGroup)).size;
  const addedMotionMembers = manifest.motions.filter(item => item.action === 'add').length;
  const addedExpressions = manifest.expressions.filter(item => item.action === 'add').length;
  return {
    action,
    path: targetPath,
    revisions: {
      before: beforeRevision,
      after: afterRevision,
    },
    motions: manifest.motions,
    expressions: manifest.expressions,
    references,
    unchanged: {
      motionGroups: Math.max(0, Object.keys(afterMotionGroups).length - addedMotionGroups),
      motionMembers: Math.max(0, afterMotionMembers - addedMotionMembers),
      expressions: Math.max(0, sourceExpressions(afterExpressions).length - addedExpressions),
      references: references.filter(item => item.action === 'unchanged').length,
    },
  };
}

export function packageRelativePath(rootPath: string, sourcePath: string) {
  const root = rootPath === '' ? '' : validateRelativePath(rootPath);
  const path = validateRelativePath(sourcePath);
  if (root === '') return path;
  if (!path.startsWith(`${root}/`)) {
    throw new AppError('PATH_OUTSIDE_PROJECT', 'The selected Live2D file is outside the package root.');
  }
  return path.slice(root.length + 1);
}

export function sourcePathForCatalogItem(modelPath: string, item: Live2dCatalogItem) {
  return validateRelativePath(item.rootRelativePath
    ?? posix.normalize(posix.join(posix.dirname(modelPath), item.path)));
}
