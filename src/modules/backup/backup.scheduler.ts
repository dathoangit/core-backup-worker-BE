import {
  BadRequestException,
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { SchedulerRegistry } from '@nestjs/schedule';
import { CronJob } from 'cron';

import { BackupService } from './backup.service';
import { BackupConfigService } from './backup-config.service';
import { type IncrementalCronBucket } from './incremental-schedule';
import { BackupScheduleReloadBus } from './schedule/backup-schedule-reload.bus';
import { type BackupRunOptions, type SourceGroup } from './types';

/**
 * Cron jobs are registered at boot and hot-reloaded via ScheduleRegistry
 * when cron/timezone settings change. Enable/disable is gated at fire time
 * via BACKUP_SCHEDULE_ENABLED.
 */
@Injectable()
export class BackupScheduler implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(BackupScheduler.name);

  private readonly jobNames: string[] = [];

  private reloading = false;

  constructor(
    private readonly backupConfig: BackupConfigService,
    private readonly backupService: BackupService,
    private readonly schedulerRegistry: SchedulerRegistry,
    private readonly reloadBus: BackupScheduleReloadBus,
  ) {}

  async onModuleInit(): Promise<void> {
    this.reloadBus.register(async () => {
      await this.reload();
    });
    await this.registerAll();
  }

  onModuleDestroy(): void {
    this.reloadBus.unregister();
    this.clearAllJobs();
  }

  /**
   * Unregister all cron jobs and register again from current settings.
   * Validates cron expressions first; on failure keeps the previous schedule.
   */
  async reload(): Promise<{ jobCount: number; timezone: string }> {
    if (this.reloading) {
      throw new BadRequestException('Schedule reload already in progress');
    }

    this.reloading = true;

    try {
      const settings = await this.backupConfig.getSettings();
      this.assertCron(settings.hisFullCron, 'BACKUP_HIS_FULL_CRON');
      this.assertCron(settings.emrFullCron, 'BACKUP_EMR_FULL_CRON');
      this.assertCron(settings.lisFullCron, 'BACKUP_LIS_FULL_CRON');
      this.assertCron(settings.hisLogicalCron, 'BACKUP_HIS_LOGICAL_CRON');
      this.assertCron(settings.emrLogicalCron, 'BACKUP_EMR_LOGICAL_CRON');
      this.assertTimezone(settings.timezone);

      const databases =
        await this.backupConfig.listConfiguredScheduleDatabases();
      const buckets =
        await this.backupConfig.getIncrementalCronBuckets(databases);

      for (const bucket of buckets) {
        this.assertCron(bucket.cron, 'incremental-bucket');
      }

      this.clearAllJobs();
      await this.registerAll();

      return {
        jobCount: this.jobNames.length,
        timezone: settings.timezone,
      };
    } finally {
      this.reloading = false;
    }
  }

  private async registerAll(): Promise<void> {
    try {
      const settings = await this.backupConfig.getSettings();
      await this.registerIncrementalJobs(settings.timezone);
      this.registerFullJob(
        'his-weekly-full',
        'HIS weekly full',
        settings.hisFullCron,
        settings.timezone,
        ['HIS'],
      );
      this.registerFullJob(
        'emr-weekly-full',
        'EMR weekly full',
        settings.emrFullCron,
        settings.timezone,
        ['EMR'],
      );
      this.registerFullJob(
        'lis-weekly-full',
        'LIS weekly full',
        settings.lisFullCron,
        settings.timezone,
        ['LIS'],
      );
      this.registerLogicalJob(
        'his-weekly-logical',
        'HIS weekly logical',
        settings.hisLogicalCron,
        settings.timezone,
        ['HIS'],
      );
      this.registerLogicalJob(
        'emr-weekly-logical',
        'EMR weekly logical',
        settings.emrLogicalCron,
        settings.timezone,
        ['EMR'],
      );
      this.logger.log(
        `Backup cron jobs registered (count=${this.jobNames.length}, timezone=${settings.timezone}). ` +
          `Runs only when BACKUP_SCHEDULE_ENABLED is true (current=${settings.scheduleEnabled}).`,
      );
    } catch (error) {
      this.logger.error(
        `Failed to register backup cron jobs: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  private clearAllJobs(): void {
    for (const name of this.jobNames) {
      try {
        this.schedulerRegistry.deleteCronJob(name);
      } catch {
        // already removed
      }
    }

    this.jobNames.length = 0;
  }

  private async registerIncrementalJobs(timezone: string): Promise<void> {
    const databases = await this.backupConfig.listConfiguredScheduleDatabases();

    if (databases.length === 0) {
      this.logger.warn(
        'No HIS/EMR/LIS databases configured; skipping incremental cron registration',
      );

      return;
    }

    const buckets =
      await this.backupConfig.getIncrementalCronBuckets(databases);

    for (const [index, bucket] of buckets.entries()) {
      this.addIncrementalBucketJob(bucket, index, timezone);
    }

    this.logger.log(
      `Registered ${buckets.length} incremental cron job(s) for ${databases.length} database(s)`,
    );
  }

  private addIncrementalBucketJob(
    bucket: IncrementalCronBucket,
    index: number,
    timezone: string,
  ): void {
    const dbNames = bucket.databases.map((d) => d.database);
    const name = `incremental-bucket-${index}-${dbNames.join('-')}`.slice(
      0,
      120,
    );
    const label = `incremental [${dbNames.join(', ')}] cron=${bucket.cron}`;

    this.startCronJob(
      name,
      bucket.cron,
      timezone,
      () => {
        void this.runJob(label, {
          trigger: 'cron',
          mode: 'incremental',
          sourceGroups: [...new Set(bucket.databases.map((d) => d.group))],
          databases: dbNames,
        });
      },
      label,
    );
  }

  private registerFullJob(
    name: string,
    label: string,
    cron: string,
    timezone: string,
    sourceGroups: SourceGroup[],
  ): void {
    this.startCronJob(
      name,
      cron,
      timezone,
      () => {
        void this.runJob(label, {
          trigger: 'cron',
          mode: 'full',
          sourceGroups,
        });
      },
      `${label} cron=${cron}`,
    );
  }

  private registerLogicalJob(
    name: string,
    label: string,
    cron: string,
    timezone: string,
    sourceGroups: SourceGroup[],
  ): void {
    this.startCronJob(
      name,
      cron,
      timezone,
      () => {
        void this.runJob(label, {
          trigger: 'cron',
          mode: 'logical',
          sourceGroups,
        });
      },
      `${label} cron=${cron}`,
    );
  }

  private startCronJob(
    name: string,
    cron: string,
    timezone: string,
    onTick: () => void,
    logLabel: string,
  ): void {
    const job = new CronJob(cron, onTick, null, false, timezone);
    this.schedulerRegistry.addCronJob(name, job);
    job.start();
    this.jobNames.push(name);
    this.logger.log(`Scheduled ${logLabel}`);
  }

  private async runJob(
    label: string,
    options: BackupRunOptions,
  ): Promise<void> {
    try {
      if (!(await this.backupConfig.getSettings()).scheduleEnabled) {
        this.logger.debug(
          `scheduler skipped (${label}): BACKUP_SCHEDULE_ENABLED is false`,
        );

        return;
      }
    } catch (error) {
      this.logger.warn(
        `scheduler skipped (${label}): ${
          error instanceof Error ? error.message : String(error)
        }`,
      );

      return;
    }

    this.logger.log(`scheduled backup enqueue: ${label}`);

    try {
      const result = await this.backupService.triggerRun(options);
      this.logger.log(
        `scheduled backup queued ${result.runId} (${label}) mode=${result.mode}`,
      );
    } catch (error) {
      this.logger.error(
        `scheduled backup enqueue failed (${label}): ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  private assertCron(expr: string, label: string): void {
    try {
      // eslint-disable-next-line no-new
      new CronJob(expr, () => {}, null, false, 'UTC');
    } catch {
      throw new BadRequestException(
        `Invalid cron expression (${label}): ${expr}`,
      );
    }
  }

  private assertTimezone(timezone: string): void {
    try {
      Intl.DateTimeFormat(undefined, { timeZone: timezone });
    } catch {
      throw new BadRequestException(`Invalid timezone: ${timezone}`);
    }
  }
}
