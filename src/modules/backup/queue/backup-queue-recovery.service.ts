import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';

import { BackupQueueService } from './backup-queue.service';

/** Runs only in the worker process — never mark active jobs stale on api restart. */
@Injectable()
export class BackupQueueRecoveryService implements OnModuleInit {
  private readonly logger = new Logger(BackupQueueRecoveryService.name);

  constructor(private readonly queueService: BackupQueueService) {}

  async onModuleInit(): Promise<void> {
    try {
      await this.queueService.recoverStaleState();
    } catch (error) {
      this.logger.warn(
        `Backup queue recovery skipped: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
}
