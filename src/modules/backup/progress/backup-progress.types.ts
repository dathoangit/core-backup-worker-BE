export type BackupProgressMessageType = 'progress' | 'log' | 'status';

export interface BackupProgressMessage {
  type: BackupProgressMessageType;
  runId: string;
  at: string;
  percent?: number;
  rowsProcessed?: number;
  bytesProcessed?: number;
  rowsPerSec?: number;
  bytesPerSec?: number;
  etaSeconds?: number | null;
  tablesDone?: number;
  tablesTotal?: number;
  dbIndex?: number;
  dbCount?: number;
  startedAt?: string;
  currentDatabase?: string;
  currentTable?: string;
  line?: string;
  level?: 'info' | 'warn' | 'error';
  status?: string;
}

export interface BackupTableProgress {
  database: string;
  table: string;
  tablesDone: number;
  tablesTotal: number;
  rowsDelta?: number;
  bytesDelta?: number;
  /** True while a table COPY/stream is in flight (before it finishes). */
  inFlight?: boolean;
}

export interface BackupProgressSink {
  onTableProgress: (progress: BackupTableProgress) => void;
  onLog: (line: string, level?: 'info' | 'warn' | 'error') => void;
}
