export const WRITE_LIMITS = Object.freeze({ maxFiles: 32, maxFileBytes: 1024 * 1024, maxBatchBytes: 4 * 1024 * 1024, maxRecordBytes: 8 * 1024 * 1024, sessionTtlMs: 300000, maxSessionTtlMs: 900000 });
export const LARGE_ASSET_LIMITS = Object.freeze({ maxFileBytes: 16 * 1024 * 1024, maxBatchBytes: 32 * 1024 * 1024, chunkBytes: 64 * 1024 });
export interface Attestation { source: 'user-message'; statement: string }
export interface WriteSession { id: string; ownerId: string; projectId: string; paths: string[]; createdAt: number; expiresAt: number; state: 'active' | 'paused' | 'closed'; attestation: Readonly<Attestation>; userAttested: true; automaticDirtyCheck: false }
export interface ChangeInput { path: string; expectedRevision: string | null; bytes: Uint8Array }
export interface SourceRevision { sourceId: string; path: string; revision: string; rootKey: string }
export interface StreamedAssetSource extends SourceRevision { bytes: number }
export type CoordinatorChange = ChangeInput | { path: string; expectedRevision: null; source: StreamedAssetSource };
export type PlannedChange = { path: string; newRevision: string } & (
  { expectedRevision: string | null; data: string; source?: never }
  | { expectedRevision: null; source: StreamedAssetSource; data?: never }
);
export type WriteRecordVersion = 1 | 2 | 3 | 4;
export interface ModelDirectoryExpectation {
  path: string;
  state: 'create' | 'existing';
  identity?: string;
}
export interface ModelSourceMapping {
  targetRelativePath: string;
  sourceRelativePath: string;
}
export interface ModelDependencyRevision {
  path: string;
  revision: string;
}
export interface ModelBundle {
  directory: string;
  modelPath: string;
  mode?: 'create' | 'update';
  directories?: ModelDirectoryExpectation[];
  sourceId?: string;
  sourceRootPath?: string;
  bundleRevision?: string;
  batchIndex?: number;
  batchCount?: number;
  skippedBatchIndices?: number[];
  previousPlanId?: string;
  entryIncluded?: boolean;
  sourceMappings?: ModelSourceMapping[];
  dependencies?: ModelDependencyRevision[];
  targetEntryRevision?: string;
  targetReferences?: ModelDependencyRevision[];
}
export interface ModelBundleDirectory { path: string; phase: 'pending' | 'intent' | 'created'; identity?: string }
export interface WritePlan { version: WriteRecordVersion; id: string; projectId: string; projectKey: string; ownerId: string; sessionId: string; createdAt: number; expiresAt: number; operations: PlannedChange[]; digest: string; restoresBatchId?: string; sources?: SourceRevision[]; modelBundle?: ModelBundle }
export interface OperationRecord { path: string; expectedRevision: string | null; newRevision: string; backup?: string; sourceBytes?: number; phase: 'pending' | 'intent' | 'applied'; }
export interface BatchRecord { version: WriteRecordVersion; id: string; projectId: string; projectKey: string; ownerId: string; planId: string; planDigest: string; keyHash: string; status: 'preparing' | 'applying' | 'complete' | 'failed' | 'partial' | 'uncertain'; operations: OperationRecord[]; errorCode?: string; createdAt: number; restoresBatchId?: string; directories?: ModelBundleDirectory[] }
export interface ApplyResult { batchId: string; status: BatchRecord['status']; operations: OperationRecord[]; errorCode?: string; replayed: boolean; warnings?: string[] }
export type FaultPoint = 'after-lock' | 'after-preflight' | 'before-backup' | 'after-backups' | 'before-model-directory' | 'before-model-directory-publish' | 'after-model-directory' | 'before-write' | 'after-stream-chunk' | 'after-write' | 'after-record' | 'before-complete';
export type FaultHook = (point: FaultPoint, index?: number) => void | Promise<void>;
