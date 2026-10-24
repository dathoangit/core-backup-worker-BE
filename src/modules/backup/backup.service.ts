import {
  ConflictException,
  forwardRef,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { type Repository } from 'typeorm';

import { BackupConfigService } from './backup-config.service';
import {
  type BackupLagState,
  resolveBackupLagState,
} from './backup-schedule-lag.util';
import {
  collectBackupDiskUsage,
  type IBackupDiskUsage,
} from './disk-stats.util';
import {
  computeDiskGrowthForecast,
  estimateGrowthFromBackupBytes,
  recordDiskUsageSample,
} from './disk-usage-history.util';
import { BackupRunnerService } from './engine/backup-runner.service';
import { createRunId } from './engine/manifest';
import { loadState } from './engine/state';
import { BackupDatabaseRunEntity } from './entities/backup-database-run.entity';
import { BackupRunEntity } from './entities/backup-run.entity';
import { BackupCancelledError } from './errors/backup-cancelled.error';
import { BackupEventsService } from './events/backup-events.service';
import { DEFAULT_INCREMENTAL_CRON } from './incremental-schedule';
import { type BackupRunProgressContext } from './progress/backup-run-progress.context';
import {
  aggregateHistoryByDay,
  estimatedRowsTotal,
  estimateGzipCompression,
  lagMinutesFromLastStartedAt,
  PUBLIC_OVERVIEW_RECENT_JOBS,
  PUBLIC_OVERVIEW_RUN_SAMPLE,
  summarizeJobs,
  truncateError,
} from './public-overview.util';
import {
  BackupQueueService,
  type EnqueueBackupResult,
} from './queue/backup-queue.service';
import { BackupRedisService } from './queue/backup-redis.service';
import { buildNextScheduleTimes } from './schedule-next.util';
import { SourceRegistry } from './source-registry';
import {
  type BackupMode,
  type BackupRunOptions,
  type BackupRunStatus,
  type BackupTrigger,
  type DatabaseRunResult,
  type RunManifest,
  type SourceGroup,
  type SourceReachability,
} from './types';
import {
  ARCHIVE_TARGET,
  type ArchiveTarget,
} from './zones/archive-target.interface';
import { PrimaryZoneService } from './zones/primary-zone.service';
import { RestorePlanService } from './zones/restore-plan.service';
import { RetentionService } from './zones/retention.service';

export type TriggerRunResult = EnqueueBackupResult;

export interface PublicOverviewDatabase {
  group: SourceGroup;
  database: string;
  host: string;
  live: boolean;
  reachability: SourceReachability;
  reason: string | null;
  lastDbStatus: 'ok' | 'error' | 'skipped' | null;
  lastRunStatus: BackupRunStatus | null;
  lastStartedAt: string | null;
  watermark: string | null;
  /** Minutes since lastStartedAt (backup freshness lag, not source tip lag). */
  lagMinutes: number | null;
  /** Schedule-aware freshness vs incremental cron (not replication lag). */
  lagState: BackupLagState;
}

export interface PublicOverviewActiveJob {
  runId: string;
  mode: BackupMode;
  status: BackupRunStatus;
  startedAt: string | null;
  percent: number;
  rowsProcessed: number;
  estimatedRowsTotal: number | null;
  bytesProcessed: number;
  rowsPerSec: number;
  bytesPerSec: number;
  etaSeconds: number | null;
  currentDatabase: string | null;
  currentTable: string | null;
  finishedAt: string | null;
}

export interface PublicOverviewScheduleTarget {
  group: SourceGroup;
  database: string;
}

export interface PublicOverviewSchedule {
  enabled: boolean | null;
  nextIncrementalAt: string | null;
  nextFullAt: string | null;
  nextFullLabel: string | null;
  nextIncrementalDatabases: PublicOverviewScheduleTarget[];
  nextFullDatabases: PublicOverviewScheduleTarget[];
  nextFullGroups: SourceGroup[];
}

export interface PublicOverviewResponse {
  generatedAt: string;
  scheduleEnabled: boolean | null;
  schedule: PublicOverviewSchedule;
  freshness: {
    healthy: boolean;
    lastSuccessAt: string | null;
    maxAgeHours: number;
    ageHours: number | null;
  };
  databases: PublicOverviewDatabase[];
  activeJob: PublicOverviewActiveJob | null;
  jobSummary: {
    ok: number;
    error: number;
    partial: number;
    running: number;
    total: number;
  };
  historyByDay: Array<{
    date: string;
    ok: number;
    error: number;
    partial: number;
    running: number;
    bytesWritten: number;
    durationSecAvg: number | null;
    rowCountTotal: number;
  }>;
  recentJobs: Array<{
    runId: string;
    status: BackupRunStatus;
    mode: BackupMode;
    trigger: BackupTrigger;
    startedAt: string;
    finishedAt: string | null;
    queuedAt: string | null;
    sourceGroups: string | null;
    databasesFilter: string | null;
    error: string | null;
  }>;
  zones: {
    primaryExists: boolean;
    lockHeld: boolean;
    runCount: number;
    isolatedConfigured: boolean;
    freeHint: string | null;
  };
  disk: IBackupDiskUsage | null;
}

@Injectable()
export class BackupService {
  private readonly logger = new Logger(BackupService.name);

  private readonly inFlightRunIds = new Set<string>();

  constructor(
    @Inject(BackupConfigService)
    private readonly backupConfig: BackupConfigService,
    @Inject(SourceRegistry)
    private readonly sourceRegistry: SourceRegistry,
    @Inject(BackupRunnerService)
    private readonly runner: BackupRunnerService,
    @Inject(PrimaryZoneService)
    private readonly primaryZone: PrimaryZoneService,
    @Inject(RetentionService)
    private readonly retention: RetentionService,
    @Inject(RestorePlanService)
    private readonly restorePlan: RestorePlanService,
    @Inject(ARCHIVE_TARGET) private readonly archiveTarget: ArchiveTarget,
    @Optional()
    private readonly backupEvents?: BackupEventsService,
    @Optional()
    @Inject(forwardRef(() => BackupQueueService))
    private readonly backupQueue?: BackupQueueService,
    @Optional()
    private readonly backupRedis?: BackupRedisService,
    @Optional()
    @InjectRepository(BackupRunEntity)
    private readonly runRepo?: Repository<BackupRunEntity>,
    @Optional()
    @InjectRepository(BackupDatabaseRunEntity)
    private readonly dbRunRepo?: Repository<BackupDatabaseRunEntity>,
  ) {}

  /** HTTP / cron: enqueue on BullMQ (status queued). */
  async triggerRun(options: BackupRunOptions): Promise<TriggerRunResult> {
    if (!this.backupQueue) {
      throw new ConflictException(
        'Backup queue is not available in this process',
      );
    }

    return this.backupQueue.enqueue(options);
  }

  async cancelRun(runId: string): Promise<{ runId: string; status: string }> {
    if (!this.backupQueue) {
      throw new ConflictException(
        'Backup queue is not available in this process',
      );
    }

    return this.backupQueue.cancel(runId);
  }

  async getQueueSnapshot() {
    if (!this.backupQueue) {
      throw new ConflictException(
        'Backup queue is not available in this process',
      );
    }

    return this.backupQueue.getQueueSnapshot();
  }

  async cancelAllQueued() {
    if (!this.backupQueue) {
      throw new ConflictException(
        'Backup queue is not available in this process',
      );
    }

    return this.backupQueue.cancelAllQueued();
  }

  /**
   * BullMQ worker entry: per-database locks inside runner, persist history.
   */
  async executeQueuedRun(
    options: BackupRunOptions,
    runId: string,
    signal?: AbortSignal,
    progressCtx?: BackupRunProgressContext,
  ): Promise<RunManifest> {
    const settings = await this.backupConfig.getSettings();
    await this.primaryZone.ensureLayout();

    this.inFlightRunIds.add(runId);

    try {
      if (signal?.aborted) {
        throw new BackupCancelledError(runId);
      }

      return await this.executeRun(options, runId, signal, progressCtx);
    } catch (error) {
      if (error instanceof BackupCancelledError) {
        throw error;
      }

      await this.failRunHistory(
        runId,
        options,
        settings.backupDir,
        error instanceof Error ? error.message : String(error),
      );

      throw error;
    } finally {
      this.clearInFlight(runId);
    }
  }

  /** CLI: wait for completion (bypasses Bull — uses per-database locks). */
  async runOnceAndWait(options: BackupRunOptions): Promise<RunManifest> {
    await this.primaryZone.ensureLayout();

    const runId = createRunId();
    this.inFlightRunIds.add(runId);

    try {
      return await this.executeRun(options, runId);
    } finally {
      this.clearInFlight(runId);
    }
  }

  async listSources() {
    let volumeDirs: { HIS: string; EMR: string; LIS: string } | null = null;

    try {
      volumeDirs = (await this.backupConfig.getSettings()).volumeDirs;
    } catch {
      volumeDirs = null;
    }

    const sources = await this.sourceRegistry.listAllSources();

    return sources.map((source) => {
      const watermarks: Record<string, string | null> = {};

      if (volumeDirs) {
        const volumeDir =
          source.group === 'HIS'
            ? volumeDirs.HIS
            : source.group === 'LIS'
              ? volumeDirs.LIS
              : volumeDirs.EMR;

        for (const database of source.databases) {
          const profile =
            source.group === 'HIS'
              ? 'adempiere'
              : source.group === 'LIS'
                ? 'snapshot'
                : source.group === 'EMR'
                  ? 'envers'
                  : 'snapshot';

          try {
            watermarks[database] = loadState(
              volumeDir,
              database,
              profile,
            ).watermark;
          } catch {
            watermarks[database] = null;
          }
        }
      }

      return {
        group: source.group,
        host: source.host,
        port: source.port,
        databases: source.databases,
        reachability: source.reachability,
        reason: source.reason,
        watermarks,
      };
    });
  }

  async getZones() {
    return {
      primary: await this.primaryZone.getStatus(),
      isolatedCopy: {
        target: this.archiveTarget.name,
        configured: this.archiveTarget.isConfigured(),
      },
    };
  }

  getRestorePlan(database: string) {
    return this.restorePlan.buildPlan(database);
  }

  getInFlightRunId(): string | null {
    const first = this.inFlightRunIds.values().next();

    return first.done ? null : first.value;
  }

  getInFlightRunIds(): string[] {
    return [...this.inFlightRunIds];
  }

  /** True when this process has in-flight runs or BullMQ has active jobs. */
  async isBackupInProgress(): Promise<boolean> {
    if (this.inFlightRunIds.size > 0) {
      return true;
    }

    if (this.backupQueue) {
      try {
        return (await this.backupQueue.getActiveJobCount()) > 0;
      } catch {
        // fall through
      }
    }

    try {
      const zones = await this.getZones();

      return Boolean(zones.primary.lockHeld);
    } catch {
      return false;
    }
  }

  async listRuns(limit = 50): Promise<BackupRunEntity[]> {
    if (!this.runRepo || !(await this.historyEnabled())) {
      return this.listRunsFromFilesystem(limit);
    }

    return this.runRepo.find({
      order: { startedAt: 'DESC' },
      take: limit,
      relations: ['databases'],
    });
  }

  async getRun(runId: string): Promise<BackupRunEntity | RunManifest> {
    if (this.runRepo && (await this.historyEnabled())) {
      const row = await this.runRepo.findOne({
        where: { runId },
        relations: ['databases'],
      });

      if (row) {
        return row;
      }
    }

    const manifest = (await this.primaryZone.readManifest(
      runId,
    )) as RunManifest | null;

    if (!manifest) {
      throw new NotFoundException(`Run ${runId} not found`);
    }

    return manifest;
  }

  async getFreshness(): Promise<{
    healthy: boolean;
    lastSuccessAt: string | null;
    maxAgeHours: number;
    ageHours: number | null;
  }> {
    let maxAgeHours = 5;

    try {
      maxAgeHours = (await this.backupConfig.getSettings())
        .freshnessMaxAgeHours;
    } catch {
      // BACKUP_DIR may be unset on API-only hosts
    }

    let lastSuccessAt: string | null = null;

    try {
      const runIds = await this.primaryZone.listRunIds();

      for (const runId of [...runIds].reverse()) {
        const manifest = (await this.primaryZone.readManifest(
          runId,
        )) as RunManifest | null;

        if (!manifest?.finishedAt) {
          continue;
        }

        if (manifest.databases.some((d) => d.status === 'ok')) {
          lastSuccessAt = manifest.finishedAt;
          break;
        }
      }
    } catch {
      return {
        healthy: false,
        lastSuccessAt: null,
        maxAgeHours,
        ageHours: null,
      };
    }

    if (!lastSuccessAt) {
      return {
        healthy: false,
        lastSuccessAt: null,
        maxAgeHours,
        ageHours: null,
      };
    }

    const ageHours =
      (Date.now() - new Date(lastSuccessAt).getTime()) / (1000 * 60 * 60);

    return {
      healthy: ageHours <= maxAgeHours,
      lastSuccessAt,
      maxAgeHours,
      ageHours: Math.round(ageHours * 10) / 10,
    };
  }

  /** Read-only aggregate for the public TV wallboard. */
  async getPublicOverview(): Promise<PublicOverviewResponse> {
    const now = new Date();
    const [sources, runs, zones, freshness, schedule, scheduleCronContext] =
      await Promise.all([
        this.listSources(),
        this.listRuns(PUBLIC_OVERVIEW_RUN_SAMPLE),
        this.getZones(),
        this.getFreshness(),
        this.resolvePublicSchedule(),
        this.resolveIncrementalCronByDatabase(),
      ]);
    const { cronByDatabaseKey, timezone } = scheduleCronContext;

    const compression = estimateGzipCompression(
      this.collectCompressionSamples(runs),
    );
    const disk = await this.readDiskUsageWithForecast(compression, runs, now);

    const databases: PublicOverviewDatabase[] = [];

    for (const source of sources) {
      for (const database of source.databases) {
        const latest = this.findLatestDbRun(runs, source.group, database);
        const lagAnchor = latest?.finishedAt ?? latest?.startedAt ?? null;
        const cronExpr =
          cronByDatabaseKey.get(`${source.group}:${database}`) ??
          DEFAULT_INCREMENTAL_CRON;
        databases.push({
          group: source.group,
          database,
          host: source.host,
          live: source.reachability === 'ready',
          reachability: source.reachability,
          reason: source.reason ?? null,
          lastDbStatus: latest?.dbStatus ?? null,
          lastRunStatus: latest?.runStatus ?? null,
          lastStartedAt: latest?.startedAt ?? null,
          watermark: source.watermarks[database] ?? null,
          lagMinutes: lagMinutesFromLastStartedAt(lagAnchor, now),
          lagState: resolveBackupLagState({
            lastOkAt: lagAnchor,
            lastDbStatus: latest?.dbStatus ?? null,
            cronExpr,
            timezone,
            now,
          }),
        });
      }

      if (source.databases.length === 0) {
        databases.push({
          group: source.group,
          database: '(chưa cấu hình)',
          host: source.host || '—',
          live: false,
          reachability: source.reachability,
          reason: source.reason ?? null,
          lastDbStatus: null,
          lastRunStatus: null,
          lastStartedAt: null,
          watermark: null,
          lagMinutes: null,
          lagState: 'no_data',
        });
      }
    }

    const runRows = runs.map((run) => ({
      startedAt: run.startedAt,
      status: run.status,
    }));
    const historyRuns = runs.map((run) => {
      let bytesWritten = 0;
      let rowCountTotal = 0;

      for (const db of run.databases ?? []) {
        const bytes = Number(db.bytesTotal ?? 0);
        const rows = Number(db.rowCountTotal ?? 0);

        if (Number.isFinite(bytes) && bytes > 0) {
          bytesWritten += bytes;
        }

        if (Number.isFinite(rows) && rows > 0) {
          rowCountTotal += rows;
        }
      }

      return {
        startedAt: run.startedAt,
        finishedAt: run.finishedAt,
        status: run.status,
        bytesWritten,
        rowCountTotal,
      };
    });
    const activeJob = await this.resolveActiveJob(runs);

    return {
      generatedAt: now.toISOString(),
      scheduleEnabled: schedule.enabled,
      schedule,
      freshness,
      databases,
      activeJob,
      jobSummary: summarizeJobs(runRows, now),
      historyByDay: aggregateHistoryByDay(historyRuns, now),
      recentJobs: runs.slice(0, PUBLIC_OVERVIEW_RECENT_JOBS).map((run) => ({
        runId: run.runId,
        status: run.status,
        mode: run.mode,
        trigger: run.trigger,
        startedAt:
          run.startedAt instanceof Date
            ? run.startedAt.toISOString()
            : String(run.startedAt),
        finishedAt: run.finishedAt
          ? run.finishedAt instanceof Date
            ? run.finishedAt.toISOString()
            : String(run.finishedAt)
          : null,
        queuedAt: run.queuedAt
          ? run.queuedAt instanceof Date
            ? run.queuedAt.toISOString()
            : String(run.queuedAt)
          : null,
        sourceGroups: run.sourceGroups ?? null,
        databasesFilter: run.databasesFilter ?? null,
        error: truncateError(run.error),
      })),
      zones: {
        primaryExists: Boolean(zones.primary.exists),
        lockHeld: Boolean(zones.primary.lockHeld),
        runCount: zones.primary.runCount,
        isolatedConfigured: Boolean(zones.isolatedCopy.configured),
        freeHint: zones.primary.freeHint,
      },
      disk,
    };
  }

  private async readDiskUsage(): Promise<IBackupDiskUsage | null> {
    try {
      const settings = await this.backupConfig.getSettings();

      return await collectBackupDiskUsage({
        diskPath: settings.backupRoot ?? settings.backupDir,
        metaPath: settings.backupDir,
        volumePaths: [
          settings.volumeDirs.HIS,
          settings.volumeDirs.EMR,
          settings.volumeDirs.LIS,
        ],
      });
    } catch {
      return null;
    }
  }

  private async readDiskUsageWithForecast(
    compression: {
      compressionRatio: number | null;
      compressionSavingsPercent: number | null;
    },
    runs: BackupRunEntity[],
    now = new Date(),
  ): Promise<IBackupDiskUsage | null> {
    try {
      const settings = await this.backupConfig.getSettings();
      const disk = await collectBackupDiskUsage({
        diskPath: settings.backupRoot ?? settings.backupDir,
        metaPath: settings.backupDir,
        volumePaths: [
          settings.volumeDirs.HIS,
          settings.volumeDirs.EMR,
          settings.volumeDirs.LIS,
        ],
      });

      if (!disk?.exists) {
        return disk
          ? {
              ...disk,
              forecast: {
                dailyGrowthBytes: null,
                compressionRatio: compression.compressionRatio,
                compressionSavingsPercent:
                  compression.compressionSavingsPercent,
                estimatedDaysUntilFull: null,
              },
            }
          : null;
      }

      const samples = recordDiskUsageSample(settings.backupDir, disk.usedBytes);
      let growth = computeDiskGrowthForecast(samples, disk.freeBytes);

      if (growth.dailyGrowthBytes == null) {
        const written = this.sumOkBackupBytesLastDays(runs, now, 7);
        growth = estimateGrowthFromBackupBytes(written, disk.freeBytes, 7);
      }

      return {
        ...disk,
        forecast: {
          dailyGrowthBytes: growth.dailyGrowthBytes,
          compressionRatio: compression.compressionRatio,
          compressionSavingsPercent: compression.compressionSavingsPercent,
          estimatedDaysUntilFull: growth.estimatedDaysUntilFull,
        },
      };
    } catch {
      return null;
    }
  }

  private sumOkBackupBytesLastDays(
    runs: BackupRunEntity[],
    now: Date,
    days: number,
  ): number {
    const cutoff = now.getTime() - days * 86_400_000;
    let total = 0;

    for (const run of runs) {
      const started =
        run.startedAt instanceof Date ? run.startedAt : new Date(run.startedAt);

      if (Number.isNaN(started.getTime()) || started.getTime() < cutoff) {
        continue;
      }

      for (const db of run.databases ?? []) {
        if (db.status !== 'ok') {
          continue;
        }

        const bytes = Number(db.bytesTotal ?? 0);

        if (Number.isFinite(bytes) && bytes > 0) {
          total += bytes;
        }
      }
    }

    return total;
  }

  private async resolveIncrementalCronByDatabase(): Promise<{
    cronByDatabaseKey: Map<string, string>;
    timezone: string;
  }> {
    const cronByDatabaseKey = new Map<string, string>();
    let timezone = 'Asia/Ho_Chi_Minh';

    try {
      const settings = await this.backupConfig.getSettings();
      timezone = settings.timezone?.trim() || timezone;
      const databases =
        await this.backupConfig.listConfiguredScheduleDatabases();
      const buckets =
        await this.backupConfig.getIncrementalCronBuckets(databases);

      for (const bucket of buckets) {
        for (const entry of bucket.databases) {
          cronByDatabaseKey.set(
            `${entry.group}:${entry.database}`,
            bucket.cron,
          );
        }
      }
    } catch {
      // Wallboard still works with DEFAULT_INCREMENTAL_CRON per database.
    }

    return { cronByDatabaseKey, timezone };
  }

  private async resolvePublicSchedule(): Promise<PublicOverviewSchedule> {
    let enabled: boolean | null = null;

    try {
      enabled = (await this.backupConfig.getSettings()).scheduleEnabled;
    } catch {
      enabled = null;
    }

    const empty: PublicOverviewSchedule = {
      enabled,
      nextIncrementalAt: null,
      nextFullAt: null,
      nextFullLabel: null,
      nextIncrementalDatabases: [],
      nextFullDatabases: [],
      nextFullGroups: [],
    };

    try {
      const databases =
        await this.backupConfig.listConfiguredScheduleDatabases();
      const buckets =
        await this.backupConfig.getIncrementalCronBuckets(databases);

      const byGroup = new Map<SourceGroup, typeof databases>();

      for (const entry of databases) {
        const list = byGroup.get(entry.group) ?? [];
        list.push(entry);
        byGroup.set(entry.group, list);
      }

      const fullGroups: Array<{
        group: SourceGroup;
        cron: string;
        databases: typeof databases;
      }> = [];

      for (const group of ['HIS', 'EMR', 'LIS'] as const) {
        const cron = await this.backupConfig.getSettingValue(
          `BACKUP_${group}_FULL_CRON`,
        );

        if (!cron?.trim()) {
          continue;
        }

        fullGroups.push({
          group,
          cron: cron.trim(),
          databases: byGroup.get(group) ?? [],
        });
      }

      const next = buildNextScheduleTimes({
        enabled,
        incrementalBuckets: buckets,
        fullGroups,
      });

      return { enabled, ...next };
    } catch {
      return empty;
    }
  }

  private collectCompressionSamples(
    runs: BackupRunEntity[],
  ): Array<{ rowCountTotal: number; bytesTotal: number }> {
    const samples: Array<{ rowCountTotal: number; bytesTotal: number }> = [];

    for (const run of runs) {
      for (const db of run.databases ?? []) {
        if (db.status !== 'ok') {
          continue;
        }

        const rowCountTotal = Number(db.rowCountTotal ?? 0);
        const bytesTotal = Number(db.bytesTotal ?? 0);

        if (rowCountTotal > 0 && bytesTotal > 0) {
          samples.push({ rowCountTotal, bytesTotal });
        }

        if (samples.length >= 40) {
          return samples;
        }
      }
    }

    return samples;
  }

  private async resolveActiveJob(
    runs: BackupRunEntity[],
  ): Promise<PublicOverviewActiveJob | null> {
    const selected =
      runs.find((run) => run.status === 'running') ??
      runs.find(
        (run) =>
          run.status === 'ok' ||
          run.status === 'partial' ||
          run.status === 'error' ||
          run.status === 'cancelled',
      );

    if (!selected) {
      return null;
    }

    const startedAt =
      selected.startedAt instanceof Date
        ? selected.startedAt.toISOString()
        : String(selected.startedAt);
    const isRunning = selected.status === 'running';
    const completedOk =
      selected.status === 'ok' || selected.status === 'partial';
    let percent = completedOk ? 100 : 0;
    let rowsProcessed = 0;
    let bytesProcessed = 0;
    let rowsPerSec = 0;
    let bytesPerSec = 0;
    let etaSeconds: number | null = completedOk ? 0 : null;
    let currentDatabase: string | null = null;
    let currentTable: string | null = null;
    let progressStartedAt: string | null = startedAt;

    for (const db of selected.databases ?? []) {
      const rows = Number(db.rowCountTotal ?? 0);
      const bytes = Number(db.bytesTotal ?? 0);

      if (Number.isFinite(rows) && rows > 0) {
        rowsProcessed += rows;
      }

      if (Number.isFinite(bytes) && bytes > 0) {
        bytesProcessed += bytes;
      }

      if (!currentDatabase) {
        currentDatabase = db.database ?? null;
      }
    }

    if (this.backupRedis) {
      try {
        const last = await this.backupRedis.getLastProgress(selected.runId);

        if (last) {
          if (isRunning) {
            percent = last.percent ?? percent;
            etaSeconds = last.etaSeconds ?? etaSeconds;
            rowsPerSec = last.rowsPerSec ?? rowsPerSec;
            bytesPerSec = last.bytesPerSec ?? bytesPerSec;
          } else if (!completedOk) {
            percent = last.percent ?? percent;
          }

          rowsProcessed = last.rowsProcessed ?? rowsProcessed;
          bytesProcessed = last.bytesProcessed ?? bytesProcessed;
          currentDatabase = last.currentDatabase ?? currentDatabase;
          currentTable = last.currentTable ?? currentTable;
          progressStartedAt = last.startedAt ?? progressStartedAt;
        }
      } catch {
        // ignore redis errors for wallboard
      }
    }

    if (completedOk) {
      percent = 100;
      etaSeconds = 0;
    }

    let finishedAt: string | null = null;

    if (!isRunning && selected.finishedAt) {
      const finished = new Date(selected.finishedAt);
      finishedAt = Number.isNaN(finished.getTime())
        ? null
        : finished.toISOString();
    }

    return {
      runId: selected.runId,
      mode: selected.mode,
      status: selected.status,
      startedAt: progressStartedAt,
      percent,
      rowsProcessed,
      estimatedRowsTotal: estimatedRowsTotal(rowsProcessed, percent),
      bytesProcessed,
      rowsPerSec,
      bytesPerSec,
      etaSeconds,
      currentDatabase,
      currentTable,
      finishedAt,
    };
  }

  private findLatestDbRun(
    runs: BackupRunEntity[],
    group: SourceGroup,
    database: string,
  ): {
    dbStatus: 'ok' | 'error' | 'skipped';
    runStatus: BackupRunStatus;
    startedAt: string;
    finishedAt: string | null;
  } | null {
    let fallback: {
      dbStatus: 'ok' | 'error' | 'skipped';
      runStatus: BackupRunStatus;
      startedAt: string;
      finishedAt: string | null;
    } | null = null;

    for (const run of runs) {
      const dbs = run.databases ?? [];
      const exact = dbs.find(
        (row) => row.database === database && row.sourceGroup === group,
      );
      const byName =
        exact ?? dbs.find((row) => row.database === database) ?? null;

      if (!byName) {
        continue;
      }

      const startedAt =
        run.startedAt instanceof Date
          ? run.startedAt.toISOString()
          : String(run.startedAt);
      const finishedAt = run.finishedAt
        ? run.finishedAt instanceof Date
          ? run.finishedAt.toISOString()
          : String(run.finishedAt)
        : null;
      const hit = {
        dbStatus: byName.status,
        runStatus: run.status,
        startedAt,
        finishedAt,
      };

      if (byName.status === 'ok') {
        return hit;
      }

      if (!fallback) {
        fallback = hit;
      }
    }

    return fallback;
  }

  private async historyEnabled(): Promise<boolean> {
    try {
      return (await this.backupConfig.getSettings()).historyEnabled;
    } catch {
      return false;
    }
  }

  private async listRunsFromFilesystem(
    limit: number,
  ): Promise<BackupRunEntity[]> {
    const runIds = [...(await this.primaryZone.listRunIds())]
      .reverse()
      .slice(0, limit);

    const entities: BackupRunEntity[] = [];

    for (const runId of runIds) {
      const manifest = (await this.primaryZone.readManifest(
        runId,
      )) as RunManifest | null;
      const entity = new BackupRunEntity();
      entity.runId = runId;
      entity.startedAt = new Date(manifest?.startedAt ?? 0);
      entity.finishedAt = manifest?.finishedAt
        ? new Date(manifest.finishedAt)
        : null;
      entity.status = this.aggregateStatus(manifest?.databases ?? []);
      entity.trigger = 'manual';
      entity.mode = manifest?.mode ?? 'incremental';
      entity.backupDir = manifest?.backupDir ?? '';
      entity.error = null;
      entity.databases = [];
      entities.push(entity);
    }

    return entities;
  }

  private clearInFlight(runId: string): void {
    this.inFlightRunIds.delete(runId);
  }

  private async executeRun(
    options: BackupRunOptions,
    runId: string,
    signal?: AbortSignal,
    progressCtx?: BackupRunProgressContext,
  ): Promise<RunManifest> {
    const mode = options.mode ?? 'incremental';
    let sources = await this.sourceRegistry.getRunnableSources();

    if (options.sourceGroups && options.sourceGroups.length > 0) {
      const allowed = new Set(options.sourceGroups);
      sources = sources.filter((s) => allowed.has(s.group));
    }

    if (options.databases && options.databases.length > 0) {
      const allowedDb = new Set(options.databases);
      sources = sources
        .map((source) => ({
          ...source,
          databases: source.databases.filter((database) =>
            allowedDb.has(database),
          ),
        }))
        .filter((source) => source.databases.length > 0);
    }

    const config = await this.backupConfig.getBackupConfig(sources, mode);
    await this.markRunRunning(runId, options, config.backupDir);
    const manifest = await this.runner.run(config, runId, signal, progressCtx);

    if (signal?.aborted) {
      throw new BackupCancelledError(runId);
    }

    const archive = await this.archiveTarget.publishRun(
      manifest.runId,
      await this.primaryZone.runDir(manifest.runId),
    );

    await this.persistHistory(manifest, options.trigger, archive.status);
    await this.retention.applyRetention({
      inFlightRunIds: this.getInFlightRunIds(),
    });

    return manifest;
  }

  /** Transition queued → running (or insert running for CLI). */
  private async markRunRunning(
    runId: string,
    options: BackupRunOptions,
    backupDir: string,
  ): Promise<void> {
    if (!this.runRepo || !(await this.historyEnabled())) {
      return;
    }

    try {
      const existing = await this.runRepo.findOne({ where: { runId } });

      if (existing) {
        existing.status = 'running';
        existing.startedAt = new Date();
        existing.finishedAt = null;
        existing.backupDir = backupDir || existing.backupDir;
        existing.error = null;
        await this.runRepo.save(existing);
        this.backupEvents?.emitStatus({
          runId,
          status: 'running',
          mode: existing.mode,
          trigger: existing.trigger,
        });

        return;
      }

      await this.runRepo.save(
        this.runRepo.create({
          runId,
          startedAt: new Date(),
          finishedAt: null,
          status: 'running',
          trigger: options.trigger,
          mode: options.mode ?? 'incremental',
          backupDir,
          error: null,
          archiveStatus: null,
          sourceGroups: options.sourceGroups?.join(',') ?? null,
          databasesFilter: options.databases?.join(',') ?? null,
          queuedAt: null,
        }),
      );
      this.backupEvents?.emitStatus({
        runId,
        status: 'running',
        mode: options.mode ?? 'incremental',
        trigger: options.trigger,
      });
    } catch (error) {
      this.logger.warn(
        `Failed to mark run ${runId} as running: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  private async failRunHistory(
    runId: string,
    options: BackupRunOptions,
    backupDir: string,
    message: string,
  ): Promise<void> {
    if (!this.runRepo || !(await this.historyEnabled())) {
      return;
    }

    try {
      let row = await this.runRepo.findOne({ where: { runId } });

      if (row) {
        row.status = 'error';
        row.error = message;
        row.finishedAt = new Date();
      } else {
        row = this.runRepo.create({
          runId,
          startedAt: new Date(),
          finishedAt: null,
          status: 'error',
          trigger: options.trigger,
          mode: options.mode ?? 'incremental',
          backupDir,
          error: message,
          archiveStatus: null,
        });
      }

      await this.runRepo.save(row);
      this.backupEvents?.emitStatus({
        runId,
        status: 'error',
        mode: options.mode ?? 'incremental',
        trigger: options.trigger,
        error: message,
      });
      this.backupEvents?.emitLog({
        runId,
        level: 'error',
        message,
      });
    } catch (error) {
      this.logger.warn(
        `Failed to persist failed run ${runId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  private async persistHistory(
    manifest: RunManifest,
    trigger: BackupTrigger,
    archiveStatus: string,
  ): Promise<void> {
    if (!this.runRepo || !this.dbRunRepo || !(await this.historyEnabled())) {
      return;
    }

    try {
      const status = this.aggregateStatus(manifest.databases);
      let saved = await this.runRepo.findOne({
        where: { runId: manifest.runId },
      });

      if (saved?.status === 'cancelled') {
        return;
      }

      if (saved) {
        saved.startedAt = new Date(manifest.startedAt);
        saved.finishedAt = manifest.finishedAt
          ? new Date(manifest.finishedAt)
          : null;
        saved.status = status;
        saved.trigger = trigger;
        saved.mode = manifest.mode ?? 'incremental';
        saved.backupDir = manifest.backupDir;
        saved.error = null;
        saved.archiveStatus = archiveStatus;
        saved = await this.runRepo.save(saved);
        await this.dbRunRepo.delete({ runId: manifest.runId });
      } else {
        saved = await this.runRepo.save(
          this.runRepo.create({
            runId: manifest.runId,
            startedAt: new Date(manifest.startedAt),
            finishedAt: manifest.finishedAt
              ? new Date(manifest.finishedAt)
              : null,
            status,
            trigger,
            mode: manifest.mode ?? 'incremental',
            backupDir: manifest.backupDir,
            error: null,
            archiveStatus,
          }),
        );
      }

      const dbRows = manifest.databases.map((db) =>
        this.dbRunRepo!.create(
          this.toDbRunEntity(db, saved.id, manifest.runId),
        ),
      );

      if (dbRows.length > 0) {
        await this.dbRunRepo.save(dbRows);
      }

      this.backupEvents?.emitStatus({
        runId: manifest.runId,
        status,
        mode: manifest.mode ?? 'incremental',
        trigger,
      });
      this.backupEvents?.emitLog({
        runId: manifest.runId,
        level: status === 'error' ? 'error' : 'info',
        message: `Run finished with status=${status}`,
      });
    } catch (error) {
      this.logger.warn(
        `Failed to persist backup history: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  private toDbRunEntity(
    db: DatabaseRunResult,
    backupRunId: string,
    runId: string,
  ): Partial<BackupDatabaseRunEntity> {
    const bytesTotal = db.chunks.reduce((sum, c) => sum + c.bytes, 0);
    const rowCountTotal = db.chunks.reduce(
      (sum, c) => sum + Math.max(c.rowCount, 0),
      0,
    );

    return {
      runId,
      backupRunId,
      sourceGroup: db.group,
      database: db.database,
      profile: db.profile,
      status: db.status,
      watermarkBefore: db.watermarkBefore,
      captured: db.captured,
      watermarkAfter: db.watermarkAfter,
      chunkCount: db.chunks.length,
      bytesTotal: String(bytesTotal),
      rowCountTotal: String(rowCountTotal),
      skippedTableCount: db.skippedTables.length,
      error: db.error ?? null,
    };
  }

  private aggregateStatus(
    databases: Array<{ status: string }>,
  ): BackupRunStatus {
    if (databases.length === 0) {
      return 'ok';
    }

    const errors = databases.filter((d) => d.status === 'error').length;
    const oks = databases.filter((d) => d.status === 'ok').length;

    if (errors === 0) {
      return 'ok';
    }

    if (oks === 0) {
      return 'error';
    }

    return 'partial';
  }
}
