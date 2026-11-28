export interface ProjectConfig { id: string; name?: string; root: string; terreUrl?: string; terreGameDir?: string }
export interface SourceConfig { id: string; root: string }
export interface FirstBuildConfig { root: string; templateRoot: string; terreGamesRoots: string[] }
export interface AppConfig { version: 1; projects: ProjectConfig[]; sources: SourceConfig[]; firstBuild?: FirstBuildConfig }
export const LIMITS = Object.freeze({ textBytes: 1024 * 1024, responseBytes: 2 * 1024 * 1024, entries: 10000, pageSize: 100, timeoutMs: 3000 });
export interface TextDocument { text: string; revision: string; encoding: 'utf-8' | 'utf-8-bom'; newline: 'lf' | 'crlf' | 'mixed' | 'none'; bytes: number; source: 'disk' }
export interface FileEntry { path: string; size: number; lastModified: number }
