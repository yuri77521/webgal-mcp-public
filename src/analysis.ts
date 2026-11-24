import SceneParserImport, {
  ADD_NEXT_ARG_LIST,
  SCRIPT_CONFIG,
} from 'webgal-parser';
import { AppError } from './errors.js';
import { LIMITS } from './types.js';
import type { Live2dSceneCheck, Live2dSceneIssue } from './live2d/scene.js';

const SceneParserCtor = (
  typeof SceneParserImport === 'function'
    ? SceneParserImport
    : (SceneParserImport as unknown as { default: typeof SceneParserImport }).default
) as typeof SceneParserImport;

const ASSET_FOLDERS = [
  'background',
  'bgm',
  'figure',
  'scene',
  'tex',
  'vocal',
  'video',
] as const;

const COMMAND_NAME_BY_TYPE = new Map<number, string>(
  (SCRIPT_CONFIG as Array<{ scriptString: string; scriptType: number }>).map(
    ({ scriptString, scriptType }) => [scriptType, scriptString],
  ),
);

export const KNOWN_CONFIG_KEYS = new Set([
  'Game_name',
  'Game_key',
  'Description',
  'Package_name',
  'Steam_AppID',
  'Cubism_Memory_Reserved_Size_MB',
  'Title_img',
  'Title_bgm',
  'Title_logos',
  'Game_Logo',
  'Show_panic',
  'Enable_Appreciation',
  'Enable_flowchart',
  'Flowchart_Locked_Node_Visibility',
  'Enable_Continue',
  'Default_Language',
  'Textbox_theme',
  'Max_line',
  'Line_height',
  'Legacy_Expression_Blend_Mode',
]);

const REFERENCE_KIND_BY_COMMAND = new Map<string, ReferenceKind>([
  ['changeBg', 'background'],
  ['changeFigure', 'figure'],
  ['changeFigureDiff', 'figure'],
  ['miniAvatar', 'figure'],
  ['bgm', 'bgm'],
  ['playVideo', 'video'],
  ['changeScene', 'scene'],
  ['callScene', 'scene'],
  ['playEffect', 'vocal'],
  ['unlockCg', 'background'],
  ['unlockBgm', 'bgm'],
]);

const MANUAL_REFERENCE_COMMANDS = new Set([
  'playEffect',
  'unlockCg',
  'unlockBgm',
]);

const UNSUPPORTED_REFERENCE_COMMANDS = new Set([
  'character',
  'pixiPerform',
  'pixiInit',
  'setComplexAnimation',
  'setFilter',
  'setAnimation',
  'setTempAnimation',
  'setTransition',
  'applyStyle',
]);

const MAX_REFERENCE_PATH_CHARS = 2048;
const MAX_REFERENCE_DISPLAY_CHARS = 512;
const MAX_CONFIG_VALUE_CHARS = 2048;

type Severity = 'error' | 'warning' | 'info';
type ReferenceKind =
  | 'background'
  | 'bgm'
  | 'figure'
  | 'scene'
  | 'tex'
  | 'vocal'
  | 'video'
  | 'unknown';
type UnresolvedReason =
  | 'missing'
  | 'dynamic'
  | 'remote-url'
  | 'none'
  | 'invalid-path'
  | 'check-failed'
  | 'unsupported-static-semantics'
  | 'complex-character-dependency';

export interface Diagnostic {
  startLine: number;
  endLine: number;
  message: string;
  severity: Severity;
  code: string;
}

export interface StaticReference {
  path: string;
  kind: ReferenceKind;
  startLine: number;
  endLine: number;
  exists: boolean;
}

export interface UnresolvedReference {
  value: string;
  kind: ReferenceKind;
  startLine: number;
  endLine: number;
  reason: UnresolvedReason;
}

export interface SentenceSummary {
  startLine: number;
  endLine: number;
  command: string;
}

export interface ConfigItemSummary {
  line: number;
  command: string;
  args: Array<string>;
  options: Array<{ key: string; value: string | number | boolean }>;
  known: boolean;
  duplicateOfLine?: number;
}

export interface SceneAnalysis {
  sentenceCount: number;
  sentences: SentenceSummary[];
  diagnostics: Diagnostic[];
  staticReferences: StaticReference[];
  unresolvedReferences: UnresolvedReference[];
  live2dIssues: Live2dSceneIssue[];
  limitations: string[];
}

