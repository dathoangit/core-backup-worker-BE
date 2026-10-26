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
  bytesProcessed: number;
  lastEmitAt: number;
  startedAtMs: number;
  startedAtIso: string;
  currentDatabase?: string;
  currentTable?: string;
  tablesDone: number;
  tablesTotal: number;
  tableInFlight: boolean;
  percent: number;
  rowsPerSec: number;
  bytesPerSec: number;
  etaSeconds: number | null;
  sampleAtMs: number;
  sampleRows: number;
  sampleBytes: number;
}

@Injectable()
export class BackupProgressPublisher {
  private readonly logger = new Logger(BackupProgressPublisher.name);

  private readonly states = new Map<string, RunProgressState>();

  constructor(private readonly backupRedis: BackupRedisService) {}

  begin(runId: string, dbCount = 1): void {
    const now = Date.now();
    this.states.set(runId, {
      dbIndex: 0,
      dbCount: Math.max(dbCount, 1),
      rowsProcessed: 0,
      bytesProcessed: 0,
      lastEmitAt: 0,
      startedAtMs: now,
      startedAtIso: new Date(now).toISOString(),
      tablesDone: 0,
      tablesTotal: 0,
      tableInFlight: false,
      percent: 0,
      rowsPerSec: 0,
      bytesPerSec: 0,
      etaSeconds: null,
      sampleAtMs: now,
      sampleRows: 0,
      sampleBytes: 0,
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
    state.tablesDone = 0;
    state.tablesTotal = 0;
    state.tableInFlight = false;
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
      bytesProcessed: state?.bytesProcessed,
      rowsPerSec: state?.rowsPerSec,
      bytesPerSec: state?.bytesPerSec,
      etaSeconds:
        status === 'ok' || status === 'partial' ? 0 : state?.etaSeconds,
      tablesDone: state?.tablesDone,
      tablesTotal: state?.tablesTotal,
      dbIndex: state?.dbIndex,
      dbCount: state?.dbCount,
      startedAt: state?.startedAtIso,
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

    const tableChanged = state.currentTable !== progress.table;
    state.currentDatabase = progress.database;
    state.currentTable = progress.table;
    state.tablesDone = progress.tablesDone;
    state.tablesTotal = progress.tablesTotal;
    state.tableInFlight = Boolean(progress.inFlight);

    if (progress.rowsDelta && progress.rowsDelta > 0) {
      state.rowsProcessed += progress.rowsDelta;
    }

    if (progress.bytesDelta && progress.bytesDelta > 0) {
      state.bytesProcessed += progress.bytesDelta;
    }

    state.percent = this.computePercent(state);

    const now = Date.now();
    // Always flush when the active table changes; otherwise throttle to 1 Hz.
    const due = tableChanged || now - state.lastEmitAt >= 1000;

    if (!due) {
      return;
    }

    this.refreshRates(state, now);
    state.lastEmitAt = now;
    await this.safePublish({
      type: 'progress',
      runId,
      at: new Date().toISOString(),
      percent: state.percent,
      rowsProcessed: state.rowsProcessed,
      bytesProcessed: state.bytesProcessed,
      rowsPerSec: state.rowsPerSec,
      bytesPerSec: state.bytesPerSec,
      etaSeconds: state.etaSeconds,
      tablesDone: state.tablesDone,
      tablesTotal: state.tablesTotal,
      dbIndex: state.dbIndex,
      dbCount: state.dbCount,
      startedAt: state.startedAtIso,
      currentDatabase: state.currentDatabase,
      currentTable: state.currentTable,
    });
  }

  /**
   * Overall run percent across databases. While a large table is streaming,
   * treat it as partially done so the bar can move before the table finishes.
   * Floor at 1% once any work has started so the wallboard does not stick at 0%.
   * (ETA uses {@link overallFraction}, not this floored value.)
   */
  private computePercent(state: RunProgressState): number {
    const raw = this.overallFraction(state) * 100;
    let percent = Math.min(99, Math.round(raw));

    if (
      percent < 1 &&
      (state.bytesProcessed > 0 ||
        state.tablesDone > 0 ||
        state.tableInFlight ||
        Boolean(state.currentTable))
    ) {
      percent = 1;
    }

    return percent;
  }

  private refreshRates(state: RunProgressState, nowMs: number): void {
    const dtSec = Math.max((nowMs - state.sampleAtMs) / 1000, 0.001);
    const rowDelta = state.rowsProcessed - state.sampleRows;
    const byteDelta = state.bytesProcessed - state.sampleBytes;

    state.rowsPerSec = Math.max(0, Math.round(rowDelta / dtSec));
    state.bytesPerSec = Math.max(0, Math.round(byteDelta / dtSec));

    const elapsedSec = Math.max((nowMs - state.startedAtMs) / 1000, 0.001);
    state.etaSeconds = this.computeEtaSeconds(state, elapsedSec);

    state.sampleAtMs = nowMs;
    state.sampleRows = state.rowsProcessed;
    state.sampleBytes = state.bytesProcessed;
  }

  /**
   * ETA must NOT use the wallboard percent (floored at 1%): that yields
   * ~99× elapsed while HIS is still on early tables of a multi-DB full run.
   * Use the unrounded overall fraction; return null until it is meaningful.
   */
  private computeEtaSeconds(
    state: RunProgressState,
    elapsedSec: number,
  ): number | null {
    if (state.percent >= 100) {
      return 0;
    }

    const overallFrac = this.overallFraction(state);

    // Below ~2% overall the extrapolation is noise (especially one huge table).
    if (overallFrac < 0.02) {
      return null;
    }

    return Math.max(
      0,
      Math.round((elapsedSec * (1 - overallFrac)) / overallFrac),
    );
  }

  private overallFraction(state: RunProgressState): number {
    const inFlightFrac = state.tableInFlight ? 0.35 : 0;
    const tableFrac =
      state.tablesTotal > 0
        ? Math.min(1, (state.tablesDone + inFlightFrac) / state.tablesTotal)
        : 0;

    return (state.dbIndex + tableFrac) / state.dbCount;
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
