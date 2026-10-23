import './boilerplate.polyfill';

import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { HttpExceptionFilter } from './filters/bad-request.filter';
import { QueryFailedFilter } from './filters/query-failed.filter';
import { ResponseInterceptor } from './interceptors/responseInterceptor.service';
import { AlertsModule } from './modules/alerts/alerts.module';
import { AuthModule } from './modules/auth/auth.module';
import { BackupApiModule } from './modules/backup/backup-api.module';
import { HealthCheckerModule } from './modules/health-checker/health-checker.module';
import { SettingsModule } from './modules/settings/settings.module';
import { UserModule } from './modules/user/user.module';
import { SnakeNamingStrategy } from './snake-naming.strategy';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      // First file wins for a given key (@nestjs/config).
      envFilePath:
        process.env.NODE_ENV === 'development'
          ? ['.env.development', '.env']
          : ['.env'],
    }),
    ThrottlerModule.forRoot({
      throttlers: [{ ttl: 60_000, limit: 60 }],
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
          migrationsRun:
            configService.get<string>('TYPEORM_MIGRATIONS_RUN') === 'true',
          migrations: ['dist/database/migrations/*.js'],
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
    AuthModule,
    UserModule,
    SettingsModule,
    BackupApiModule,
    AlertsModule,
    HealthCheckerModule,
  ],
  providers: [
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_INTERCEPTOR, useClass: ResponseInterceptor },
    { provide: APP_FILTER, useClass: QueryFailedFilter },
    { provide: APP_FILTER, useClass: HttpExceptionFilter },
  ],
})
export class AppModule {}
