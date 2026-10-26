import path from 'node:path';

import { Injectable, Logger } from '@nestjs/common';
import { Client } from 'pg';

import { volumeDirForGroup } from '../backup-paths';
import { ensureMinFreeSpace } from '../disk-stats.util';
import { BackupCancelledError } from '../errors/backup-cancelled.error';
import {
  type BackupRunProgressContext,
  progressSink,
} from '../progress/backup-run-progress.context';
import { BackupCancelRegistry } from '../queue/backup-cancel.registry';
import {
  type BackupConfig,
  type DatabaseRunResult,
  type RunManifest,
  type SourceConfig,
} from '../types';
import { setDefaultCompressionSettings } from './compressed-writer';
import {
  acquireDatabaseLock,
  databaseLockFileName,
  readLockPayload,
} from './lock';
import {
  createRunId,
  ensureRunDir,
  upsertDatabaseResult,
  writeManifest,
} from './manifest';
import { backupAdempiereDatabase } from './profiles/adempiere.profile';
import { backupEnversDatabase } from './profiles/envers.profile';
import { backupMssqlSnapshot } from './profiles/mssql-snapshot.profile';
import { backupPgLogicalDump } from './profiles/pg-logical-dump.profile';
import { dumpPostgresSchema } from './schema-dump';
import { writeDatabaseSha256Sums } from './sha256sums';

@Injectable()
export class BackupRunnerService {
  private readonly logger = new Logger(BackupRunnerService.name);

  constructor(private readonly cancelRegistry: BackupCancelRegistry) {}

