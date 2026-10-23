import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  HealthCheckError,
  HealthIndicator,
  type HealthIndicatorResult,
} from '@nestjs/terminus';

import { BackupService } from '../../backup/backup.service';

@Injectable()
export class BackupFreshnessIndicator extends HealthIndicator {
  constructor(
    private readonly backupService: BackupService,
    private readonly configService: ConfigService,
  ) {
    super();
  }

  async isHealthy(key: string): Promise<HealthIndicatorResult> {
    const backupDir = this.configService.get<string>('BACKUP_DIR')?.trim();

    if (!backupDir) {
      // Also try DB-backed setting via freshness itself; if BACKUP_DIR unset in env,
      // getFreshness may still succeed when settings were seeded.
      try {
        const freshness = await this.backupService.getFreshness();

        if (freshness.lastSuccessAt || freshness.healthy) {
          const result = this.getStatus(key, freshness.healthy, {
            lastSuccessAt: freshness.lastSuccessAt,
            ageHours: freshness.ageHours,
            maxAgeHours: freshness.maxAgeHours,
          });

          if (freshness.healthy) {
            return result;
          }

          throw new HealthCheckError('Backup freshness check failed', result);
        }
      } catch (error) {
        if (error instanceof HealthCheckError) {
          throw error;
        }
      }

      return this.getStatus(key, true, {
        skipped: true,
        reason: 'BACKUP_DIR not set',
      });
    }

    try {
      const freshness = await this.backupService.getFreshness();
      const result = this.getStatus(key, freshness.healthy, {
        lastSuccessAt: freshness.lastSuccessAt,
        ageHours: freshness.ageHours,
        maxAgeHours: freshness.maxAgeHours,
      });

      if (freshness.healthy) {
        return result;
      }

      throw new HealthCheckError('Backup freshness check failed', result);
    } catch (error) {
      if (error instanceof HealthCheckError) {
        throw error;
      }

      const result = this.getStatus(key, false, {
        error: error instanceof Error ? error.message : String(error),
      });

      throw new HealthCheckError('Backup freshness check failed', result);
    }
  }
}