export interface ConfigAnalysis {
  itemCount: number;
  items: ConfigItemSummary[];
  diagnostics: Diagnostic[];
  limitations: string[];
}

interface ParsedAsset {
  url: string;
  type: number;
}

interface ParsedSentence {
  command: number;
  commandRaw: string;
  content: string;
  args: { key: string; value: string | number | boolean }[];
  sentenceAssets: ParsedAsset[];
  subScene: string[];
  startLine: number;
  endLine: number;
  isLineBreakHolder: boolean;
}

interface ParsedScene {
  sentenceList: ParsedSentence[];
}

interface ParsedConfigItem {
  command: string;
  args: string[];
  options: Array<{ key: string; value: string | number | boolean }>;
}

type WebgalConfig = ParsedConfigItem[];

const parser = new SceneParserCtor(
  () => {},
  (fileName: string, assetType: number) => {
    if (isRemoteUrl(fileName)) {
      return fileName;
    }
    const folder = ASSET_FOLDERS[assetType] ?? 'unknown';
    return `game/${folder}/${fileName}`;
  },
  ADD_NEXT_ARG_LIST,
  SCRIPT_CONFIG,
);

export async function analyzeScene(
  text: string,
  scenePath: string,
  exists: (projectRelativePath: string) => Promise<boolean>,
  { checkpoint, onResponseTruncated, checkLive2d }: {
    checkpoint?: () => void;
    onResponseTruncated?: () => void;
    checkLive2d?: Live2dSceneCheck;
  } = {},
): Promise<SceneAnalysis> {
  checkpoint?.();
  ensureTextWithinLimit(text, 'Scene text');
  if (typeof exists !== 'function') {
    throw new AppError('INVALID_ARGUMENT', 'exists must be a function.');
  }

  const normalizedScenePath = normalizeScenePath(scenePath);
  const parseText = stripBom(text);
  const scene = parser.parse(
    parseText,
    normalizedScenePath,
    `game/scene/${normalizedScenePath}`,
  ) as unknown as ParsedScene;
  const sceneLines = parseText.replaceAll('\r', '').split('\n');
  const sentences = scene.sentenceList.filter(
    (sentence) => !sentence.isLineBreakHolder,
  );
  const diagnostics: Diagnostic[] = [];
  const staticReferences: StaticReference[] = [];
  const unresolvedReferences: UnresolvedReference[] = [];
  const existenceCache = new Map<string, Promise<boolean>>();
  const live2dIssues: Live2dSceneIssue[] = [];
  const live2dIssueLimit = 128;
  let live2dTruncated = false;

  for (const sentence of sentences) {
    checkpoint?.();
    const startLine = sentence.startLine + 1;
    const endLine = sentence.endLine + 1;
    const rawContent = rawSentenceContent(sceneLines, sentence);
    if (checkLive2d && !live2dTruncated && sentence.commandRaw === 'changeFigure'
      && rawContent.toLowerCase().endsWith('.json')) {
      const issues = await checkLive2d({
        rawPath: rawContent,
        dynamicPath: hasDynamicToken(rawContent),
        line: startLine,
        endLine,
        motion: sentence.args.find(arg => arg.key === 'motion')?.value,
        expression: sentence.args.find(arg => arg.key === 'expression')?.value,
      });
      const available = live2dIssueLimit - live2dIssues.length;
      live2dIssues.push(...issues.slice(0, available));
      if (issues.length > available || issues.some(issue => ['MODEL_INSPECTION_LIMIT', 'FILE_TOO_LARGE'].includes(issue.code))) {
        live2dTruncated = issues.length > available;
        onResponseTruncated?.();
      }
    }
    for (const asset of sentence.sentenceAssets) {
      checkpoint?.();
      const kind = assetKind(asset.type);
      await classifyAndRecordReference(
        asset.url,
        kind,
        startLine,
        endLine,
        rawContent,
        exists,
        existenceCache,
        staticReferences,
        unresolvedReferences,
        diagnostics,
      );
    }

    for (const subScene of sentence.subScene) {
      checkpoint?.();
      await classifyAndRecordReference(
        subScene,
        'scene',
        startLine,
        endLine,
        rawContent,
        exists,
        existenceCache,
        staticReferences,
        unresolvedReferences,
        diagnostics,
      );
    }

    const manualKind = REFERENCE_KIND_BY_COMMAND.get(sentence.commandRaw);
    if (manualKind && MANUAL_REFERENCE_COMMANDS.has(sentence.commandRaw)) {
      await classifyAndRecordReference(
        sentence.content,
        manualKind,
        startLine,
        endLine,
        rawContent,
        exists,
        existenceCache,
        staticReferences,
        unresolvedReferences,
        diagnostics,
      );
    } else if (
      manualKind &&
      sentence.content === '' &&
      rawContent.trim().toLowerCase() === 'none'
    ) {
      addUnresolved(
        unresolvedReferences,
        diagnostics,
        {
          value: 'none',
          kind: manualKind,
          startLine,
          endLine,
          reason: 'none',
        },
      );
    }

    if (
      sentence.commandRaw === 'character' &&
      sentence.content !== '' &&
      sentence.content.toLowerCase() !== 'none'
    ) {
      addUnresolved(
        unresolvedReferences,
        diagnostics,
        {
          value: displayValue(sentence.content),
          kind: 'figure',
          startLine,
          endLine,
          reason: 'complex-character-dependency',
        },
      );
    } else if (
      UNSUPPORTED_REFERENCE_COMMANDS.has(sentence.commandRaw) &&
      sentence.content !== '' &&
      sentence.content.toLowerCase() !== 'none'
    ) {
      addUnresolved(
        unresolvedReferences,
        diagnostics,
        {
          value: displayValue(sentence.content),
          kind: 'unknown',
          startLine,
          endLine,
          reason: 'unsupported-static-semantics',
        },
      );
    }
  }

  checkpoint?.();
  const limitations = [
    'Static analysis only; a successful parse does not prove the scene will run.',
    'Remote URLs are not fetched and are reported as unresolved.',
    'Dynamic references are not resolved and are not treated as missing local files.',
    'Explicit none values are not treated as missing files.',
    'Unsafe or ambiguous paths are not passed to the existence callback.',
    'Speaker names and unknown command names are not treated as invalid.',
    'Character templates and commands without static reference semantics are only partially analyzed.',
    'Existence checks use the supplied project-relative callback and do not inspect editor buffers.',
  ];

  const sentenceSummaries = sentences
    .slice(0, LIMITS.entries)
    .map((sentence) => ({
      startLine: sentence.startLine + 1,
      endLine: sentence.endLine + 1,
      command:
        COMMAND_NAME_BY_TYPE.get(sentence.command) ?? sentence.commandRaw,
    }));
  if (sentences.length > sentenceSummaries.length) {
    limitations.push(
      `Sentence summaries were truncated at the ${LIMITS.entries}-entry limit.`,
    );
  }
  if (live2dTruncated) limitations.push('Live2D diagnostics reached the per-scene limit.');

  const result: SceneAnalysis = {
    sentenceCount: sentences.length,
    sentences: sentenceSummaries,
    diagnostics,
    staticReferences,
    unresolvedReferences,
    live2dIssues,
    limitations,
  };
  return enforceResponseLimit(result, [
    'sentences',
    'diagnostics',
    'staticReferences',
    'unresolvedReferences',
    'live2dIssues',
  ], onResponseTruncated);
}