  async run(
    config: BackupConfig,
    runId = createRunId(),
    signal?: AbortSignal,
    progressCtx?: BackupRunProgressContext,
  ): Promise<RunManifest> {
    const mode = config.mode ?? 'incremental';
    const manifestRoots = new Set<string>([config.backupDir]);
    const sink = progressSink(progressCtx);

    for (const source of config.sources) {
      if (source.databases.length === 0) {
        continue;
      }

      manifestRoots.add(volumeDirForGroup(config.volumeDirs, source.group));
    }

    for (const root of manifestRoots) {
      ensureRunDir(root, runId);
    }

    setDefaultCompressionSettings({
      codec: config.compression,
      level: config.zstdLevel,
      threads: config.zstdThreads,
      verify: config.verifyArchive,
    });

    for (const root of manifestRoots) {
      ensureMinFreeSpace(root, config.minFreeBytes);
    }

    const workItems: Array<{ source: SourceConfig; database: string }> = [];

    for (const source of config.sources) {
      for (const database of source.databases) {
        workItems.push({ source, database });
      }
    }

    if (progressCtx) {
      progressCtx.progress.setDbCount(runId, Math.max(workItems.length, 1));
    }

    if (workItems.length === 0) {
      this.logger.warn(`run=${runId} mode=${mode} nothing to back up`);
    }

    let manifest: RunManifest = {
      runId,
      startedAt: new Date().toISOString(),
      backupDir: config.backupDir,
      mode,
      databases: [],
    };
    this.writeManifests(manifestRoots, manifest);

    for (const [dbIndex, item] of workItems.entries()) {
      const { source, database } = item;

      if (signal?.aborted) {
        throw new BackupCancelledError(runId);
      }

      if (progressCtx) {
        progressCtx.progress.setDbIndex(runId, dbIndex, database);
      }

      const volumeDir = volumeDirForGroup(config.volumeDirs, source.group);
      const lock = acquireDatabaseLock(config.backupDir, database, runId);

      if (!lock) {
        const holder = readLockPayload(
          config.backupDir,
          databaseLockFileName(database),
        );
        const holderRun = holder?.runId || 'unknown';
        const skipped: DatabaseRunResult = {
          database,
          group: source.group,
          profile:
            source.group === 'HIS'
              ? 'adempiere'
              : source.group === 'LIS'
                ? 'snapshot'
                : 'envers',
          status: 'skipped',
          watermarkBefore: null,
          captured: null,
          watermarkAfter: null,
          chunks: [],
          skippedTables: [],
          error: `locked by run ${holderRun}`,
        };
        this.logger.warn(
          `run=${runId} skip ${source.group}/${database}: locked by run ${holderRun}`,
        );
        sink?.onLog(
          `${database}: skipped — locked by run ${holderRun}`,
          'warn',
        );
        manifest = upsertDatabaseResult(manifest, skipped);
        this.writeManifests(manifestRoots, manifest);
        continue;
      }

      this.logger.log(
        `run=${runId} starting ${
          source.group
        }/${database} mode=${mode} volume=${volumeDir}${
          config.devRowLimit > 0 ? ` devRowLimit=${config.devRowLimit}` : ''
        }`,
      );
      sink?.onLog(`starting ${source.group}/${database} mode=${mode}`);

      try {
        const result = await this.backupOneDatabase({
          source,
          database,
          config,
          runId,
          volumeDir,
          signal,
          progressCtx,
        });
        manifest = upsertDatabaseResult(manifest, result);
        this.writeManifests(manifestRoots, manifest);

        if (result.status === 'ok') {
          const emptyCount = result.emptyTables?.length ?? 0;
          const emptyNote = emptyCount > 0 ? ` emptyTables=${emptyCount}` : '';
          this.logger.log(
            `run=${runId} ok ${database} watermark ${
              result.watermarkBefore ?? 'null'
            } -> ${result.watermarkAfter}${emptyNote}`,
          );
          sink?.onLog(
            `ok ${database} watermark ${result.watermarkBefore ?? 'null'} -> ${
              result.watermarkAfter
            }`,
          );
        } else {
          this.logger.error(
            `run=${runId} ${result.status} ${database}: ${
              result.error ?? 'unknown'
            }`,
          );
          sink?.onLog(
            `${result.status} ${database}: ${result.error ?? 'unknown'}`,
            result.status === 'error' ? 'error' : 'warn',
          );
        }
      } finally {
        lock.release();
      }
    }

    if (signal?.aborted) {
      throw new BackupCancelledError(runId);
    }

    manifest = {
      ...manifest,
      finishedAt: new Date().toISOString(),
    };
    this.writeManifests(manifestRoots, manifest);
    const okCount = manifest.databases.filter(
      (row) => row.status === 'ok',
    ).length;
    const errorCount = manifest.databases.filter(
      (row) => row.status === 'error',
    ).length;
    const skippedCount = manifest.databases.filter(
      (row) => row.status === 'skipped',
    ).length;
    this.logger.log(
      `run=${runId} finished mode=${mode} ok=${okCount} error=${errorCount} skipped=${skippedCount}`,
    );

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
    runId: string,
  ): Promise<{ client: Client; unregisterKiller: () => void }> {
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

    const backendPid = client.processID;
    const unregisterKiller = this.cancelRegistry.registerKiller(
      runId,
      async () => {
        if (!backendPid) {
          return;
        }

        const killer = new Client({
          host: source.host,
          port: source.port,
          user: source.user,
          password: source.password,
          database,
          connectionTimeoutMillis: 10_000,
        });

        try {
          await killer.connect();
          await killer.query('SELECT pg_cancel_backend($1)', [backendPid]);
          await new Promise((resolve) => {
            setTimeout(resolve, 10_000);
          });
          const still = await killer.query(
            `SELECT 1 FROM pg_stat_activity WHERE pid = $1 AND state <> 'idle'`,
            [backendPid],
          );

          if ((still.rowCount ?? 0) > 0) {
            await killer.query('SELECT pg_terminate_backend($1)', [backendPid]);
          }
        } finally {
          try {
            await killer.end();
          } catch {
            // ignore
          }
        }
      },
    );

    return { client, unregisterKiller };
  }

