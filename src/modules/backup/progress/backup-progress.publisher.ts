import { Injectable, Logger } from '@nestjs/common';

import { BackupRedisService } from '../queue/backup-redis.service';
import {
  type BackupProgressMessage,
  type BackupProgressSink,
  type BackupTableProgress,
} from './backup-progress.types';

interface RunProgressState {
  dbIndex: number;
  dbCount: number;
  rowsProcessed: number;
  lastEmitAt: number;
  currentDatabase?: string;
  currentTable?: string;
  percent: number;
}

@Injectable()
export class BackupProgressPublisher {
  private readonly logger = new Logger(BackupProgressPublisher.name);

  private readonly states = new Map<string, RunProgressState>();

  constructor(private readonly backupRedis: BackupRedisService) {}

  begin(runId: string, dbCount = 1): void {
    this.states.set(runId, {
      dbIndex: 0,
      dbCount: Math.max(dbCount, 1),
      rowsProcessed: 0,
      lastEmitAt: 0,
      percent: 0,
    });
  }

  setDbCount(runId: string, dbCount: number): void {
    const state = this.states.get(runId);

    if (state) {
      state.dbCount = Math.max(dbCount, 1);
    }
  }

  setDbIndex(runId: string, dbIndex: number, database: string): void {
    const state = this.states.get(runId);

    if (!state) {
      return;
    }

    state.dbIndex = dbIndex;
    state.currentDatabase = database;
    state.currentTable = undefined;
  }

  end(runId: string): void {
    this.states.delete(runId);
  }

  sinkFor(runId: string): BackupProgressSink {
    return {
      onTableProgress: (progress) => {
        void this.handleTableProgress(runId, progress);
      },
      onLog: (line, level) => {
        void this.publishLog(runId, line, level);
      },
    };
  }

  async publishStatus(runId: string, status: string): Promise<void> {
    const state = this.states.get(runId);
    const message: BackupProgressMessage = {
      type: 'status',
      runId,
      at: new Date().toISOString(),
      status,
      percent: status === 'ok' || status === 'partial' ? 100 : state?.percent,
      rowsProcessed: state?.rowsProcessed,
      currentDatabase: state?.currentDatabase,
      currentTable: state?.currentTable,
    };
    await this.safePublish(message);
  }

  async publishLog(
    runId: string,
    line: string,
    level: 'info' | 'warn' | 'error' = 'info',
  ): Promise<void> {
    await this.safePublish({
      type: 'log',
      runId,
      at: new Date().toISOString(),
      line,
      level,
    });
  }

  private async handleTableProgress(
    runId: string,
    progress: BackupTableProgress,
  ): Promise<void> {
    const state = this.states.get(runId);

    if (!state) {
      return;
    }

    state.currentDatabase = progress.database;
    state.currentTable = progress.table;

    if (progress.rowsDelta && progress.rowsDelta > 0) {
      state.rowsProcessed += progress.rowsDelta;
    }

    const tableFrac =
      progress.tablesTotal > 0 ? progress.tablesDone / progress.tablesTotal : 0;
    state.percent = Math.min(
      99,
      Math.round(((state.dbIndex + tableFrac) / state.dbCount) * 100),
    );

    const now = Date.now();

    if (now - state.lastEmitAt < 1000) {
      return;
    }

    state.lastEmitAt = now;
    await this.safePublish({
      type: 'progress',
      runId,
      at: new Date().toISOString(),
      percent: state.percent,
      rowsProcessed: state.rowsProcessed,
      currentDatabase: state.currentDatabase,
      currentTable: state.currentTable,
    });
  }

  private async safePublish(message: BackupProgressMessage): Promise<void> {
    try {
      await this.backupRedis.publishProgress(message);
    } catch (error) {
      this.logger.debug(
        `Progress publish failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
}
