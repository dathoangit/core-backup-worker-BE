import fs from 'node:fs';
import path from 'node:path';

import { type Client } from 'pg';

import { BackupCancelledError } from '../../errors/backup-cancelled.error';
import { type BackupProgressSink } from '../../progress/backup-progress.types';
import {
  type ChunkResult,
  type DatabaseRunResult,
  type DatabaseState,
  type PendingState,
  type SkippedTable,
  type SourceConfig,
} from '../../types';
import {
  buildIdRange,
  chunkKey,
  formatWatermark,
  parseWatermark,
  splitIdRange,
} from '../checkpoint';
import {
  copyFullTable,
  copyQueryToGzipFile,
  copyTableChunk,
  qualifyTable,
} from '../copy-writer';
import {
  captureTipByOrder,
  findSchemas,
  listReadableTables,
  tableHasColumn,
} from '../schema';
import {
  beginOrResumePending,
  commitWatermark,
  loadState,
  markChunkComplete,
  saveState,
} from '../state';

const SCHEMA_BY_DATABASE: Record<string, string[]> = {
  signer: ['signer'],
  file_service: ['file'],
  vital_signs: ['vital_signs'],
  research_management: ['research'],
  medical_incident: ['medical_incident'],
  html_editor: ['html_editor'],
  phat_thuoc: ['phat_thuoc'],
};

async function persistPending(
  backupDir: string,
  database: string,
  state: DatabaseState,
  pending: PendingState,
): Promise<DatabaseState> {
  const next = { ...state, pending };
  saveState(backupDir, database, next);

  return next;
}

async function snapshotAllTables(options: {
  client: Client;
  backupDir: string;
  database: string;
  tables: Array<{ schema: string; table: string }>;
  state: DatabaseState;
  pending: PendingState;
  /** When set, write under runs/<runId>/<db>/full instead of snapshots/. */
  runId?: string;
  rowLimit?: number;
  signal?: AbortSignal;
  progress?: BackupProgressSink;
}): Promise<{
  chunks: ChunkResult[];
  state: DatabaseState;
  pending: PendingState;
}> {
  const {
    client,
    backupDir,
    database,
    tables,
    runId,
    rowLimit,
    signal,
    progress,
  } = options;
  let { state, pending } = options;
  const chunks: ChunkResult[] = [];
  const outDir = runId
    ? path.join(backupDir, 'runs', runId, database, 'full')
    : path.join(backupDir, 'snapshots', database);
  fs.mkdirSync(outDir, { recursive: true });
  const keyPrefix = runId ? 'full' : 'snapshot';
  let tablesDone = 0;

  for (const table of tables) {
    if (signal?.aborted) {
      throw new BackupCancelledError(runId ?? 'cli');
    }

    const key = `${keyPrefix}:${table.schema}.${table.table}`;

    if (pending.completedChunkKeys.includes(key)) {
      tablesDone += 1;
      continue;
    }

    const outputPath = path.join(
      outDir,
      `${table.schema}.${table.table}.csv.gz`,
    );
    const result = await copyFullTable({
      client,
      schema: table.schema,
      table: table.table,
      outputPath,
      rowLimit,
    });
    chunks.push({
      key,
      file: outputPath,
      rowCount: result.rowCount,
      bytes: result.bytes,
      sha256: result.sha256,
      md5: result.md5,
      fromExclusive: '0',
      toInclusive: runId ? 'full' : 'snapshot',
    });
    pending = markChunkComplete(pending, key);
    state = await persistPending(backupDir, database, state, pending);
    tablesDone += 1;
    progress?.onTableProgress({
      database,
      table: `${table.schema}.${table.table}`,
      tablesDone,
      tablesTotal: tables.length,
      rowsDelta: Math.max(result.rowCount, 0),
    });
  }

  return { chunks, state, pending };
}

async function copyRevChunks(options: {
  client: Client;
  backupDir: string;
  database: string;
  runId: string;
  schema: string;
  table: string;
  idColumn: string;
  fromExclusive: bigint;
  toInclusive: bigint;
  chunkSize: bigint;
  state: DatabaseState;
  pending: PendingState;
  rowLimit?: number;
}): Promise<{
  chunks: ChunkResult[];
  state: DatabaseState;
  pending: PendingState;
}> {
  const {
    client,
    backupDir,
    database,
    runId,
    schema,
    table,
    idColumn,
    fromExclusive,
    toInclusive,
    chunkSize,
    rowLimit,
  } = options;
  let { state, pending } = options;
  const chunks: ChunkResult[] = [];
  const outDir = path.join(backupDir, 'runs', runId, database, 'append');
  let ranges = splitIdRange({ fromExclusive, toInclusive }, chunkSize);

  if (rowLimit && rowLimit > 0) {
    ranges = ranges.slice(0, 1);
  }

  for (const range of ranges) {
    const key = chunkKey(schema, table, range.fromExclusive, range.toInclusive);

    if (pending.completedChunkKeys.includes(key)) {
      continue;
    }

    const outputPath = path.join(
      outDir,
      `${schema}.${table}.${range.fromExclusive}_${range.toInclusive}.csv.gz`,
    );
    const chunk = await copyTableChunk({
      client,
      schema,
      table,
      idColumn,
      fromExclusive: range.fromExclusive,
      toInclusive: range.toInclusive,
      outputPath,
      chunkKey: key,
      rowLimit,
    });
    chunks.push(chunk);
    pending = markChunkComplete(pending, key);
    state = await persistPending(backupDir, database, state, pending);
  }

  return { chunks, state, pending };
}

