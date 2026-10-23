import {
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';

import { BackupEventsService } from '../events/backup-events.service';
import { BackupRedisService } from '../queue/backup-redis.service';
import { type BackupProgressMessage } from './backup-progress.types';

/**
 * API-side: fan Redis PubSub progress into in-process BackupEventsService for SSE.
 */
@Injectable()
export class BackupProgressBridge implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(BackupProgressBridge.name);

  private unsubscribe: (() => void) | null = null;

  constructor(
    private readonly backupRedis: BackupRedisService,
    private readonly backupEvents: BackupEventsService,
  ) {}

  onModuleInit(): void {
    this.unsubscribe = this.backupRedis.onAnyProgress((message) => {
      this.forward(message);
    });
    this.logger.log('Backup progress Redis→SSE bridge ready');
  }

  onModuleDestroy(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  private forward(message: BackupProgressMessage): void {
    switch (message.type) {
      case 'progress': {
        this.backupEvents.emitProgress({
          runId: message.runId,
          database: message.currentDatabase ?? null,
          tablesDone: 0,
          tablesTotal: 0,
          databasesDone: 0,
          databasesTotal: 0,
          rowsTotal: message.rowsProcessed ?? 0,
          bytesTotal: 0,
          percent: message.percent ?? 0,
          at: message.at,
        });

        break;
      }

      case 'log': {
        this.backupEvents.emitLog({
          runId: message.runId,
          level: message.level ?? 'info',
          message: message.line ?? '',
          at: message.at,
        });

        break;
      }

      case 'status': {
        this.backupEvents.emitStatus({
          runId: message.runId,
          status: (message.status as 'running') || 'running',
          at: message.at,
        });

        break;
      }
      // No default
    }
  }
}