export function parseGameConfig(text: string): ConfigAnalysis {
  ensureTextWithinLimit(text, 'Game config text');

  const parseText = stripBom(text);
  const parsedItems = parser.parseConfig(parseText) as unknown as WebgalConfig;
  const lines = parseText.replaceAll('\r', '').split('\n');
  const items: ConfigItemSummary[] = [];
  const diagnostics: Diagnostic[] = [];
  const seenCommands = new Map<string, number>();
  let parsedIndex = 0;
  let truncatedValue = false;

  for (let index = 0; index < lines.length; index += 1) {
    const lineItems = parser.parseConfig(lines[index]) as unknown as WebgalConfig;
    if (lineItems.length === 0) {
      continue;
    }
    const parsed = parsedItems[parsedIndex] ?? lineItems[0];
    parsedIndex += 1;
    const line = index + 1;
    const duplicateOfLine = seenCommands.get(parsed.command);
    if (duplicateOfLine === undefined) {
      seenCommands.set(parsed.command, line);
    } else {
      diagnostics.push({
        startLine: line,
        endLine: line,
        message: `Duplicate configuration key "${parsed.command}" was first defined at line ${duplicateOfLine}.`,
        severity: 'warning',
        code: 'CONFIG_DUPLICATE_KEY',
      });
    }

    const safeArgs = parsed.args.map((value: string) => {
      const sanitized = sanitizeConfigString(value);
      truncatedValue ||= sanitized.truncated;
      return sanitized.value;
    });
    const safeOptions = parsed.options.map(
      (option: { key: string; value: string | number | boolean }) => {
      const sanitized = sanitizeConfigValue(option.value);
      truncatedValue ||= sanitized.truncated;
      return { key: option.key, value: sanitized.value };
      },
    );

    items.push({
      line,
      command: parsed.command,
      args: safeArgs,
      options: safeOptions,
      known: KNOWN_CONFIG_KEYS.has(parsed.command),
      ...(duplicateOfLine === undefined ? {} : { duplicateOfLine }),
    });
  }

  const limitations = [
    'The original configuration text is returned separately by the server and is not rewritten here.',
    'Unknown keys are marked but retained because WebGAL may use arbitrary global configuration keys.',
    'Duplicate keys are reported because consumers may disagree about which occurrence wins.',
  ];
  if (truncatedValue) {
    limitations.push(
      `Configuration values longer than ${MAX_CONFIG_VALUE_CHARS} characters were truncated in this analysis result.`,
    );
  }
  if (items.length > LIMITS.entries) {
    limitations.push(
      `Configuration items were truncated at the ${LIMITS.entries}-entry limit.`,
    );
  }

  const result: ConfigAnalysis = {
    itemCount: parsedItems.length,
    items: items.slice(0, LIMITS.entries),
    diagnostics,
    limitations,
  };
  return enforceResponseLimit(result, ['items', 'diagnostics']);
}

