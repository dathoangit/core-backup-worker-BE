import { Injectable, Logger } from '@nestjs/common';
import { Client } from 'pg';

import { volumeDirForGroup } from '../backup-paths';
import {
  type BackupConfig,
  type DatabaseRunResult,
  type RunManifest,
  type SourceConfig,
} from '../types';
import {
  createRunId,
  ensureRunDir,
  upsertDatabaseResult,
  writeManifest,
} from './manifest';
import { backupAdempiereDatabase } from './profiles/adempiere.profile';
import { backupEnversDatabase } from './profiles/envers.profile';
import { backupMssqlSnapshot } from './profiles/mssql-snapshot.profile';

@Injectable()
export class BackupRunnerService {
  private readonly logger = new Logger(BackupRunnerService.name);

  async run(config: BackupConfig, runId = createRunId()): Promise<RunManifest> {
    const mode = config.mode ?? 'incremental';
    const manifestRoots = new Set<string>([config.backupDir]);

    for (const source of config.sources) {
      if (source.databases.length === 0) {
        continue;
      }

      manifestRoots.add(volumeDirForGroup(config.volumeDirs, source.group));
    }

    for (const root of manifestRoots) {
      ensureRunDir(root, runId);
    }

    let manifest: RunManifest = {
      runId,
      startedAt: new Date().toISOString(),
      backupDir: config.backupDir,
      mode,
      databases: [],
    };
    this.writeManifests(manifestRoots, manifest);

    for (const source of config.sources) {
      for (const database of source.databases) {
        const volumeDir = volumeDirForGroup(config.volumeDirs, source.group);
        this.logger.log(
          `starting ${
            source.group
          }/${database} mode=${mode} volume=${volumeDir}${
            config.devRowLimit > 0 ? ` devRowLimit=${config.devRowLimit}` : ''
          }`,
        );
        const result = await this.backupOneDatabase({
          source,
          database,
          config,
          runId,
          volumeDir,
        });
        manifest = upsertDatabaseResult(manifest, result);
        this.writeManifests(manifestRoots, manifest);

        if (result.status === 'ok') {
          const emptyCount = result.emptyTables?.length ?? 0;
          const emptyNote = emptyCount > 0 ? ` emptyTables=${emptyCount}` : '';
          this.logger.log(
            `ok ${database} watermark ${result.watermarkBefore ?? 'null'} -> ${result.watermarkAfter}${emptyNote}`,
          );
        } else {
          this.logger.error(
            `${result.status} ${database}: ${result.error ?? 'unknown'}`,
          );
        }
      }
    }

    manifest = {
      ...manifest,
      finishedAt: new Date().toISOString(),
    };
    this.writeManifests(manifestRoots, manifest);

    return manifest;
  }

  private writeManifests(roots: Set<string>, manifest: RunManifest): void {
    for (const root of roots) {
      writeManifest(root, manifest);
    }
  }

  private async connectSource(
    source: SourceConfig,
    database: string,
    statementTimeoutMs: number,
  ): Promise<Client> {
    const client = new Client({
      host: source.host,
      port: source.port,
      user: source.user,
      password: source.password,
      database,
      connectionTimeoutMillis: 15_000,
    });
    await client.connect();
    await client.query(`SET application_name = 'his-raw-backup'`);
    await client.query(`SET TIME ZONE 'Asia/Ho_Chi_Minh'`);

    if (statementTimeoutMs > 0) {
      await client.query(`SET statement_timeout = ${statementTimeoutMs}`);
    }

    return client;
  }

  private async backupOneDatabase(options: {
    source: SourceConfig;
    database: string;
    config: BackupConfig;
    runId: string;
    volumeDir: string;
  }): Promise<DatabaseRunResult> {
    const { source, database, config, runId, volumeDir } = options;
    const mode = config.mode ?? 'incremental';

    let client: Client | null = null;

    try {
      if (source.group === 'LIS') {
        return await backupMssqlSnapshot({
          source,
          database,
          backupDir: volumeDir,
          runId,
          devRowLimit: config.devRowLimit,
          statementTimeoutMs: config.statementTimeoutMs,
        });
      }

      client = await this.connectSource(
        source,
        database,
        config.statementTimeoutMs,
      );

      if (source.group === 'HIS' && database === 'produce') {
        return await backupAdempiereDatabase({
          client,
          source,
          database,
          backupDir: volumeDir,
          runId,
          chunkSize: config.chunkSize,
          mode,
          devRowLimit: config.devRowLimit,
        });
      }

      if (source.group === 'EMR' || source.group === 'BADL') {
        return await backupEnversDatabase({
          client,
          source,
          database,
          backupDir: volumeDir,
          runId,
          chunkSize: config.chunkSize,
          mode,
          devRowLimit: config.devRowLimit,
        });
      }

      return {
        database,
        group: source.group,
        profile: 'snapshot',
        status: 'skipped',
        watermarkBefore: null,
        captured: null,
        watermarkAfter: null,
        chunks: [],
        skippedTables: [],
        error: `No profile for ${source.group}/${database}`,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      let profile: DatabaseRunResult['profile'] = 'snapshot';

      if (source.group === 'HIS') {
        profile = 'adempiere';
      } else if (source.group === 'EMR' || source.group === 'BADL') {
        profile = 'envers';
      }

      return {
        database,
        group: source.group,
        profile,
        status: 'error',
        watermarkBefore: null,
        captured: null,
        watermarkAfter: null,
        chunks: [],
        skippedTables: [],
        error: message,
      };
    } finally {
      if (client) {
        try {
          await client.end();
        } catch {
          // ignore
        }
      }
    }
  }
}
