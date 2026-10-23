import { Processor, WorkerHost } from '@nestjs/bullmq';
import { type Job } from 'bullmq';

import { BackupJobRunner } from './backup-job.runner';
import {
  BACKUP_FULL_CONCURRENCY,
  BACKUP_FULL_QUEUE_NAME,
  BACKUP_QUEUE_LOCK_DURATION_MS,
  BACKUP_QUEUE_MAX_STALLED_COUNT,
  BACKUP_QUEUE_STALLED_INTERVAL_MS,
} from './backup-queue.constants';
import { type BackupQueueJobData } from './backup-queue.types';

@Processor(BACKUP_FULL_QUEUE_NAME, {
  concurrency: BACKUP_FULL_CONCURRENCY,
  lockDuration: BACKUP_QUEUE_LOCK_DURATION_MS,
  stalledInterval: BACKUP_QUEUE_STALLED_INTERVAL_MS,
  maxStalledCount: BACKUP_QUEUE_MAX_STALLED_COUNT,
})
export class BackupFullProcessor extends WorkerHost {
  constructor(private readonly jobRunner: BackupJobRunner) {
    super();
  }

  process(job: Job<BackupQueueJobData>): Promise<void> {
    return this.jobRunner.run(job);
  }
}
