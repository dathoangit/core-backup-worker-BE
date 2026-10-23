import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';

import { BackupCoreModule } from '../backup/backup-core.module';
import { CacheModule } from '../cache/cache.module';
import { SettingsModule } from '../settings/settings.module';
import { AlertService } from './alert.service';
import { AlertsController } from './alerts.controller';
import { EmailNotifier } from './email.notifier';
import { TelegramNotifier } from './telegram.notifier';

@Module({
  imports: [
    ScheduleModule.forRoot(),
    SettingsModule,
    BackupCoreModule,
    CacheModule,
  ],
  controllers: [AlertsController],
  providers: [AlertService, TelegramNotifier, EmailNotifier],
  exports: [AlertService],
})
export class AlertsModule {}
