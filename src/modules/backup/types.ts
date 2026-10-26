export type SourceGroup = 'HIS' | 'EMR' | 'BADL' | 'LIS' | 'PACS';

export type BackupProfile = 'adempiere' | 'envers' | 'snapshot';

export type BackupMode = 'incremental' | 'full' | 'logical';

export type SourceReachability = 'ready' | 'unreachable' | 'unconfigured';

export type BackupTrigger = 'cron' | 'manual';

export type BackupRunStatus =
  | 'queued'
  | 'running'
  | 'ok'
  | 'partial'
  | 'error'
  | 'cancelled';

export interface SourceConfig {
  group: SourceGroup;
  host: string;
  port: number;
  user: string;
  password: string;
  databases: string[];
  reachability: SourceReachability;
  reason?: string;
}

export interface BackupConfig {
  /** Meta volume root (lock file). */
  backupDir: string;
  volumeDirs: {
    HIS: string;
    EMR: string;
    LIS: string;
  };
  sources: SourceConfig[];
  chunkSize: bigint;
  statementTimeoutMs: number;
  mode: BackupMode;
  /**
   * When > 0, each COPY SELECT is capped (local/dev sample mode).
   * Production must keep this at 0.
   */
  devRowLimit: number;
  compression: 'zstd' | 'gzip';
  zstdLevel: number;
  zstdThreads: number;
  verifyArchive: boolean;
  minFreeBytes: number;
  logicalJobs: number;
  logicalExcludeTableData: string[];
}

export interface PendingState {
  captured: string;
  runId: string;
  completedChunkKeys: string[];
}

export interface DatabaseState {
  watermark: string | null;
  pending: PendingState | null;
  initialFullDone: boolean;
  profile: BackupProfile;
  updatedAt: string;
}

export interface ChunkResult {
  key: string;
  file: string;
  rowCount: number;
  bytes: number;
  sha256?: string;
  md5?: string;
  fromExclusive: string;
  toInclusive: string;
}

export interface SkippedTable {
  schema: string;
  table: string;
  reason: string;
}

export interface DatabaseRunResult {
  database: string;
  group: SourceGroup;
  profile: BackupProfile;
  status: 'ok' | 'error' | 'skipped';
  watermarkBefore: string | null;
  captured: string | null;
  watermarkAfter: string | null;
  chunks: ChunkResult[];
  skippedTables: SkippedTable[];
  /** Readable tables with zero rows. No file is written. */
  emptyTables?: TableRef[];
  error?: string;
}

export interface RunManifest {
  runId: string;
  startedAt: string;
  finishedAt?: string;
  backupDir: string;
  mode: BackupMode;
  databases: DatabaseRunResult[];
}

export interface TableRef {
  schema: string;
  table: string;
}

export interface IdRange {
  fromExclusive: bigint;
  toInclusive: bigint;
}

export interface BackupRunOptions {
  trigger: BackupTrigger;
  mode?: BackupMode;
  sourceGroups?: SourceGroup[];
  /** When set, only these database names are backed up (within selected groups). */
  databases?: string[];
}
