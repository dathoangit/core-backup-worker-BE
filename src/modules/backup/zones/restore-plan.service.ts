import fs from 'node:fs';
import path from 'node:path';

import { Injectable, NotFoundException } from '@nestjs/common';

import { type RunManifest } from '../types';
import { PrimaryZoneService } from './primary-zone.service';

export interface RestorePlanStep {
  order: number;
  kind: 'full' | 'append' | 'cdc' | 'snapshot' | 'logical';
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
      'CSV files may be .csv.zst (zstd) or legacy .csv.gz — decompress accordingly (zstd -dc / gzip -dc).',
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

      const logicalDir = path.join(dbDir, 'logical');

      if (fs.existsSync(logicalDir)) {
        steps.push({
          order: order++,
          kind: 'logical',
          runId,
          relativePath: path.relative(volumeDir, logicalDir),
          absolutePath: logicalDir,
        });
        notes.push(
          `Logical dump: pg_restore -Fd -j 4 -d <target_db> ${logicalDir}`,
        );
      }

      for (const kind of ['full', 'append', 'cdc'] as const) {
        const kindDir = path.join(dbDir, kind);

        if (!fs.existsSync(kindDir)) {
          continue;
        }

        for (const file of this.listGzipFiles(kindDir).sort((a, b) =>
          this.compareChunkFiles(a, b),
        )) {
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
      .filter((f) => f.endsWith('.csv.gz') || f.endsWith('.csv.zst'))
      .map((f) => path.join(dir, f));
  }

  /** Prefer schema.table.000001.csv.gz before schema.table.000002.csv.gz. */
  private compareChunkFiles(a: string, b: string): number {
    const baseA = path.basename(a);
    const baseB = path.basename(b);
    const seqA = baseA.match(/\.(\d{6})\.csv\.(?:gz|zst)$/)?.[1];
    const seqB = baseB.match(/\.(\d{6})\.csv\.(?:gz|zst)$/)?.[1];

    if (
      seqA &&
      seqB &&
      baseA.replace(`.${seqA}.csv.gz`, '').replace(`.${seqA}.csv.zst`, '') ===
        baseB.replace(`.${seqB}.csv.gz`, '').replace(`.${seqB}.csv.zst`, '')
    ) {
      return Number.parseInt(seqA, 10) - Number.parseInt(seqB, 10);
    }

    return baseA.localeCompare(baseB);
  }
}
