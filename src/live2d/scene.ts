import type { AppConfig, ProjectConfig } from '../types.js';
import {
  inspectLive2dModelSelectors,
  modelEntryPath,
  type Live2dModelSelectorInspection,
} from './model.js';

type Selector = string | number | boolean | undefined;
export interface Live2dSceneIssue {
  code: string;
  category: 'missing' | 'invalid' | 'unverified';
  line: number;
  endLine: number;
  modelPath: string | null;
  dependencyPath?: string;
  selector?: 'motion' | 'expression';
  name?: string;
}

export type Live2dSceneCheck = (cue: {
  rawPath: string;
  dynamicPath: boolean;
  line: number;
  endLine: number;
  motion: Selector;
  expression: Selector;
}) => Promise<Live2dSceneIssue[]>;

export function createLive2dSceneCheck(project: ProjectConfig, checkpoint?: () => void): Live2dSceneCheck {
  const config: AppConfig = { version: 1, projects: [project], sources: [] };
  const cache = new Map<string, Promise<Live2dModelSelectorInspection>>();
  const modelLimit = 32;
  return async cue => {
    const base = { line: cue.line, endLine: cue.endLine };
    if (cue.dynamicPath || /^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(cue.rawPath)) {
      return [{ ...base, modelPath: null, category: 'unverified', code: 'MODEL_REFERENCE_UNVERIFIED' }];
    }
    let modelPath: string;
    try { modelPath = modelEntryPath(cue.rawPath); }
    catch { return [{ ...base, modelPath: null, category: 'invalid', code: 'MODEL_PATH_INVALID' }]; }
    const reference = { ...base, modelPath };
    let pending = cache.get(modelPath);
    if (!pending) {
      if (cache.size >= modelLimit) return [{ ...reference, category: 'unverified', code: 'MODEL_INSPECTION_LIMIT' }];
      const packageRoot = modelPath.includes('/') ? modelPath.slice(0, modelPath.indexOf('/')) : '';
      pending = inspectLive2dModelSelectors(config, {
        kind: 'project',
        projectId: project.id,
        modelPath,
        rootPath: packageRoot,
      }, checkpoint);
      cache.set(modelPath, pending);
    }
    const inspection = await pending;
    const model = inspection.report;
    const issues: Live2dSceneIssue[] = model.issues.map(issue => ({
      ...reference,
      code: issue.code,
      category: issue.code === 'MODEL_MISSING' || issue.code === 'DEPENDENCY_MISSING' ? 'missing' : issue.status,
      ...(issue.path ? { dependencyPath: issue.path } : {}),
    }));
    const selectorsUnverified = model.format === 'unknown'
      || model.revision === null
      || model.issues.some(issue => [
        'MODEL_JSON_INVALID',
        'MODEL_STRUCTURE_INVALID',
        'MODEL_VERSION_UNVERIFIED',
        'MODEL_FORMAT_UNVERIFIED',
      ].includes(issue.code));
    for (const selector of ['motion', 'expression'] as const) {
      const value = cue[selector];
      if (value === undefined || value === '') continue;
      if (typeof value !== 'string' || /[{}]/.test(value) || selectorsUnverified) {
        issues.push({ ...reference, selector, category: 'unverified', code: 'LIVE2D_SELECTOR_UNVERIFIED' });
        continue;
      }
      const names = selector === 'motion'
        ? inspection.motionGroups
        : inspection.registeredExpressions;
      if (!names.has(value)) {
        const unregistered = selector === 'expression'
          && inspection.unregisteredExpressions.has(value);
        issues.push({
          ...reference, selector, category: 'invalid',
          code: unregistered
            ? 'UNREGISTERED_EXPRESSION'
            : selector === 'motion'
              ? 'UNKNOWN_MOTION_GROUP'
              : 'UNKNOWN_EXPRESSION',
          ...(/^[\p{L}\p{N}_. -]{1,100}$/u.test(value) ? { name: value } : {}),
        });
      }
    }
    return issues;
  };
}