async function classifyAndRecordReference(
  value: string,
  kind: ReferenceKind,
  startLine: number,
  endLine: number,
  rawContent: string,
  exists: (projectRelativePath: string) => Promise<boolean>,
  existenceCache: Map<string, Promise<boolean>>,
  staticReferences: StaticReference[],
  unresolvedReferences: UnresolvedReference[],
  diagnostics: Diagnostic[],
): Promise<void> {
  const classification = classifyReference(value, rawContent);
  if (classification.type === 'empty') {
    return;
  }
  if (classification.type !== 'local') {
    addUnresolved(
      unresolvedReferences,
      diagnostics,
      {
        value: displayValue(classification.value),
        kind,
        startLine,
        endLine,
        reason: classification.reason,
      },
    );
    return;
  }

  let present: boolean;
  try {
    let pending = existenceCache.get(classification.path);
    if (!pending) {
      pending = Promise.resolve(exists(classification.path)).then(Boolean);
      existenceCache.set(classification.path, pending);
    }
    present = await pending;
  } catch {
    addUnresolved(
      unresolvedReferences,
      diagnostics,
      {
        value: displayValue(classification.path),
        kind,
        startLine,
        endLine,
        reason: 'check-failed',
      },
    );
    return;
  }

  addStaticReference(staticReferences, {
    path: classification.path,
    kind,
    startLine,
    endLine,
    exists: present,
  });
  if (!present) {
    addUnresolved(
      unresolvedReferences,
      diagnostics,
      {
        value: classification.path,
        kind,
        startLine,
        endLine,
        reason: 'missing',
      },
    );
  }
}

function classifyReference(
  value: string,
  rawContent: string,
):
  | { type: 'empty' }
  | { type: 'local'; path: string }
  | { type: 'non-local'; value: string; reason: UnresolvedReason } {
  const trimmed = value.trim();
  if (trimmed === '') {
    return rawContent.trim().toLowerCase() === 'none'
      ? { type: 'non-local', value: 'none', reason: 'none' }
      : { type: 'empty' };
  }
  if (trimmed.toLowerCase() === 'none') {
    return { type: 'non-local', value: 'none', reason: 'none' };
  }
  if (isRemoteUrl(trimmed)) {
    return { type: 'non-local', value: trimmed, reason: 'remote-url' };
  }
  if (hasDynamicToken(trimmed)) {
    return { type: 'non-local', value: trimmed, reason: 'dynamic' };
  }
  const normalized = normalizeGamePath(trimmed);
  if (!normalized) {
    return { type: 'non-local', value: trimmed, reason: 'invalid-path' };
  }
  return { type: 'local', path: normalized };
}

