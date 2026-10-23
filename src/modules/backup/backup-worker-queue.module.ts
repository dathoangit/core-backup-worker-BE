import { Module } from '@nestjs/common';

import { BackupCoreModule } from './backup-core.module';
import { BackupCancelListener } from './queue/backup-cancel.listener';
import { BackupFullProcessor } from './queue/backup-full.processor';
import { BackupIncrementalProcessor } from './queue/backup-incremental.processor';
import { BackupJobRunner } from './queue/backup-job.runner';
import { BackupQueueRecoveryService } from './queue/backup-queue-recovery.service';

/**
 * Worker process: BullMQ consumers, cancel listener, stale recovery.
 */
@Module({
  imports: [BackupCoreModule],
  providers: [
    BackupJobRunner,
    BackupIncrementalProcessor,
    BackupFullProcessor,
    BackupCancelListener,
    BackupQueueRecoveryService,
  ],
})
export class BackupWorkerQueueModule {}