async function exportEnversPatches(options: {
  client: Client;
  backupDir: string;
  database: string;
  runId: string;
  schema: string;
  fromExclusive: bigint;
  toInclusive: bigint;
  baseTables: Array<{ schema: string; table: string }>;
  rowLimit?: number;
}): Promise<ChunkResult[]> {
  const {
    client,
    backupDir,
    database,
    runId,
    schema,
    fromExclusive,
    toInclusive,
    baseTables,
    rowLimit,
  } = options;
  const outDir = path.join(backupDir, 'runs', runId, database, 'cdc');
  fs.mkdirSync(outDir, { recursive: true });
  const chunks: ChunkResult[] = [];

  for (const table of baseTables) {
    if (table.table.endsWith('_aud') || table.table === 'revinfo') {
      continue;
    }

    const audTable = `${table.table}_aud`;
    const hasAud = baseTables.some(
      (t) => t.schema === table.schema && t.table === audTable,
    );

    if (!hasAud) {
      continue;
    }

    const hasId = await tableHasColumn(client, table.schema, table.table, 'id');

    if (!hasId) {
      continue;
    }

    const file = path.join(
      outDir,
      `patch_${table.schema}.${table.table}_${fromExclusive}_${toInclusive}.csv.gz`,
    );

    const result = await copyQueryToGzipFile(
      client,
      `
        SELECT b.*
        FROM ${qualifyTable(table.schema, table.table)} b
        WHERE b.id IN (
          SELECT DISTINCT a.id
          FROM ${qualifyTable(table.schema, audTable)} a
          WHERE a.rev > ${fromExclusive.toString()}
            AND a.rev <= ${toInclusive.toString()}
            AND a.revtype IN (0, 1)
        )
      `,
      file,
      { rowLimit },
    );

    if (result.bytes > 20) {
      chunks.push({
        key: `envers.patch.${table.schema}.${table.table}:${fromExclusive}:${toInclusive}`,
        file,
        rowCount: result.rowCount,
        bytes: result.bytes,
        sha256: result.sha256,
        md5: result.md5,
        fromExclusive: fromExclusive.toString(),
        toInclusive: toInclusive.toString(),
      });
    }

    const deletesFile = path.join(
      outDir,
      `deletes_${table.schema}.${table.table}_${fromExclusive}_${toInclusive}.csv.gz`,
    );
    const deletes = await copyQueryToGzipFile(
      client,
      `
        SELECT DISTINCT a.id
        FROM ${qualifyTable(table.schema, audTable)} a
        WHERE a.rev > ${fromExclusive.toString()}
          AND a.rev <= ${toInclusive.toString()}
          AND a.revtype = 2
      `,
      deletesFile,
      { rowLimit },
    );

    if (deletes.bytes > 20) {
      chunks.push({
        key: `envers.deletes.${table.schema}.${table.table}:${fromExclusive}:${toInclusive}`,
        file: deletesFile,
        rowCount: deletes.rowCount,
        bytes: deletes.bytes,
        sha256: deletes.sha256,
        md5: deletes.md5,
        fromExclusive: fromExclusive.toString(),
        toInclusive: toInclusive.toString(),
      });
    }
  }

  void schema;

  return chunks;
}

