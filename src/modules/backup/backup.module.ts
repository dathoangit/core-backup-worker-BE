import { Module, forwardRef } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { TypeOrmModule } from '@nestjs/typeorm';

import { SettingsModule } from '../settings/settings.module';
import { BackupConfigService } from './backup-config.service';
import { BackupController } from './backup.controller';
import { BackupScheduler } from './backup.scheduler';
import { BackupService } from './backup.service';
import { PublicBackupController } from './public-backup.controller';
import { BackupRunnerService } from './engine/backup-runner.service';
import { BackupDatabaseRunEntity } from './entities/backup-database-run.entity';
import { BackupRunEntity } from './entities/backup-run.entity';
import { SourceRegistry } from './source-registry';
import { ARCHIVE_TARGET } from './zones/archive-target.interface';
import { NoopArchiveTarget } from './zones/noop-archive-target';
import { PrimaryZoneService } from './zones/primary-zone.service';
import { RestorePlanService } from './zones/restore-plan.service';
import { RetentionService } from './zones/retention.service';

@Module({
  imports: [
    ConfigModule,
    ScheduleModule.forRoot(),
    forwardRef(() => SettingsModule),
    TypeOrmModule.forFeature([BackupRunEntity, BackupDatabaseRunEntity]),
  ],
  controllers: [BackupController, PublicBackupController],
  providers: [
    BackupConfigService,
    SourceRegistry,
    BackupRunnerService,
    PrimaryZoneService,
    RetentionService,
    RestorePlanService,
    BackupService,
    BackupScheduler,
    NoopArchiveTarget,
    {
      provide: ARCHIVE_TARGET,
      useExisting: NoopArchiveTarget,
    },
  ],
  exports: [BackupService, BackupConfigService, PrimaryZoneService],
})
export class BackupModule {}
