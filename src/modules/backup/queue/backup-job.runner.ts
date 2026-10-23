import { forwardRef, Inject, Injectable, Logger } from '@nestjs/common';
import { type Job } from 'bullmq';

import { BackupService } from '../backup.service';
import { BackupCancelledError } from '../errors/backup-cancelled.error';
import { BackupProgressPublisher } from '../progress/backup-progress.publisher';
import { BackupCancelRegistry } from './backup-cancel.registry';
import { BackupQueueService } from './backup-queue.service';
import { type BackupQueueJobData } from './backup-queue.types';
import { BackupRedisService } from './backup-redis.service';

@Injectable()
export class BackupJobRunner {
  private readonly logger = new Logger(BackupJobRunner.name);

  constructor(
    @Inject(forwardRef(() => BackupService))
    private readonly backupService: BackupService,
    private readonly cancelRegistry: BackupCancelRegistry,
    private readonly queueService: BackupQueueService,
    private readonly backupRedis: BackupRedisService,
    private readonly progressPublisher: BackupProgressPublisher,
  ) {}

  async run(job: Job<BackupQueueJobData>): Promise<void> {
    const { runId, trigger, mode, sourceGroups, databases } = job.data;
    this.logger.log(
      `Processing backup job ${runId} mode=${mode} trigger=${trigger}`,
    );

    const signal = this.cancelRegistry.begin(runId);

    if (await this.backupRedis.isCancelFlagSet(runId)) {
      await this.cancelRegistry.requestCancel(runId);
    }

    this.progressPublisher.begin(runId);
    await this.progressPublisher.publishStatus(runId, 'running');

    try {
      if (signal.aborted) {
        throw new BackupCancelledError(runId);
      }

      const manifest = await this.backupService.executeQueuedRun(
        {
          trigger,
          mode,
          sourceGroups,
          databases,
        },
        runId,
        signal,
        {
          progress: this.progressPublisher,
          runId,
        },
      );

      const finalStatus = this.resolveStatus(manifest.databases);
      await this.progressPublisher.publishStatus(runId, finalStatus);
    } catch (error) {
      if (
        error instanceof BackupCancelledError ||
        signal.aborted ||
        this.cancelRegistry.isCancelRequested(runId)
      ) {
        await this.queueService.markCancelled(
          runId,
          error instanceof Error ? error.message : 'Cancelled',
        );
        await this.progressPublisher.publishStatus(runId, 'cancelled');
        this.logger.warn(`Backup job ${runId} cancelled`);

        return;
      }

      await this.progressPublisher.publishStatus(runId, 'error');
      this.logger.error(
        `Backup job ${runId} failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );

      throw error;
    } finally {
      this.cancelRegistry.clear(runId);
      this.progressPublisher.end(runId);
      await this.backupRedis.clearCancelFlag(runId);
    }
  }

  private resolveStatus(databases: Array<{ status: string }>): string {
    if (databases.length === 0) {
      return 'ok';
    }

    const ok = databases.filter((d) => d.status === 'ok').length;
    const err = databases.filter((d) => d.status === 'error').length;

    if (ok > 0 && err > 0) {
      return 'partial';
    }

    if (ok === 0 && err > 0) {
      return 'error';
    }

    return 'ok';
  }
}
