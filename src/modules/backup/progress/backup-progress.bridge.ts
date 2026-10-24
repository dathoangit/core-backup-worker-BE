import {
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';

import { BackupEventsService } from '../events/backup-events.service';
import { type BackupRunStatusEvent } from '../events/backup-events.types';
import { BackupRedisService } from '../queue/backup-redis.service';
import { type BackupProgressMessage } from './backup-progress.types';

const STREAM_STATUSES = new Set<BackupRunStatusEvent['status']>([
  'queued',
  'running',
  'cancelling',
  'ok',
  'partial',
  'error',
  'cancelled',
]);

function asStreamStatus(
  status: string | undefined,
): BackupRunStatusEvent['status'] | null {
  if (
    !status ||
    !STREAM_STATUSES.has(status as BackupRunStatusEvent['status'])
  ) {
    return null;
  }

  return status as BackupRunStatusEvent['status'];
}

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
        const dbIndex = message.dbIndex ?? 0;
        const dbCount = Math.max(message.dbCount ?? 1, 1);
        this.backupEvents.emitProgress({
          runId: message.runId,
          database: message.currentDatabase ?? null,
          currentTable: message.currentTable ?? null,
          tablesDone: message.tablesDone ?? 0,
          tablesTotal: message.tablesTotal ?? 0,
          databasesDone: dbIndex,
          databasesTotal: dbCount,
          rowsTotal: message.rowsProcessed ?? 0,
          bytesTotal: message.bytesProcessed ?? 0,
          rowsPerSec: message.rowsPerSec ?? 0,
          bytesPerSec: message.bytesPerSec ?? 0,
          etaSeconds: message.etaSeconds ?? null,
          startedAt: message.startedAt ?? null,
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
        const status = asStreamStatus(message.status);

        if (!status) {
          this.logger.debug(
            `Ignoring unknown progress status for ${message.runId}: ${
              message.status ?? '(missing)'
            }`,
          );

          break;
        }

        this.backupEvents.emitStatus({
          runId: message.runId,
          status,
          at: message.at,
        });

        break;
      }
      // No default
    }
  }
}
