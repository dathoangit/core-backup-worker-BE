import {
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import type { Repository } from 'typeorm';

import { BackupConfigService } from './backup-config.service';
import { BackupRunnerService } from './engine/backup-runner.service';
import { acquireLock } from './engine/lock';
import { createRunId } from './engine/manifest';
import { loadState } from './engine/state';
import { BackupDatabaseRunEntity } from './entities/backup-database-run.entity';
import { BackupRunEntity } from './entities/backup-run.entity';
import {
  collectBackupDiskUsage,
  type IBackupDiskUsage,
} from './disk-stats.util';
import {
  aggregateHistoryByDay,
  PUBLIC_OVERVIEW_RECENT_JOBS,
  PUBLIC_OVERVIEW_RUN_SAMPLE,
  summarizeJobs,
  truncateError,
} from './public-overview.util';
import { SourceRegistry } from './source-registry';
import type {
  BackupMode,
  BackupRunOptions,
  BackupRunStatus,
  BackupTrigger,
  DatabaseRunResult,
  RunManifest,
  SourceGroup,
  SourceReachability,
} from './types';
import {
  ARCHIVE_TARGET,
  type ArchiveTarget,
} from './zones/archive-target.interface';
import { PrimaryZoneService } from './zones/primary-zone.service';
import { RetentionService } from './zones/retention.service';
import { RestorePlanService } from './zones/restore-plan.service';

export interface TriggerRunResult {
  runId: string;
  status: 'accepted';
  message: string;
  mode: BackupMode;
}

export type PublicOverviewDatabase = {
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
};

export type PublicOverviewResponse = {
  generatedAt: string;
  scheduleEnabled: boolean | null;
  freshness: {
    healthy: boolean;
    lastSuccessAt: string | null;
    maxAgeHours: number;
    ageHours: number | null;
  };
  databases: PublicOverviewDatabase[];
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
  }>;
  recentJobs: Array<{
    runId: string;
    status: BackupRunStatus;
    mode: BackupMode;
    trigger: BackupTrigger;
    startedAt: string;
    finishedAt: string | null;
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
};

@Injectable()
export class BackupService {
  private readonly logger = new Logger(BackupService.name);
  private inFlightRunId: string | null = null;

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
    @InjectRepository(BackupRunEntity)
    private readonly runRepo?: Repository<BackupRunEntity>,
    @Optional()
    @InjectRepository(BackupDatabaseRunEntity)
    private readonly dbRunRepo?: Repository<BackupDatabaseRunEntity>,
  ) {}

  /** HTTP trigger: returns immediately; work continues in background. */
  triggerRun(options: BackupRunOptions): TriggerRunResult {
    const mode = options.mode ?? 'incremental';
    if (this.inFlightRunId) {
      throw new ConflictException(
        `A backup run is already in progress (${this.inFlightRunId})`,
      );
    }

    const runId = createRunId();
    this.inFlightRunId = runId;

    void this.startBackground(options, runId).catch((error: unknown) => {
      this.logger.error(
        `background backup failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    });

    return {
      runId,
      status: 'accepted',
      mode,
      message: `Backup started in background (mode=${mode})`,
    };
  }

  /** CLI / scheduler: wait for completion. */
  async runOnceAndWait(options: BackupRunOptions): Promise<RunManifest> {
    if (this.inFlightRunId) {
      throw new ConflictException(
        `A backup run is already in progress (${this.inFlightRunId})`,
      );
    }

    const settings = await this.backupConfig.getSettings();
    await this.primaryZone.ensureLayout();

    const lock = acquireLock(settings.backupDir);
    if (!lock) {
      throw new ConflictException(
        'Another backup process holds backup.lock; exiting without moving checkpoints',
      );
    }

    const runId = createRunId();
    this.inFlightRunId = runId;

    try {
      return await this.executeRun(options, lock, runId);
    } finally {
      this.inFlightRunId = null;
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
    return this.inFlightRunId;
  }

  /** True when this process has an in-flight run or backup.lock is held. */
  async isBackupInProgress(): Promise<boolean> {
    if (this.inFlightRunId) {
      return true;
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
      maxAgeHours = (await this.backupConfig.getSettings()).freshnessMaxAgeHours;
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
    const [sources, runs, zones, freshness, disk] = await Promise.all([
      this.listSources(),
      this.listRuns(PUBLIC_OVERVIEW_RUN_SAMPLE),
      this.getZones(),
      this.getFreshness(),
      this.readDiskUsage(),
    ]);

    let scheduleEnabled: boolean | null = null;
    try {
      scheduleEnabled = (await this.backupConfig.getSettings()).scheduleEnabled;
    } catch {
      scheduleEnabled = null;
    }

    const databases: PublicOverviewDatabase[] = [];
    for (const source of sources) {
      for (const database of source.databases) {
        const latest = this.findLatestDbRun(runs, source.group, database);
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
        });
      }
    }

    const runRows = runs.map((run) => ({
      startedAt: run.startedAt,
      status: run.status,
    }));

    return {
      generatedAt: now.toISOString(),
      scheduleEnabled,
      freshness,
      databases,
      jobSummary: summarizeJobs(runRows, now),
      historyByDay: aggregateHistoryByDay(runRows, now),
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

  private findLatestDbRun(
    runs: BackupRunEntity[],
    group: SourceGroup,
    database: string,
  ): {
    dbStatus: 'ok' | 'error' | 'skipped';
    runStatus: BackupRunStatus;
    startedAt: string;
  } | null {
    for (const run of runs) {
      const db = run.databases?.find(
        (row) => row.database === database && row.sourceGroup === group,
      );
      if (!db) {
        continue;
      }

      return {
        dbStatus: db.status,
        runStatus: run.status,
        startedAt:
          run.startedAt instanceof Date
            ? run.startedAt.toISOString()
            : String(run.startedAt),
      };
    }

    return null;
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

  private async startBackground(
    options: BackupRunOptions,
    runId: string,
  ): Promise<void> {
    try {
      const settings = await this.backupConfig.getSettings();
      await this.primaryZone.ensureLayout();
      const lock = acquireLock(settings.backupDir);
      if (!lock) {
        this.logger.error(
          'background backup aborted: backup.lock held by another process',
        );

        return;
      }

      try {
        await this.executeRun(options, lock, runId);
      } finally {
        if (this.inFlightRunId === runId) {
          this.inFlightRunId = null;
        }
      }
    } catch (error) {
      if (this.inFlightRunId === runId) {
        this.inFlightRunId = null;
      }
      throw error;
    }
  }

  private async executeRun(
    options: BackupRunOptions,
    lock: { release: () => void },
    runId: string,
  ): Promise<RunManifest> {
    const mode = options.mode ?? 'incremental';
    try {
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
      const manifest = await this.runner.run(config, runId);

      const archive = await this.archiveTarget.publishRun(
        manifest.runId,
        await this.primaryZone.runDir(manifest.runId),
      );

      await this.persistHistory(manifest, options.trigger, archive.status);
      await this.retention.applyRetention({
        inFlightRunId: this.inFlightRunId,
      });

      return manifest;
    } finally {
      lock.release();
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
      const run = this.runRepo.create({
        runId: manifest.runId,
        startedAt: new Date(manifest.startedAt),
        finishedAt: manifest.finishedAt ? new Date(manifest.finishedAt) : null,
        status,
        trigger,
        mode: manifest.mode ?? 'incremental',
        backupDir: manifest.backupDir,
        error: null,
        archiveStatus,
      });
      const saved = await this.runRepo.save(run);

      const dbRows = manifest.databases.map((db) =>
        this.dbRunRepo!.create(this.toDbRunEntity(db, saved.id, manifest.runId)),
      );
      await this.dbRunRepo.save(dbRows);
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
