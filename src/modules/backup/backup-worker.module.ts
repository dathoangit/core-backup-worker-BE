import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';

import { BackupService } from './backup.service';
import { BackupConfigService } from './backup-config.service';
import { BackupRunnerService } from './engine/backup-runner.service';
import { BackupCancelRegistry } from './queue/backup-cancel.registry';
import { SourceRegistry } from './source-registry';
import { ARCHIVE_TARGET } from './zones/archive-target.interface';
import { NoopArchiveTarget } from './zones/noop-archive-target';
import { PrimaryZoneService } from './zones/primary-zone.service';
import { RestorePlanService } from './zones/restore-plan.service';
import { RetentionService } from './zones/retention.service';

/**
 * Lightweight context for `yarn backup:run` — no HTTP, Redis, or TypeORM.
 * History persistence is skipped when repositories are absent.
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
  ],
  providers: [
    BackupConfigService,
    SourceRegistry,
    BackupCancelRegistry,
    BackupRunnerService,
    PrimaryZoneService,
    RetentionService,
    RestorePlanService,
    BackupService,
    NoopArchiveTarget,
    {
      provide: ARCHIVE_TARGET,
      useExisting: NoopArchiveTarget,
    },
  ],
})
export class BackupWorkerModule {}
