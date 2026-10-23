import { EventEmitter } from 'node:events';

import {
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';

import { type BackupProgressMessage } from '../progress/backup-progress.types';
import {
  BACKUP_CANCEL_CHANNEL,
  BACKUP_CANCEL_TTL_SECONDS,
  BACKUP_PROGRESS_CHANNEL_PREFIX,
  BACKUP_PROGRESS_TTL_SECONDS,
  backupCancelKey,
  backupProgressChannel,
  backupProgressLastKey,
} from './backup-redis.constants';

/**
 * Dedicated Redis connection on REDIS_BULL_DB for cancel + progress PubSub.
 * Shared fan-out so SSE clients do not each open a Redis subscription.
 */
@Injectable()
export class BackupRedisService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(BackupRedisService.name);

  private publisher: Redis | null = null;

  private subscriber: Redis | null = null;

  private readonly local = new EventEmitter();

  private progressPatternSubscribed = false;

  constructor(private readonly configService: ConfigService) {
    this.local.setMaxListeners(100);
  }

  async onModuleInit(): Promise<void> {
    try {
      this.publisher = this.createClient('publisher');
      this.subscriber = this.createClient('subscriber');
      await Promise.all([this.publisher.connect(), this.subscriber.connect()]);
      await this.ensureProgressPattern();
      await this.subscriber.subscribe(BACKUP_CANCEL_CHANNEL);
      this.subscriber.on('message', (channel, message) => {
        if (channel === BACKUP_CANCEL_CHANNEL) {
          this.local.emit('cancel', message);
        }
      });
      this.subscriber.on('pmessage', (_pattern, channel, message) => {
        if (channel.startsWith(BACKUP_PROGRESS_CHANNEL_PREFIX)) {
          const runId = channel.slice(BACKUP_PROGRESS_CHANNEL_PREFIX.length);
          this.local.emit(`progress:${runId}`, message);

          try {
            this.local.emit(
              'progress-any',
              JSON.parse(message) as BackupProgressMessage,
            );
          } catch {
            // ignore malformed
          }
        }
      });
      this.logger.log('Backup Redis PubSub ready');
    } catch (error) {
      this.logger.error(
        `Backup Redis init failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  async onModuleDestroy(): Promise<void> {
    await Promise.allSettled([this.publisher?.quit(), this.subscriber?.quit()]);
    this.publisher = null;
    this.subscriber = null;
  }

  onCancel(handler: (runId: string) => void): () => void {
    const wrapped = (runId: string) => handler(runId);
    this.local.on('cancel', wrapped);

    return () => {
      this.local.off('cancel', wrapped);
    };
  }

  onProgress(
    runId: string,
    handler: (message: BackupProgressMessage) => void,
  ): () => void {
    const event = `progress:${runId}`;

    const wrapped = (raw: string) => {
      try {
        handler(JSON.parse(raw) as BackupProgressMessage);
      } catch {
        // ignore malformed
      }
    };

    this.local.on(event, wrapped);

    return () => {
      this.local.off(event, wrapped);
    };
  }

  /** Fan-out every progress message (all runIds) for API SSE bridge. */
  onAnyProgress(handler: (message: BackupProgressMessage) => void): () => void {
    const wrapped = (message: BackupProgressMessage) => handler(message);
    this.local.on('progress-any', wrapped);

    return () => {
      this.local.off('progress-any', wrapped);
    };
  }

  async publishCancel(runId: string): Promise<void> {
    if (!this.publisher) {
      return;
    }

    await this.publisher.set(
      backupCancelKey(runId),
      '1',
      'EX',
      BACKUP_CANCEL_TTL_SECONDS,
    );
    await this.publisher.publish(BACKUP_CANCEL_CHANNEL, runId);
  }

  async isCancelFlagSet(runId: string): Promise<boolean> {
    if (!this.publisher) {
      return false;
    }

    const value = await this.publisher.get(backupCancelKey(runId));

    return value === '1';
  }

  async clearCancelFlag(runId: string): Promise<void> {
    if (!this.publisher) {
      return;
    }

    await this.publisher.del(backupCancelKey(runId));
  }

  async publishProgress(message: BackupProgressMessage): Promise<void> {
    if (!this.publisher) {
      return;
    }

    const payload = JSON.stringify(message);
    await this.publisher.set(
      backupProgressLastKey(message.runId),
      payload,
      'EX',
      BACKUP_PROGRESS_TTL_SECONDS,
    );
    await this.publisher.publish(backupProgressChannel(message.runId), payload);
  }

  async getLastProgress(runId: string): Promise<BackupProgressMessage | null> {
    if (!this.publisher) {
      return null;
    }

    const raw = await this.publisher.get(backupProgressLastKey(runId));

    if (!raw) {
      return null;
    }

    try {
      return JSON.parse(raw) as BackupProgressMessage;
    } catch {
      return null;
    }
  }

  private async ensureProgressPattern(): Promise<void> {
    if (!this.subscriber || this.progressPatternSubscribed) {
      return;
    }

    await this.subscriber.psubscribe(`${BACKUP_PROGRESS_CHANNEL_PREFIX}*`);
    this.progressPatternSubscribed = true;
  }

  private createClient(label: string): Redis {
    const host = this.configService.get<string>('REDIS_HOST') ?? 'localhost';
    const port = Number(this.configService.get<string>('REDIS_PORT') ?? 6379);
    const password =
      this.configService.get<string>('REDIS_PASSWORD') || undefined;
    const db = Number(this.configService.get<string>('REDIS_BULL_DB') ?? 1);

    const client = new Redis({
      host,
      port,
      password,
      db,
      lazyConnect: true,
      maxRetriesPerRequest: null,
      enableOfflineQueue: true,
    });

    client.on('error', (error) => {
      this.logger.error(`Backup Redis (${label}): ${error.message}`);
    });

    return client;
  }
}