  private async backupOneDatabase(options: {
    source: SourceConfig;
    database: string;
    config: BackupConfig;
    runId: string;
    volumeDir: string;
    signal?: AbortSignal;
    progressCtx?: BackupRunProgressContext;
  }): Promise<DatabaseRunResult> {
    const { source, database, config, runId, volumeDir, signal, progressCtx } =
      options;
    const mode = config.mode ?? 'incremental';
    const sink = progressSink(progressCtx);

    let client: Client | null = null;
    let unregisterKiller: (() => void) | null = null;

    try {
      if (mode === 'logical') {
        if (source.group === 'LIS') {
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
            error: 'logical dump not supported for LIS/MSSQL',
          };
        }

        return await backupPgLogicalDump({
          source,
          database,
          backupDir: volumeDir,
          runId,
          jobs: config.logicalJobs,
          excludeTableData: config.logicalExcludeTableData,
          preferredSchemas: source.group === 'HIS' ? ['adempiere'] : undefined,
          signal,
          progress: sink,
        });
      }

      if (source.group === 'LIS') {
        const lisResult = await backupMssqlSnapshot({
          source,
          database,
          backupDir: volumeDir,
          runId,
          devRowLimit: config.devRowLimit,
          statementTimeoutMs: config.statementTimeoutMs,
          chunkSize: Number(config.chunkSize),
          signal,
          progress: sink,
          cancelRegistry: this.cancelRegistry,
        });

        return this.withSha256Sums(volumeDir, runId, database, lisResult);
      }

      const connected = await this.connectSource(
        source,
        database,
        config.statementTimeoutMs,
        runId,
      );
      client = connected.client;
      unregisterKiller = connected.unregisterKiller;

      if (source.group === 'HIS' && database === 'produce') {
        if (mode === 'full') {
          await dumpPostgresSchema({
            host: source.host,
            port: source.port,
            user: source.user,
            password: source.password,
            database,
            schemas: ['adempiere'],
            outputPath: path.join(
              volumeDir,
              'runs',
              runId,
              database,
              'schema',
              'schema.sql.zst',
            ),
            signal,
          });
        }

        const hisResult = await backupAdempiereDatabase({
          client,
          source,
          database,
          backupDir: volumeDir,
          runId,
          chunkSize: config.chunkSize,
          mode,
          devRowLimit: config.devRowLimit,
          signal,
          progress: sink,
        });

        return this.withSha256Sums(volumeDir, runId, database, hisResult);
      }

      if (source.group === 'EMR' || source.group === 'BADL') {
        if (mode === 'full') {
          await dumpPostgresSchema({
            host: source.host,
            port: source.port,
            user: source.user,
            password: source.password,
            database,
            schemas: undefined,
            outputPath: path.join(
              volumeDir,
              'runs',
              runId,
              database,
              'schema',
              'schema.sql.zst',
            ),
            signal,
          });
        }

        const emrResult = await backupEnversDatabase({
          client,
          source,
          database,
          backupDir: volumeDir,
          runId,
          chunkSize: config.chunkSize,
          mode,
          devRowLimit: config.devRowLimit,
          signal,
          progress: sink,
        });

        return this.withSha256Sums(volumeDir, runId, database, emrResult);
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
      if (
        signal?.aborted ||
        (error instanceof Error &&
          /cancel|abort|terminat|query_canceled|57014/i.test(error.message))
      ) {
        throw new BackupCancelledError(runId);
      }

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
      unregisterKiller?.();

      if (client) {
        try {
          await client.end();
        } catch {
          // ignore
        }
      }
    }
  }

  private async withSha256Sums(
    volumeDir: string,
    runId: string,
    database: string,
    result: DatabaseRunResult,
  ): Promise<DatabaseRunResult> {
    if (result.status === 'ok') {
      try {
        await writeDatabaseSha256Sums(
          path.join(volumeDir, 'runs', runId, database),
          result,
        );
      } catch (error) {
        this.logger.warn(
          `run=${runId} SHA256SUMS write failed for ${database}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }

    return result;
  }
}