function addStaticReference(
  references: StaticReference[],
  reference: StaticReference,
): void {
  if (
    references.some(
      (existing) =>
        existing.path === reference.path &&
        existing.kind === reference.kind &&
        existing.startLine === reference.startLine &&
        existing.endLine === reference.endLine &&
        existing.exists === reference.exists,
    )
  ) {
    return;
  }
  references.push(reference);
}

function addUnresolved(
  unresolvedReferences: UnresolvedReference[],
  diagnostics: Diagnostic[],
  reference: UnresolvedReference,
): void {
  if (
    !unresolvedReferences.some(
      (existing) =>
        existing.value === reference.value &&
        existing.kind === reference.kind &&
        existing.startLine === reference.startLine &&
        existing.endLine === reference.endLine &&
        existing.reason === reference.reason,
    )
  ) {
    unresolvedReferences.push(reference);
  }

  const diagnostic = diagnosticForReference(reference);
  if (
    diagnostic &&
    !diagnostics.some(
      (existing) =>
        existing.code === diagnostic.code &&
        existing.startLine === diagnostic.startLine &&
        existing.endLine === diagnostic.endLine &&
        existing.message === diagnostic.message,
    )
  ) {
    diagnostics.push(diagnostic);
  }
}

function diagnosticForReference(
  reference: UnresolvedReference,
): Diagnostic | undefined {
  const base = {
    startLine: reference.startLine,
    endLine: reference.endLine,
  };
  switch (reference.reason) {
    case 'missing':
      return {
        ...base,
        message: `Referenced local file does not exist: ${reference.value}`,
        severity: 'error',
        code: 'REFERENCE_MISSING',
      };
    case 'dynamic':
      return {
        ...base,
        message: `Dynamic reference was not resolved: ${reference.value}`,
        severity: 'info',
        code: 'REFERENCE_DYNAMIC_NOT_CHECKED',
      };
    case 'remote-url':
      return {
        ...base,
        message: `Remote reference was not fetched: ${reference.value}`,
        severity: 'info',
        code: 'REFERENCE_REMOTE_NOT_CHECKED',
      };
    case 'none':
      return {
        ...base,
        message: 'Reference is explicitly set to none.',
        severity: 'info',
        code: 'REFERENCE_NONE',
      };
    case 'invalid-path':
      return {
        ...base,
        message: `Reference path was not checked because it is not a safe project-relative path: ${reference.value}`,
        severity: 'warning',
        code: 'REFERENCE_PATH_INVALID',
      };
    case 'check-failed':
      return {
        ...base,
        message: `Reference existence check failed: ${reference.value}`,
        severity: 'warning',
        code: 'REFERENCE_CHECK_FAILED',
      };
    case 'unsupported-static-semantics':
      return {
        ...base,
        message: `Command has no complete static reference semantics: ${reference.value}`,
        severity: 'warning',
        code: 'REFERENCE_UNSUPPORTED_STATIC',
      };
    case 'complex-character-dependency':
      return {
        ...base,
        message: `Character dependency was not fully resolved: ${reference.value}`,
        severity: 'warning',
        code: 'REFERENCE_CHARACTER_UNRESOLVED',
      };
  }
}

function rawSentenceContent(
  lines: string[],
  sentence: ParsedSentence,
): string {
  const raw = lines
    .slice(sentence.startLine, sentence.endLine + 1)
    .join('\n')
    .trimStart();
  const colon = raw.indexOf(':');
  if (colon < 0) {
    return '';
  }
  let content = raw.slice(colon + 1);
  content = content.split(/(?<!\\);/, 1)[0] ?? '';
  const option = content.search(/ -/);
  if (option >= 0) {
    content = content.slice(0, option);
  }
  return content.trim();
}

function assetKind(assetType: number): ReferenceKind {
  return ASSET_FOLDERS[assetType] ?? 'unknown';
}

function isRemoteUrl(value: string): boolean {
  return /https?:\/\//i.test(value) || value.startsWith('//');
}

