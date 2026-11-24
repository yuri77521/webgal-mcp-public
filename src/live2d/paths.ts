import { AppError } from '../errors.js';
import type { AppConfig } from '../types.js';

export function getSourceRoot(config: AppConfig, id: string): string {
  const source = config.sources.find(candidate => candidate.id === id);
  if (!source) throw new AppError('SOURCE_NOT_AUTHORIZED', 'Source is not authorized.');
  return source.root;
}