export async function backupEnversDatabase(options: {
  client: Client;
  source: SourceConfig;
  database: string;
  backupDir: string;
  runId: string;
  chunkSize: bigint;
  mode?: 'incremental' | 'full';
  devRowLimit?: number;
  signal?: AbortSignal;
  progress?: BackupProgressSink;
}): Promise<DatabaseRunResult> {
  const {
    client,
    source,
    database,
    backupDir,
    runId,
    chunkSize,
    mode = 'incremental',
    devRowLimit = 0,
    signal,
    progress,
  } = options;
  const rowLimit = devRowLimit > 0 ? devRowLimit : undefined;
  const effectiveChunkSize =
    rowLimit && rowLimit > 0
      ? BigInt(Math.min(Number(chunkSize), rowLimit))
      : chunkSize;
  const skippedTables: SkippedTable[] = [];
  const allChunks: ChunkResult[] = [];
  const forceFull = mode === 'full';

  const schemaCandidates = SCHEMA_BY_DATABASE[database] ?? [];
  const schemas = await findSchemas(client, [...schemaCandidates, 'public']);
  const dataSchemas = schemas.filter((s) => s !== 'public');

  if (dataSchemas.length === 0) {
    throw new Error(`${database}: no usable business schema`);
  }

  const { tables, skipped } = await listReadableTables(client, dataSchemas);
  skippedTables.push(...skipped);
  const schema = dataSchemas[0];
  const hasRevinfo = tables.some(
    (t) => t.schema === schema && t.table === 'revinfo',
  );
  const revCount = hasRevinfo
    ? await captureTipByOrder(client, schema, 'revinfo', 'rev')
    : 0n;

  // Empty or missing revinfo → overwrite snapshot mode
  if (!hasRevinfo || revCount === 0n) {
    let state = loadState(backupDir, database, 'snapshot');
    const watermarkBefore = state.watermark;
    const captured = formatWatermark(BigInt(Date.now()));
    const pending = beginOrResumePending(state, captured, runId);
    state = await persistPending(backupDir, database, state, pending);

    try {
      const snap = await snapshotAllTables({
        client,
        backupDir,
        database,
        tables,
        state,
        pending,
        // Weekly/full baseline also lands under runs/ so retention can see it.
        runId: forceFull ? pending.runId : undefined,
        rowLimit,
        signal,
        progress,
      });
      allChunks.push(...snap.chunks);
      state = commitWatermark(snap.state, captured);
      saveState(backupDir, database, state);

      return {
        database,
        group: source.group,
        profile: 'snapshot',
        status: 'ok',
        watermarkBefore,
        captured,
        watermarkAfter: state.watermark,
        chunks: allChunks,
        skippedTables,
      };
    } catch (error) {
      saveState(backupDir, database, { ...state, pending });

      throw error;
    }
  }

  let state = loadState(backupDir, database, 'envers');
  const watermarkBefore = state.watermark;
  const capturedFresh = formatWatermark(revCount);
  let pending = beginOrResumePending(state, capturedFresh, runId);
  const captured = pending.captured;
  state = await persistPending(backupDir, database, state, pending);

  const saved = parseWatermark(state.watermark);
  const range = buildIdRange(saved, BigInt(captured));
  const doFullDump = forceFull || !state.initialFullDone;

  try {
    if (doFullDump) {
      const snap = await snapshotAllTables({
        client,
        backupDir,
        database,
        tables: tables.filter(
          (t) => !t.table.endsWith('_aud') && t.table !== 'revinfo',
        ),
        state,
        pending,
        runId: pending.runId,
        rowLimit,
        signal,
        progress,
      });
      allChunks.push(...snap.chunks);
      state = snap.state;
      pending = snap.pending;
    }

    if (range) {
      const effectiveRange = doFullDump
        ? buildIdRange(null, range.toInclusive)
        : range;

      if (effectiveRange) {
        const revinfo = await copyRevChunks({
          client,
          backupDir,
          database,
          runId: pending.runId,
          schema,
          table: 'revinfo',
          idColumn: 'rev',
          fromExclusive: effectiveRange.fromExclusive,
          toInclusive: effectiveRange.toInclusive,
          chunkSize: effectiveChunkSize,
          state,
          pending,
          rowLimit,
        });
        allChunks.push(...revinfo.chunks);
        state = revinfo.state;
        pending = revinfo.pending;

        for (const table of tables.filter((t) => t.table.endsWith('_aud'))) {
          const hasRev = await tableHasColumn(
            client,
            table.schema,
            table.table,
            'rev',
          );

          if (!hasRev) {
            skippedTables.push({
              schema: table.schema,
              table: table.table,
              reason: 'missing rev column',
            });
            continue;
          }

          const aud = await copyRevChunks({
            client,
            backupDir,
            database,
            runId: pending.runId,
            schema: table.schema,
            table: table.table,
            idColumn: 'rev',
            fromExclusive: effectiveRange.fromExclusive,
            toInclusive: effectiveRange.toInclusive,
            chunkSize: effectiveChunkSize,
            state,
            pending,
            rowLimit,
          });
          allChunks.push(...aud.chunks);
          state = aud.state;
          pending = aud.pending;
        }

        if (!doFullDump && state.initialFullDone) {
          const patches = await exportEnversPatches({
            client,
            backupDir,
            database,
            runId: pending.runId,
            schema,
            fromExclusive: range.fromExclusive,
            toInclusive: range.toInclusive,
            baseTables: tables,
            rowLimit,
          });
          allChunks.push(...patches);
        }
      }
    }

    state = commitWatermark(state, captured);
    saveState(backupDir, database, state);

    return {
      database,
      group: source.group,
      profile: 'envers',
      status: 'ok',
      watermarkBefore,
      captured,
      watermarkAfter: state.watermark,
      chunks: allChunks,
      skippedTables,
    };
  } catch (error) {
    saveState(backupDir, database, { ...state, pending });

    throw error;
  }
}