function hasDynamicToken(value: string): boolean {
  return /(^|[^\\])\{[^{}]+\}/.test(value);
}

function normalizeScenePath(scenePath: string): string {
  const normalized = normalizeRelativePath(scenePath.replaceAll('\\', '/'));
  if (!normalized) {
    throw new AppError(
      'INVALID_PATH',
      'scenePath must be a safe path relative to game/scene.',
    );
  }
  return normalized;
}

function normalizeGamePath(value: string): string | undefined {
  const normalized = normalizeRelativePath(value);
  if (!normalized || !normalized.startsWith('game/')) {
    return undefined;
  }
  return normalized;
}

function normalizeRelativePath(value: string): string | undefined {
  if (
    value.length === 0 ||
    value.length > MAX_REFERENCE_PATH_CHARS ||
    value.includes('\0') ||
    value.startsWith('/') ||
    value.startsWith('\\') ||
    /^[A-Za-z]:/.test(value)
  ) {
    return undefined;
  }

  let decoded = value;
  for (let index = 0; index < 2; index += 1) {
    try {
      const next = decodeURIComponent(decoded);
      if (next === decoded) {
        break;
      }
      decoded = next;
    } catch {
      return undefined;
    }
  }

  const normalized = decoded.replaceAll('\\', '/');
  if (
    decoded.includes('\0') ||
    normalized.startsWith('/') ||
    normalized.includes('//') ||
    normalized.includes(':') ||
    normalized.endsWith('/')
  ) {
    return undefined;
  }
  const segments = normalized.split('/');
  if (
    segments.some(
      (segment) =>
        segment.length === 0 ||
        segment === '.' ||
        segment === '..' ||
        /[. ]$/.test(segment) ||
        /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i.test(segment),
    )
  ) {
    return undefined;
  }
  return normalized;
}

function ensureTextWithinLimit(text: string, label: string): void {
  if (
    typeof text !== 'string' ||
    Buffer.byteLength(text, 'utf8') > LIMITS.textBytes
  ) {
    throw new AppError(
      'LIMIT_EXCEEDED',
      `${label} exceeds the ${LIMITS.textBytes}-byte analysis limit.`,
    );
  }
}

function displayValue(value: string): string {
  return value.length <= MAX_REFERENCE_DISPLAY_CHARS
    ? value
    : `${value.slice(0, MAX_REFERENCE_DISPLAY_CHARS - 3)}...`;
}

function stripBom(text: string): string {
  return text.startsWith('\uFEFF') ? text.slice(1) : text;
}

function sanitizeConfigString(value: string): {
  value: string;
  truncated: boolean;
} {
  if (value.length <= MAX_CONFIG_VALUE_CHARS) {
    return { value, truncated: false };
  }
  return {
    value: `${value.slice(0, MAX_CONFIG_VALUE_CHARS - 3)}...`,
    truncated: true,
  };
}

function sanitizeConfigValue(
  value: string | number | boolean,
): { value: string | number | boolean; truncated: boolean } {
  return typeof value === 'string'
    ? sanitizeConfigString(value)
    : { value, truncated: false };
}

function enforceResponseLimit<T extends object>(
  result: T,
  arrayKeys: string[],
  onTruncate?: () => void,
): T {
  if (Buffer.byteLength(JSON.stringify(result), 'utf8') <= LIMITS.responseBytes) {
    return result;
  }

  onTruncate?.();
  const record = result as Record<string, unknown>;
  const limitations = record.limitations;
  if (
    Array.isArray(limitations) &&
    !limitations.includes(
      `Response arrays were truncated to stay within the ${LIMITS.responseBytes}-byte response limit.`,
    )
  ) {
    limitations.push(
      `Response arrays were truncated to stay within the ${LIMITS.responseBytes}-byte response limit.`,
    );
  }

  for (let attempt = 0; attempt < 32; attempt += 1) {
    if (
      Buffer.byteLength(JSON.stringify(result), 'utf8') <= LIMITS.responseBytes
    ) {
      break;
    }
    let changed = false;
    for (const key of arrayKeys) {
      const value = record[key];
      if (Array.isArray(value) && value.length > 0) {
        value.splice(Math.max(1, Math.ceil(value.length * 0.75)));
        changed = true;
      }
    }
    if (!changed) {
      break;
    }
  }
  return result;
}
