export type BackupProgressMessageType = 'progress' | 'log' | 'status';

export interface BackupProgressMessage {
  type: BackupProgressMessageType;
  runId: string;
  at: string;
  percent?: number;
  rowsProcessed?: number;
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
}

export interface BackupProgressSink {
  onTableProgress: (progress: BackupTableProgress) => void;
  onLog: (line: string, level?: 'info' | 'warn' | 'error') => void;
}
