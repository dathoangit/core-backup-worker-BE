import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { Cron, SchedulerRegistry } from '@nestjs/schedule';
import { CronJob } from 'cron';

import { BackupConfigService } from './backup-config.service';
import { BackupService } from './backup.service';
import type { IncrementalCronBucket } from './incremental-schedule';
import type { BackupRunOptions } from './types';

const TZ = process.env.BACKUP_TIMEZONE ?? 'Asia/Ho_Chi_Minh';
const SCHEDULE_DISABLED = process.env.BACKUP_SCHEDULE_ENABLED !== 'true';

@Injectable()
export class BackupScheduler implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(BackupScheduler.name);
  private readonly incrementalJobNames: string[] = [];

  constructor(
    private readonly backupConfig: BackupConfigService,
    private readonly backupService: BackupService,
    private readonly schedulerRegistry: SchedulerRegistry,
  ) {}

  async onModuleInit(): Promise<void> {
    if (SCHEDULE_DISABLED) {
      this.logger.log(
        'Incremental per-DB cron jobs not registered (BACKUP_SCHEDULE_ENABLED!=true)',
      );

      return;
    }

    try {
      await this.registerIncrementalJobs();
    } catch (error) {
      this.logger.error(
        `Failed to register incremental cron jobs: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  onModuleDestroy(): void {
    for (const name of this.incrementalJobNames) {
      try {
        this.schedulerRegistry.deleteCronJob(name);
      } catch {
        // already removed
      }
    }
  }

  @Cron(process.env.BACKUP_HIS_FULL_CRON ?? '30 1 * * 0', {
    name: 'his-weekly-full',
    timeZone: TZ,
    disabled: SCHEDULE_DISABLED,
  })
  async handleHisFull(): Promise<void> {
    await this.runJob('HIS weekly full', {
      trigger: 'cron',
      mode: 'full',
      sourceGroups: ['HIS'],
    });
  }

  @Cron(process.env.BACKUP_EMR_FULL_CRON ?? '30 2 * * 0', {
    name: 'emr-weekly-full',
    timeZone: TZ,
    disabled: SCHEDULE_DISABLED,
  })
  async handleEmrFull(): Promise<void> {
    await this.runJob('EMR weekly full', {
      trigger: 'cron',
      mode: 'full',
      sourceGroups: ['EMR'],
    });
  }

  @Cron(process.env.BACKUP_LIS_FULL_CRON ?? '30 3 * * 0', {
    name: 'lis-weekly-full',
    timeZone: TZ,
    disabled: SCHEDULE_DISABLED,
  })
  async handleLisFull(): Promise<void> {
    await this.runJob('LIS weekly full', {
      trigger: 'cron',
      mode: 'full',
      sourceGroups: ['LIS'],
    });
  }

  private async registerIncrementalJobs(): Promise<void> {
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
      this.addIncrementalBucketJob(bucket, index);
    }

    this.logger.log(
      `Registered ${buckets.length} incremental cron job(s) for ${databases.length} database(s)`,
    );
  }

  private addIncrementalBucketJob(
    bucket: IncrementalCronBucket,
    index: number,
  ): void {
    const dbNames = bucket.databases.map((d) => d.database);
    const name = `incremental-bucket-${index}-${dbNames.join('-')}`.slice(
      0,
      120,
    );
    const label = `incremental [${dbNames.join(', ')}] cron=${bucket.cron}`;

    const job = new CronJob(
      bucket.cron,
      () => {
        void this.runJob(label, {
          trigger: 'cron',
          mode: 'incremental',
          sourceGroups: [...new Set(bucket.databases.map((d) => d.group))],
          databases: dbNames,
        });
      },
      null,
      false,
      TZ,
    );

    this.schedulerRegistry.addCronJob(name, job);
    job.start();
    this.incrementalJobNames.push(name);
    this.logger.log(`Scheduled ${label}`);
  }

  private async runJob(
    label: string,
    options: BackupRunOptions,
  ): Promise<void> {
    try {
      if (!(await this.backupConfig.getSettings()).scheduleEnabled) {
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
