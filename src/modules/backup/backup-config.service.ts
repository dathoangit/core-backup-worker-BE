import { forwardRef, Inject, Injectable, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { SettingsService } from '../settings/settings.service';
import {
  applyDevRowLimitPolicy,
  type BackupVolumeDirs,
  isDevelopmentNodeEnv,
  resolveBackupPaths,
  type ResolvedBackupPaths,
} from './backup-paths';
import {
  DEFAULT_INCREMENTAL_CRON,
  groupDatabasesByIncrementalCron,
  type IncrementalCronBucket,
  incrementalCronSettingKey,
  type IncrementalCronSources,
  type ScheduledDatabase,
} from './incremental-schedule';
import {
  type BackupConfig,
  type BackupMode,
  type SourceConfig,
  type SourceGroup,
} from './types';

export interface BackupModuleSettings {
  /** Meta volume (lock). Prefer volumeDirs for artifacts. */
  backupDir: string;
  volumeDirs: BackupVolumeDirs;
  backupRoot: string | null;
  chunkSize: bigint;
  statementTimeoutMs: number;
  scheduleEnabled: boolean;
  /** @deprecated Prefer incrementalCron; kept as alias. */
  scheduleCron: string;
  /** Global incremental fallback. */
  incrementalCron: string;
  hisIncrementalCron: string;
  emrIncrementalCron: string;
  lisIncrementalCron: string;
  hisFullCron: string;
  emrFullCron: string;
  lisFullCron: string;
  timezone: string;
  historyEnabled: boolean;
  retentionDays: number;
  freshnessMaxAgeHours: number;
  archiveTarget: 'none' | 'filesystem' | 's3';
  /** 0 = production (no row cap). >0 = local sample dumps. */
  devRowLimit: number;
  compression: 'zstd' | 'gzip';
  zstdLevel: number;
  zstdThreads: number;
  verifyArchive: boolean;
  minFreeBytes: number;
  hisLogicalCron: string;
  emrLogicalCron: string;
  logicalJobs: number;
  logicalExcludeTableData: string[];
}

@Injectable()
export class BackupConfigService {
  constructor(
    private readonly configService: ConfigService,
    @Optional()
    @Inject(forwardRef(() => SettingsService))
    private readonly settingsService?: SettingsService,
  ) {}

  async getSettings(): Promise<BackupModuleSettings> {
    const paths = await this.resolvePaths();
    const archiveRaw = (
      (await this.read('BACKUP_ARCHIVE_TARGET')) ?? 'none'
    ).toLowerCase();
    const archiveTarget =
      archiveRaw === 'filesystem' || archiveRaw === 's3' ? archiveRaw : 'none';

    const globalIncremental =
      (await this.read('BACKUP_INCREMENTAL_CRON')) ??
      (await this.read('BACKUP_SCHEDULE_CRON')) ??
      DEFAULT_INCREMENTAL_CRON;

    const isDev = isDevelopmentNodeEnv();
    const rawDevLimit = await this.readOptionalInt('BACKUP_DEV_ROW_LIMIT');

    return {
      backupDir: paths.metaDir,
      volumeDirs: paths.volumeDirs,
      backupRoot: paths.backupRoot,
      chunkSize: BigInt(await this.optionalInt('BACKUP_CHUNK_SIZE', 1_000_000)),
      statementTimeoutMs: await this.optionalInt(
        'BACKUP_STATEMENT_TIMEOUT_MS',
        21_600_000,
      ),
      scheduleEnabled: await this.truthy('BACKUP_SCHEDULE_ENABLED'),
      scheduleCron: globalIncremental,
      incrementalCron: globalIncremental,
      hisIncrementalCron:
        (await this.read('BACKUP_HIS_INCREMENTAL_CRON')) ?? globalIncremental,
      emrIncrementalCron:
        (await this.read('BACKUP_EMR_INCREMENTAL_CRON')) ?? globalIncremental,
      lisIncrementalCron:
        (await this.read('BACKUP_LIS_INCREMENTAL_CRON')) ?? globalIncremental,
      hisFullCron: (await this.read('BACKUP_HIS_FULL_CRON')) ?? '30 1 * * 0',
      emrFullCron: (await this.read('BACKUP_EMR_FULL_CRON')) ?? '30 2 * * 0',
      lisFullCron: (await this.read('BACKUP_LIS_FULL_CRON')) ?? '30 3 * * 0',
      timezone: (await this.read('BACKUP_TIMEZONE')) ?? 'Asia/Ho_Chi_Minh',
      historyEnabled: await this.truthy('BACKUP_HISTORY_ENABLED', true),
      retentionDays: await this.optionalInt('BACKUP_RETENTION_DAYS', 30),
      freshnessMaxAgeHours: await this.optionalInt(
        'BACKUP_FRESHNESS_MAX_AGE_HOURS',
        5,
      ),
      archiveTarget,
      devRowLimit: applyDevRowLimitPolicy(rawDevLimit, isDev),
      compression: await this.readCompressionCodec(),
      zstdLevel: await this.optionalInt('BACKUP_ZSTD_LEVEL', 3),
      zstdThreads: await this.optionalInt('BACKUP_ZSTD_THREADS', 4),
      verifyArchive: await this.truthy('BACKUP_VERIFY_ARCHIVE', true),
      minFreeBytes:
        (await this.optionalInt('BACKUP_MIN_FREE_GB', 50)) * 1024 ** 3,
      hisLogicalCron:
        (await this.read('BACKUP_HIS_LOGICAL_CRON')) ?? '0 4 * * 0',
      emrLogicalCron:
        (await this.read('BACKUP_EMR_LOGICAL_CRON')) ?? '0 5 * * 0',
      logicalJobs: await this.optionalInt('BACKUP_LOGICAL_JOBS', 4),
      logicalExcludeTableData: this.splitCsv(
        (await this.read('BACKUP_LOGICAL_EXCLUDE_TABLE_DATA')) ??
          'adempiere.ad_changelog',
      ),
    };
  }

  /** Sync peek for callers that cannot await (rare). Prefer getSettings(). */
  getSettingsSyncFallbackFromEnv(): BackupModuleSettings {
    const isDev = isDevelopmentNodeEnv();
    const paths = resolveBackupPaths({
      backupRoot: this.configService.get<string>('BACKUP_ROOT')?.trim(),
      backupDir: this.configService.get<string>('BACKUP_DIR')?.trim(),
      volumeMeta: this.configService.get<string>('BACKUP_VOLUME_META')?.trim(),
      volumeHis: this.configService.get<string>('BACKUP_VOLUME_HIS')?.trim(),
      volumeEmr: this.configService.get<string>('BACKUP_VOLUME_EMR')?.trim(),
      volumeLis: this.configService.get<string>('BACKUP_VOLUME_LIS')?.trim(),
      isDevelopment: isDev,
    });

    const archiveRaw = (
      this.configService.get<string>('BACKUP_ARCHIVE_TARGET') ?? 'none'
    ).toLowerCase();
    const archiveTarget =
      archiveRaw === 'filesystem' || archiveRaw === 's3' ? archiveRaw : 'none';

    const globalIncremental =
      this.configService.get<string>('BACKUP_INCREMENTAL_CRON') ??
      this.configService.get<string>('BACKUP_SCHEDULE_CRON') ??
      DEFAULT_INCREMENTAL_CRON;

    const rawDev = this.configService.get<string>('BACKUP_DEV_ROW_LIMIT');
    const rawDevLimit =
      rawDev === undefined || rawDev === null || rawDev === ''
        ? undefined
        : Number.parseInt(rawDev, 10);

    return {
      backupDir: paths.metaDir,
      volumeDirs: paths.volumeDirs,
      backupRoot: paths.backupRoot,
      chunkSize: BigInt(
        Number.parseInt(
          this.configService.get<string>('BACKUP_CHUNK_SIZE') ?? '1000000',
          10,
        ) || 1_000_000,
      ),
      statementTimeoutMs:
        Number.parseInt(
          this.configService.get<string>('BACKUP_STATEMENT_TIMEOUT_MS') ??
            '21600000',
          10,
        ) || 21_600_000,
      scheduleEnabled: ['1', 'true', 'yes', 'on'].includes(
        (
          this.configService.get<string>('BACKUP_SCHEDULE_ENABLED') ?? ''
        ).toLowerCase(),
      ),
      scheduleCron: globalIncremental,
      incrementalCron: globalIncremental,
      hisIncrementalCron:
        this.configService.get<string>('BACKUP_HIS_INCREMENTAL_CRON') ??
        globalIncremental,
      emrIncrementalCron:
        this.configService.get<string>('BACKUP_EMR_INCREMENTAL_CRON') ??
        globalIncremental,
      lisIncrementalCron:
        this.configService.get<string>('BACKUP_LIS_INCREMENTAL_CRON') ??
        globalIncremental,
      hisFullCron:
        this.configService.get<string>('BACKUP_HIS_FULL_CRON') ?? '30 1 * * 0',
      emrFullCron:
        this.configService.get<string>('BACKUP_EMR_FULL_CRON') ?? '30 2 * * 0',
      lisFullCron:
        this.configService.get<string>('BACKUP_LIS_FULL_CRON') ?? '30 3 * * 0',
      timezone:
        this.configService.get<string>('BACKUP_TIMEZONE') ?? 'Asia/Ho_Chi_Minh',
      historyEnabled: !['0', 'false', 'no', 'off'].includes(
        (
          this.configService.get<string>('BACKUP_HISTORY_ENABLED') ?? 'true'
        ).toLowerCase(),
      ),
      retentionDays:
        Number.parseInt(
          this.configService.get<string>('BACKUP_RETENTION_DAYS') ?? '30',
          10,
        ) || 30,
      freshnessMaxAgeHours:
        Number.parseInt(
          this.configService.get<string>('BACKUP_FRESHNESS_MAX_AGE_HOURS') ??
            '5',
          10,
        ) || 5,
      archiveTarget,
      devRowLimit: applyDevRowLimitPolicy(
        Number.isFinite(rawDevLimit as number) ? rawDevLimit : undefined,
        isDev,
      ),
      compression: this.readCompressionCodecSync(),
      zstdLevel:
        Number.parseInt(
          this.configService.get<string>('BACKUP_ZSTD_LEVEL') ?? '3',
          10,
        ) || 3,
      zstdThreads:
        Number.parseInt(
          this.configService.get<string>('BACKUP_ZSTD_THREADS') ?? '4',
          10,
        ) || 4,
      verifyArchive: !['0', 'false', 'no', 'off'].includes(
        (
          this.configService.get<string>('BACKUP_VERIFY_ARCHIVE') ?? 'true'
        ).toLowerCase(),
      ),
      minFreeBytes:
        (Number.parseInt(
          this.configService.get<string>('BACKUP_MIN_FREE_GB') ?? '50',
          10,
        ) || 50) *
        1024 ** 3,
      hisLogicalCron:
        this.configService.get<string>('BACKUP_HIS_LOGICAL_CRON') ??
        '0 4 * * 0',
      emrLogicalCron:
        this.configService.get<string>('BACKUP_EMR_LOGICAL_CRON') ??
        '0 5 * * 0',
      logicalJobs:
        Number.parseInt(
          this.configService.get<string>('BACKUP_LOGICAL_JOBS') ?? '4',
          10,
        ) || 4,
      logicalExcludeTableData: this.splitCsv(
        this.configService.get<string>('BACKUP_LOGICAL_EXCLUDE_TABLE_DATA') ??
          'adempiere.ad_changelog',
      ),
    };
  }

  async resolvePaths(): Promise<ResolvedBackupPaths> {
    return resolveBackupPaths({
      backupRoot: (await this.read('BACKUP_ROOT'))?.trim(),
      backupDir: (await this.read('BACKUP_DIR'))?.trim(),
      volumeMeta: (await this.read('BACKUP_VOLUME_META'))?.trim(),
      volumeHis: (await this.read('BACKUP_VOLUME_HIS'))?.trim(),
      volumeEmr: (await this.read('BACKUP_VOLUME_EMR'))?.trim(),
      volumeLis: (await this.read('BACKUP_VOLUME_LIS'))?.trim(),
      isDevelopment: isDevelopmentNodeEnv(),
    });
  }

  /**
   * Builds incremental cron buckets for HIS/EMR databases listed in settings.
   * Does not require backup volumes (safe at scheduler boot).
   */
  async getIncrementalCronBuckets(
    databases: ScheduledDatabase[],
  ): Promise<IncrementalCronBucket[]> {
    const globalIncremental =
      (await this.read('BACKUP_INCREMENTAL_CRON')) ??
      (await this.read('BACKUP_SCHEDULE_CRON')) ??
      DEFAULT_INCREMENTAL_CRON;
    const hisGroupCron =
      (await this.read('BACKUP_HIS_INCREMENTAL_CRON')) ?? globalIncremental;
    const emrGroupCron =
      (await this.read('BACKUP_EMR_INCREMENTAL_CRON')) ?? globalIncremental;
    const lisGroupCron =
      (await this.read('BACKUP_LIS_INCREMENTAL_CRON')) ?? globalIncremental;

    const perDatabase: Record<string, string> = {};

    for (const entry of databases) {
      const raw = await this.read(incrementalCronSettingKey(entry.database));

      if (raw?.trim()) {
        perDatabase[entry.database] = raw.trim();
      }
    }

    const sources: IncrementalCronSources = {
      globalCron: globalIncremental,
      hisGroupCron,
      emrGroupCron,
      lisGroupCron,
      perDatabase,
    };

    return groupDatabasesByIncrementalCron(databases, sources);
  }

  /** Databases configured under HIS_DATABASES / EMR_DATABASES / LIS_DATABASES. */
  async listConfiguredScheduleDatabases(): Promise<ScheduledDatabase[]> {
    const result: ScheduledDatabase[] = [];

    for (const group of ['HIS', 'EMR', 'LIS'] as const) {
      const databases = this.splitCsv(await this.read(`${group}_DATABASES`));

      for (const database of databases) {
        result.push({ group, database });
      }
    }

    return result;
  }

  async getBackupConfig(
    sources: SourceConfig[],
    mode: BackupMode = 'incremental',
  ): Promise<BackupConfig> {
    const settings = await this.getSettings();

    return {
      backupDir: settings.backupDir,
      volumeDirs: settings.volumeDirs,
      sources,
      chunkSize: settings.chunkSize,
      statementTimeoutMs: settings.statementTimeoutMs,
      mode,
      devRowLimit: settings.devRowLimit,
      compression: settings.compression,
      zstdLevel: settings.zstdLevel,
      zstdThreads: settings.zstdThreads,
      verifyArchive: settings.verifyArchive,
      minFreeBytes: settings.minFreeBytes,
      logicalJobs: settings.logicalJobs,
      logicalExcludeTableData: settings.logicalExcludeTableData,
    };
  }

  async loadSource(
    group: SourceGroup,
    prefix: string,
    options?: {
      defaultReachability?: SourceConfig['reachability'];
      reason?: string;
      defaultPort?: number;
    },
  ): Promise<SourceConfig | null> {
    const host = (await this.read(`${prefix}_HOST`))?.trim();

    if (!host) {
      return null;
    }

    const databases = this.splitCsv(await this.read(`${prefix}_DATABASES`));

    if (databases.length === 0) {
      return null;
    }

    const user = await this.read(`${prefix}_USER`);
    const password = await this.read(`${prefix}_PASSWORD`);

    if (!user || password === undefined || password === null) {
      return {
        group,
        host,
        port: await this.optionalInt(
          `${prefix}_PORT`,
          options?.defaultPort ?? 5432,
        ),
        user: user ?? '',
        password: password ?? '',
        databases,
        reachability: 'unconfigured',
        reason: `Missing ${prefix}_USER or ${prefix}_PASSWORD`,
      };
    }

    return {
      group,
      host,
      port: await this.optionalInt(
        `${prefix}_PORT`,
        options?.defaultPort ?? 5432,
      ),
      user,
      password,
      databases,
      reachability: options?.defaultReachability ?? 'ready',
      reason: options?.reason,
    };
  }

  /** Public read for wallboard / schedule helpers (non-secret keys). */
  async getSettingValue(name: string): Promise<string | undefined> {
    return this.read(name);
  }

  async getFullBackupCronExpressions(): Promise<string[]> {
    const keys = [
      'BACKUP_HIS_FULL_CRON',
      'BACKUP_EMR_FULL_CRON',
      'BACKUP_LIS_FULL_CRON',
    ] as const;
    const values: string[] = [];

    for (const key of keys) {
      const raw = await this.read(key);

      if (raw?.trim()) {
        values.push(raw.trim());
      }
    }

    return values;
  }

  private async read(name: string): Promise<string | undefined> {
    if (this.settingsService) {
      return this.settingsService.get(name);
    }

    const fromEnv = this.configService.get<string>(name);

    return fromEnv === undefined || fromEnv === '' ? undefined : fromEnv;
  }

  private splitCsv(value: string | undefined): string[] {
    if (!value) {
      return [];
    }

    return value
      .split(',')
      .map((part) => part.trim())
      .filter(Boolean);
  }

  private async optionalInt(name: string, fallback: number): Promise<number> {
    const raw = await this.read(name);

    if (!raw) {
      return fallback;
    }

    const n = Number.parseInt(raw, 10);

    if (!Number.isFinite(n) || n < 0) {
      throw new Error(`Setting ${name} must be a non-negative integer`);
    }

    return n;
  }

  /** Like optionalInt but returns undefined when unset (for policy defaults). */
  private async readOptionalInt(name: string): Promise<number | undefined> {
    const raw = await this.read(name);

    if (raw === undefined || raw === null || raw === '') {
      return undefined;
    }

    const n = Number.parseInt(raw, 10);

    if (!Number.isFinite(n) || n < 0) {
      throw new Error(`Setting ${name} must be a non-negative integer`);
    }

    return n;
  }

  private async truthy(name: string, defaultValue = false): Promise<boolean> {
    const raw = await this.read(name);

    if (raw === undefined || raw === null || raw === '') {
      return defaultValue;
    }

    return ['1', 'true', 'yes', 'on'].includes(raw.toLowerCase());
  }

  private async readCompressionCodec(): Promise<'zstd' | 'gzip'> {
    const raw = (
      (await this.read('BACKUP_COMPRESSION')) ?? 'zstd'
    ).toLowerCase();

    return raw === 'gzip' ? 'gzip' : 'zstd';
  }

  private readCompressionCodecSync(): 'zstd' | 'gzip' {
    const raw = (
      this.configService.get<string>('BACKUP_COMPRESSION') ?? 'zstd'
    ).toLowerCase();

    return raw === 'gzip' ? 'gzip' : 'zstd';
  }
}
