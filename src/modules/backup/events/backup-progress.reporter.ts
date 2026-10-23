import { type BackupEventsService } from './backup-events.service';
import { type BackupChunkProgress } from './backup-events.types';

export class BackupProgressReporter {
  private databasesTotal = 0;

  private databasesDone = 0;

  private currentDatabase: string | null = null;

  private tablesTotal = 0;

  private tablesDone = 0;

  private rowsTotal = 0;

  private bytesTotal = 0;

  constructor(
    private readonly events: BackupEventsService,
    private readonly runId: string,
  ) {}

  setDatabasesTotal(total: number): void {
    this.databasesTotal = Math.max(0, total);
    this.publishProgress();
  }

  beginDatabase(database: string, tablesTotal = 0): void {
    this.currentDatabase = database;
    this.tablesTotal = Math.max(0, tablesTotal);
    this.tablesDone = 0;
    this.events.emitLog({
      runId: this.runId,
      level: 'info',
      message: `Starting database ${database}`,
    });
    this.publishProgress();
  }

  setTablesTotal(total: number): void {
    this.tablesTotal = Math.max(0, total);
    this.publishProgress();
  }

  chunkDone(chunk: BackupChunkProgress): void {
    this.tablesDone += 1;

    if (chunk.rowCount > 0) {
      this.rowsTotal += chunk.rowCount;
    }

    if (chunk.bytes > 0) {
      this.bytesTotal += chunk.bytes;
    }

    this.events.emitLog({
      runId: this.runId,
      level: 'info',
      message: `${this.currentDatabase ?? '?'}/${chunk.table}: rows=${
        chunk.rowCount
      } bytes=${chunk.bytes}`,
    });
    this.publishProgress();
  }

  endDatabase(
    database: string,
    status: 'ok' | 'error' | 'skipped',
    error?: string | null,
  ): void {
    this.databasesDone += 1;
    this.currentDatabase = database;

    if (status === 'error') {
      this.events.emitLog({
        runId: this.runId,
        level: 'error',
        message: `Database ${database} failed: ${error ?? 'unknown'}`,
      });
    } else {
      this.events.emitLog({
        runId: this.runId,
        level: 'info',
        message: `Database ${database} ${status}`,
      });
    }

    this.publishProgress();
  }

  private publishProgress(): void {
    const dbWeight =
      this.databasesTotal > 0 ? this.databasesDone / this.databasesTotal : 0;
    const tableWeight =
      this.databasesTotal > 0 && this.tablesTotal > 0
        ? this.tablesDone / this.tablesTotal / this.databasesTotal
        : 0;
    const percent = Math.min(
      99.9,
      Math.round((dbWeight + tableWeight) * 1000) / 10,
    );

    this.events.emitProgress({
      runId: this.runId,
      database: this.currentDatabase,
      tablesDone: this.tablesDone,
      tablesTotal: this.tablesTotal,
      databasesDone: this.databasesDone,
      databasesTotal: this.databasesTotal,
      rowsTotal: this.rowsTotal,
      bytesTotal: this.bytesTotal,
      percent:
        this.databasesDone >= this.databasesTotal && this.databasesTotal > 0
          ? 100
          : percent,
    });
  }
}
