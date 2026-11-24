export type Live2dFormat = 'cubism2' | 'cubism3' | 'unknown';
export type Live2dStatus = 'valid' | 'invalid' | 'unverified';
export type Live2dDependencyKind =
  | 'moc'
  | 'texture'
  | 'motion'
  | 'expression'
  | 'sound'
  | 'physics'
  | 'pose'
  | 'motionSync'
  | 'displayInfo'
  | 'userData';
export type Live2dDependencyStatus = 'present' | 'missing' | 'unverified' | 'invalid';
export type Live2dEntryKind = 'motion' | 'expression' | 'dependency';
export type Live2dEntryStatus =
  | 'registered'
  | 'unregistered'
  | Live2dDependencyStatus;

export type Live2dLocation =
  | {
    kind: 'project';
    projectId: string;
    modelPath: string;
    rootPath?: string;
  }
  | {
    kind: 'source';
    sourceId: string;
    modelPath: string;
    rootPath?: string;
  };

export interface Live2dDependency {
  kind: Live2dDependencyKind;
  path: string;
  status: Live2dDependencyStatus;
}

export interface Live2dMotion {
  name: string;
  files: string[];
}

export interface Live2dExpression {
  name: string;
  file: string;
}

export interface Live2dUnregisteredExpression {
  name: string;
  file: string;
}

export interface Live2dIssue {
  code: string;
  status: Exclude<Live2dStatus, 'valid'>;
  field: string;
  path?: string;
}

export interface Live2dCounts {
  dependencies: number;
  presentDependencies: number;
  missingDependencies: number;
  invalidDependencies: number;
  unverifiedDependencies: number;
  motionGroups: number;
  motionFiles: number;
  registeredExpressions: number;
  unregisteredExpressions: number;
}

export interface Live2dModelReport {
  status: Live2dStatus;
  format: Live2dFormat;
  modelPath: string;
  rootPath: string;
  version: number | null;
  revision: string | null;
  dependencies: Live2dDependency[];
  motions: Live2dMotion[];
  expressions: Live2dExpression[];
  unregisteredExpressions: Live2dUnregisteredExpression[];
  counts: Live2dCounts;
  issues: Live2dIssue[];
}

export interface Live2dCatalogItem {
  kind: Live2dEntryKind;
  id: string;
  name: string;
  path: string;
  status: Live2dEntryStatus;
  fingerprint: string | null;
  rootRelativePath?: string;
  motionGroup?: string;
  motionIndex?: number;
  sound?: string;
}

export interface Live2dCatalogSnapshot {
  report: Live2dModelReport;
  items: Live2dCatalogItem[];
}

export interface Live2dEntryQuery {
  kind?: Live2dEntryKind;
  prefix?: string;
  includeUnregistered?: boolean;
  offset?: number;
  limit?: number;
  expectedRevision?: string;
}

export interface Live2dEntryPage {
  modelPath: string;
  rootPath: string;
  format: Live2dFormat;
  revision: string | null;
  query: {
    kind: Live2dEntryKind | null;
    prefix: string | null;
    includeUnregistered: boolean;
  };
  total: number;
  offset: number;
  limit: number;
  nextOffset: number | null;
  counts: Live2dCounts;
  items: Live2dCatalogItem[];
}

export interface Live2dDiscoverInput {
  location:
    | { kind: 'project'; projectId: string }
    | { kind: 'source'; sourceId: string };
  directory?: string;
  offset?: number;
  limit?: number;
}

export interface Live2dDiscoverItem {
  modelPath: string;
  rootPath: string;
  format: Live2dFormat;
  displayName: string;
  status: Live2dStatus;
  counts: Live2dCounts;
  missingFiles: string[];
}

export interface Live2dDiscoverPage {
  items: Live2dDiscoverItem[];
  total: number;
  offset: number;
  limit: number;
  nextOffset: number | null;
}
