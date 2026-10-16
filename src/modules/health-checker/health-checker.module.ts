import { Module } from '@nestjs/common';
import { TerminusModule } from '@nestjs/terminus';

import { BackupModule } from '../backup/backup.module';
import { HealthCheckerController } from './health-checker.controller';
import { BackupFreshnessIndicator } from './health-indicators/backup-freshness.indicator';
import { ServiceHealthIndicator } from './health-indicators/service.indicator';

@Module({
  imports: [TerminusModule, BackupModule],
  controllers: [HealthCheckerController],
  providers: [ServiceHealthIndicator, BackupFreshnessIndicator],
})
export class HealthCheckerModule {}
