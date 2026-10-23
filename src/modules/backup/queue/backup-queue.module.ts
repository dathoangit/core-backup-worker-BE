import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';

import {
  BACKUP_FULL_QUEUE_NAME,
  BACKUP_INCREMENTAL_QUEUE_NAME,
} from './backup-queue.constants';
import { BackupRedisService } from './backup-redis.service';

/**
 * Shared BullMQ root + incremental/full queue registration.
 */
@Module({
  imports: [
    BullModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => {
        const host = configService.get<string>('REDIS_HOST') ?? 'localhost';
        const port = Number(configService.get<string>('REDIS_PORT') ?? 6379);
        const password =
          configService.get<string>('REDIS_PASSWORD') || undefined;
        const db = Number(configService.get<string>('REDIS_BULL_DB') ?? 1);

        return {
          connection: {
            host,
            port,
            password,
            db,
            maxRetriesPerRequest: null,
          },
        };
      },
    }),
    BullModule.registerQueue(
      { name: BACKUP_INCREMENTAL_QUEUE_NAME },
      { name: BACKUP_FULL_QUEUE_NAME },
    ),
  ],
  providers: [BackupRedisService],
  exports: [BullModule, BackupRedisService],
})
export class BackupQueueModule {}
