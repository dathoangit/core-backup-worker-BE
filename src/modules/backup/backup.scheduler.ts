import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { SchedulerRegistry } from '@nestjs/schedule';
import { CronJob } from 'cron';

import { BackupConfigService } from './backup-config.service';
import { BackupService } from './backup.service';
import type { IncrementalCronBucket } from './incremental-schedule';
import type { BackupRunOptions, SourceGroup } from './types';

/**
 * Cron jobs are always registered at boot. Enable/disable is gated at fire time
 * via BACKUP_SCHEDULE_ENABLED in app_settings (FE toggle) — no env/restart needed
 * to turn the schedule on or off. Cron expression / timezone changes still need a
 * process restart (or a future reload API).
 */
@Injectable()
export class BackupScheduler implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(BackupScheduler.name);
  private readonly jobNames: string[] = [];

  constructor(
    private readonly backupConfig: BackupConfigService,
    private readonly backupService: BackupService,
    private readonly schedulerRegistry: SchedulerRegistry,
  ) {}

  async onModuleInit(): Promise<void> {
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
      this.logger.log(
        `Backup cron jobs registered (timezone=${settings.timezone}). ` +
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

  onModuleDestroy(): void {
    for (const name of this.jobNames) {
      try {
        this.schedulerRegistry.deleteCronJob(name);
      } catch {
        // already removed
      }
    }
  }

  private async registerIncrementalJobs(timezone: string): Promise<void> {
    const databases =
      await this.backupConfig.listConfiguredScheduleDatabases();
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

    this.logger.log(`scheduled backup starting: ${label}`);
    try {
      const manifest = await this.backupService.runOnceAndWait(options);
      const failed = manifest.databases.filter((d) => d.status === 'error');
      this.logger.log(
        `scheduled backup finished ${manifest.runId} (${label}): ${manifest.databases.length} databases, ${failed.length} errors`,
      );
    } catch (error) {
      this.logger.error(
        `scheduled backup failed (${label}): ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
}
