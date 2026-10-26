import { forwardRef, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';

import { SettingsModule } from '../settings/settings.module';
import { BackupService } from './backup.service';
import { BackupConfigService } from './backup-config.service';
import { BackupRunnerService } from './engine/backup-runner.service';
import { CompressionShutdownService } from './engine/compression-shutdown.service';
import { BackupDatabaseRunEntity } from './entities/backup-database-run.entity';
import { BackupRunEntity } from './entities/backup-run.entity';
import { BackupEventsService } from './events/backup-events.service';
import { BackupFilesService } from './files/backup-files.service';
import { BackupProgressPublisher } from './progress/backup-progress.publisher';
import { BackupCancelRegistry } from './queue/backup-cancel.registry';
import { BackupQueueModule } from './queue/backup-queue.module';
import { BackupQueueService } from './queue/backup-queue.service';
import { SourceRegistry } from './source-registry';
import { ARCHIVE_TARGET } from './zones/archive-target.interface';
import { NoopArchiveTarget } from './zones/noop-archive-target';
import { PrimaryZoneService } from './zones/primary-zone.service';
import { RestorePlanService } from './zones/restore-plan.service';
import { RetentionService } from './zones/retention.service';

/**
 * Shared backup engine + queue producers. Used by both API and worker processes.
 */
@Module({
  imports: [
    ConfigModule,
    forwardRef(() => SettingsModule),
    BackupQueueModule,
    TypeOrmModule.forFeature([BackupRunEntity, BackupDatabaseRunEntity]),
  ],
  providers: [
    BackupConfigService,
    SourceRegistry,
    BackupCancelRegistry,
    BackupRunnerService,
    PrimaryZoneService,
    RetentionService,
    CompressionShutdownService,
    RestorePlanService,
    BackupEventsService,
    BackupProgressPublisher,
    BackupFilesService,
    BackupService,
    BackupQueueService,
    NoopArchiveTarget,
    {
      provide: ARCHIVE_TARGET,
      useExisting: NoopArchiveTarget,
    },
  ],
  exports: [
    BackupQueueModule,
    BackupConfigService,
    SourceRegistry,
    BackupCancelRegistry,
    BackupRunnerService,
    PrimaryZoneService,
    RetentionService,
    CompressionShutdownService,
    RestorePlanService,
    BackupEventsService,
    BackupProgressPublisher,
    BackupFilesService,
    BackupService,
    BackupQueueService,
    ARCHIVE_TARGET,
  ],
})
export class BackupCoreModule {}
