import './boilerplate.polyfill';

import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { BackupCoreModule } from './modules/backup/backup-core.module';
import { BackupWorkerQueueModule } from './modules/backup/backup-worker-queue.module';
import { SettingsModule } from './modules/settings/settings.module';
import { SnakeNamingStrategy } from './snake-naming.strategy';

/**
 * Worker process: TypeORM + settings + BullMQ consumers. No HTTP.
 */
@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath:
        process.env.NODE_ENV === 'development'
          ? ['.env.development', '.env']
          : ['.env'],
    }),
    TypeOrmModule.forRootAsync({
      imports: [ConfigModule],
      useFactory: (configService: ConfigService) => {
        const dbType = (
          configService.get<string>('DB_TYPE') || 'postgres'
        ).toLowerCase();
        const isMysql = dbType === 'mysql';

        return {
          type: isMysql ? 'mysql' : 'postgres',
          host: configService.get<string>('DB_HOST'),
          port: configService.get<number>('DB_PORT'),
          username: configService.get<string>('DB_USERNAME'),
          password: configService.get<string>('DB_PASSWORD'),
          database: configService.get<string>('DB_DATABASE'),
          ...(isMysql
            ? {
                charset: 'utf8mb4_unicode_ci' as const,
              }
            : {
                extra: {
                  options: '-c timezone=Asia/Ho_Chi_Minh',
                },
              }),
          namingStrategy: new SnakeNamingStrategy(),
          autoLoadEntities: true,
          migrationsRun: false,
          synchronize: false,
          logging: false,
        };
      },
      dataSourceFactory: async (options) => {
        if (!options) {
          throw new Error('TypeORM options are required');
        }
        const dataSource = new DataSource(options);
        await dataSource.initialize();

        return dataSource;
      },
      inject: [ConfigService],
    }),
    SettingsModule,
    BackupCoreModule,
    BackupWorkerQueueModule,
  ],
})
export class WorkerAppModule {}
