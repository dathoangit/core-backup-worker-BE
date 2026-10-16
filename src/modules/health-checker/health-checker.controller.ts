import { Controller, Get } from '@nestjs/common';
import {
  HealthCheck,
  type HealthCheckResult,
  HealthCheckService,
} from '@nestjs/terminus';

import { BackupFreshnessIndicator } from './health-indicators/backup-freshness.indicator';
import { ServiceHealthIndicator } from './health-indicators/service.indicator';

@Controller('health')
export class HealthCheckerController {
  constructor(
    private healthCheckService: HealthCheckService,
    private serviceIndicator: ServiceHealthIndicator,
    private backupFreshness: BackupFreshnessIndicator,
  ) {}

  @Get()
  @HealthCheck()
  async check(): Promise<HealthCheckResult> {
    return this.healthCheckService.check([
      () => this.serviceIndicator.isHealthy('search-service-health'),
      () => this.backupFreshness.isHealthy('backup-freshness'),
    ]);
  }
}
