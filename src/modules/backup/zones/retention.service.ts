import fs from 'node:fs';
import path from 'node:path';

import { Injectable, Logger } from '@nestjs/common';

import { BackupConfigService } from '../backup-config.service';
import { volumeRoots } from '../backup-paths';
import { PrimaryZoneService } from './primary-zone.service';

@Injectable()
export class RetentionService {
  private readonly logger = new Logger(RetentionService.name);

  constructor(
    private readonly backupConfig: BackupConfigService,
    private readonly primaryZone: PrimaryZoneService,
  ) {}

  async applyRetention(options?: {
    inFlightRunId?: string | null;
  }): Promise<{ deleted: string[]; skipped: string }> {
    const settings = await this.backupConfig.getSettings();
    if (settings.retentionDays <= 0) {
      return {
        deleted: [],
        skipped: 'retention disabled (BACKUP_RETENTION_DAYS=0)',
      };
    }

    const cutoff = Date.now() - settings.retentionDays * 24 * 60 * 60 * 1000;
    const runIds = await this.primaryZone.listRunIds();
    const newestBaseline = await this.findNewestBaselineRunId(runIds);
    const protectedFrom = newestBaseline
      ? runIds.indexOf(newestBaseline)
      : runIds.length;
    const deleted: string[] = [];

    const volumeRootsForRun = [
      settings.backupDir,
      ...volumeRoots(settings.volumeDirs),
    ];

    for (let i = 0; i < runIds.length; i++) {
      const runId = runIds[i];
      if (options?.inFlightRunId && runId === options.inFlightRunId) {
        continue;
      }

      if (i >= protectedFrom) {
        continue;
      }

      if (runId === newestBaseline) {
        continue;
      }

      const mtime = this.newestRunMtime(volumeRootsForRun, runId);
      if (mtime === 0 || mtime >= cutoff) {
        continue;
      }

      this.deleteRunEverywhere(volumeRootsForRun, runId);
      deleted.push(runId);
      this.logger.warn(`retention deleted run ${runId}`);
    }

    return { deleted, skipped: '' };
  }

  private async findNewestBaselineRunId(
    runIds: string[],
  ): Promise<string | null> {
    const settings = await this.backupConfig.getSettings();
    const volumeRootsForBaseline = volumeRoots(settings.volumeDirs);

    for (let i = runIds.length - 1; i >= 0; i--) {
      const runId = runIds[i];
      for (const root of volumeRootsForBaseline) {
        if (this.hasFullDump(path.join(root, 'runs', runId))) {
          return runId;
        }
      }
    }

    return null;
  }

  private newestRunMtime(volumeRoots: string[], runId: string): number {
    let newest = 0;
    for (const root of volumeRoots) {
      const runDir = path.join(root, 'runs', runId);
      try {
        const mtime = fs.statSync(runDir).mtimeMs;
        if (mtime > newest) {
          newest = mtime;
        }
      } catch {
        // missing on this volume
      }
    }

    return newest;
  }

  private deleteRunEverywhere(volumeRoots: string[], runId: string): void {
    for (const root of volumeRoots) {
      const runDir = path.join(root, 'runs', runId);
      if (fs.existsSync(runDir)) {
        fs.rmSync(runDir, { recursive: true, force: true });
      }
    }
  }

  private hasFullDump(runDir: string): boolean {
    if (!fs.existsSync(runDir)) {
      return false;
    }

    for (const entry of fs.readdirSync(runDir)) {
      if (entry === 'manifest.json') {
        continue;
      }

      const fullPath = path.join(runDir, entry, 'full');
      if (fs.existsSync(fullPath)) {
        try {
          if (fs.readdirSync(fullPath).length > 0) {
            return true;
          }
        } catch {
          // ignore
        }
      }
    }

    return false;
  }
}
