import fs from 'node:fs';
import path from 'node:path';

import { Injectable, NotFoundException } from '@nestjs/common';

import type { RunManifest } from '../types';
import { PrimaryZoneService } from './primary-zone.service';

export interface RestorePlanStep {
  order: number;
  kind: 'full' | 'append' | 'cdc' | 'snapshot';
  runId: string;
  relativePath: string;
  absolutePath: string;
}

export interface RestorePlan {
  database: string;
  steps: RestorePlanStep[];
  notes: string[];
}

@Injectable()
export class RestorePlanService {
  constructor(private readonly primaryZone: PrimaryZoneService) {}

  async buildPlan(database: string): Promise<RestorePlan> {
    const runIds = await this.primaryZone.listRunIds();
    if (runIds.length === 0) {
      throw new NotFoundException(
        `No backup runs under backup volumes for ${database}`,
      );
    }

    const volumeDir = await this.primaryZone.volumeDirForDatabase(database);
    const steps: RestorePlanStep[] = [];
    const notes: string[] = [
      'Plan only — does not execute restore.',
      'Apply full dumps first, then append chunks in watermark order, then cdc patches/deletes.',
      'Snapshot mode overwrites under snapshots/<database>/.',
      `Volume root: ${volumeDir}`,
    ];
    let order = 1;

    const snapshotDir = path.join(volumeDir, 'snapshots', database);
    if (fs.existsSync(snapshotDir)) {
      for (const file of this.listGzipFiles(snapshotDir)) {
        steps.push({
          order: order++,
          kind: 'snapshot',
          runId: 'snapshots',
          relativePath: path.relative(volumeDir, file),
          absolutePath: file,
        });
      }
    }

    for (const runId of runIds) {
      const manifest = (await this.primaryZone.readManifest(
        runId,
      )) as RunManifest | null;
      if (!manifest) {
        continue;
      }

      const dbResult = manifest.databases.find((d) => d.database === database);
      if (!dbResult || dbResult.status !== 'ok') {
        continue;
      }

      const dbDir = path.join(
        await this.primaryZone.runDirForDatabase(runId, database),
        database,
      );
      for (const kind of ['full', 'append', 'cdc'] as const) {
        const kindDir = path.join(dbDir, kind);
        if (!fs.existsSync(kindDir)) {
          continue;
        }

        for (const file of this.listGzipFiles(kindDir).sort()) {
          steps.push({
            order: order++,
            kind,
            runId,
            relativePath: path.relative(volumeDir, file),
            absolutePath: file,
          });
        }
      }
    }

    if (steps.length === 0) {
      throw new NotFoundException(
        `No restore artifacts found for database ${database}`,
      );
    }

    return { database, steps, notes };
  }

  private listGzipFiles(dir: string): string[] {
    return fs
      .readdirSync(dir)
      .filter((f) => f.endsWith('.csv.gz'))
      .map((f) => path.join(dir, f));
  }
}
