import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';

import { SettingsModule } from '../settings/settings.module';
import { BackupController } from './backup.controller';
import { BackupScheduler } from './backup.scheduler';
import { BackupConfigController } from './backup-config.controller';
import { BackupCoreModule } from './backup-core.module';
import { BackupRunsStreamController } from './backup-runs-stream.controller';
import { BackupStreamController } from './backup-stream.controller';
import { BackupProgressBridge } from './progress/backup-progress.bridge';
import { PublicBackupController } from './public-backup.controller';
import { PublicBackupStreamController } from './public-backup-stream.controller';
import { BackupScheduleModule } from './schedule/backup-schedule.module';

/**
 * API process: REST, SSE, cron. Does not register BullMQ processors.
 */
@Module({
  imports: [
    ScheduleModule.forRoot(),
    BackupScheduleModule,
    SettingsModule,
    BackupCoreModule,
  ],
  controllers: [
    BackupController,
    BackupConfigController,
    BackupRunsStreamController,
    BackupStreamController,
    PublicBackupController,
    PublicBackupStreamController,
  ],
  providers: [BackupScheduler, BackupProgressBridge],
  exports: [BackupCoreModule, BackupScheduler, BackupScheduleModule],
})
export class BackupApiModule {}
