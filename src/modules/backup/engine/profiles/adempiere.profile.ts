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
import { compressedCsvExt } from '../compressed-writer';
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

/** Append-only / log-like tables copied by monotonic PK watermark. */
const APPEND_ONLY: Array<{ table: string; idColumn: string }> = [
  { table: 'ad_changelog', idColumn: 'ad_changelog_id' },
  { table: 'ad_issue', idColumn: 'ad_issue_id' },
  { table: 'ad_session', idColumn: 'ad_session_id' },
  { table: 'ad_pinstance', idColumn: 'ad_pinstance_id' },
  { table: 'ad_pinstance_para', idColumn: 'ad_pinstance_id' },
  { table: 'ad_recentitem', idColumn: 'ad_recentitem_id' },
  { table: 'his_sign_history', idColumn: 'his_sign_history_id' },
  { table: 'his_sms', idColumn: 'his_sms_id' },
];

const WATERMARK_TABLE = {
  schema: 'adempiere',
  table: 'ad_changelog',
  idColumn: 'ad_changelog_id',
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

async function copyAppendChunks(options: {
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
  let ranges = splitIdRange({ fromExclusive, toInclusive }, chunkSize);

  if (rowLimit && rowLimit > 0) {
    ranges = ranges.slice(0, 1);
  }

  const outDir = path.join(backupDir, 'runs', runId, database, 'append');

  for (const range of ranges) {
    const key = chunkKey(schema, table, range.fromExclusive, range.toInclusive);

    if (pending.completedChunkKeys.includes(key)) {
      continue;
    }

    const fileName = `${schema}.${table}.${range.fromExclusive}_${
      range.toInclusive
    }${compressedCsvExt()}`;
    const outputPath = path.join(outDir, fileName);
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

async function exportChangedBusinessRows(options: {
  client: Client;
  backupDir: string;
  database: string;
  runId: string;
  fromExclusive: bigint;
  toInclusive: bigint;
  rowLimit?: number;
}): Promise<ChunkResult[]> {
  const {
    client,
    backupDir,
    database,
    runId,
    fromExclusive,
    toInclusive,
    rowLimit,
  } = options;
  const outDir = path.join(backupDir, 'runs', runId, database, 'cdc');
  fs.mkdirSync(outDir, { recursive: true });
  const chunks: ChunkResult[] = [];

  const changed = await client.query<{
    table_name: string;
    record_id: string;
    has_delete: boolean;
  }>(
    `
    SELECT
      t.tablename AS table_name,
      cl.record_id::text,
      bool_or(cl.eventchangelog = 'D') AS has_delete
    FROM adempiere.ad_changelog cl
    JOIN adempiere.ad_table t ON t.ad_table_id = cl.ad_table_id
    WHERE cl.ad_changelog_id > $1
      AND cl.ad_changelog_id <= $2
    GROUP BY t.tablename, cl.record_id
    ORDER BY t.tablename, cl.record_id
    `,
    [fromExclusive.toString(), toInclusive.toString()],
  );

  const deleteRows = changed.rows.filter((r) => r.has_delete);

  if (deleteRows.length > 0) {
    const values = deleteRows
      .map((r) => `('${r.table_name.replaceAll("'", "''")}', ${r.record_id})`)
      .join(',\n');
    const deletesPath = path.join(
      outDir,
      `deletes_${fromExclusive}_${toInclusive}${compressedCsvExt()}`,
    );
    const del = await copyQueryToGzipFile(
      client,
      `SELECT * FROM (VALUES ${values}) AS d(table_name, record_id)`,
      deletesPath,
      { rowLimit },
    );
    chunks.push({
      key: `cdc.deletes:${fromExclusive}:${toInclusive}`,
      file: deletesPath,
      rowCount: del.rowCount,
      bytes: del.bytes,
      sha256: del.sha256,
      md5: del.md5,
      fromExclusive: fromExclusive.toString(),
      toInclusive: toInclusive.toString(),
    });
  }

  const byTable = new Map<string, string[]>();

  for (const row of changed.rows) {
    if (row.has_delete) {
      continue;
    }

    const list = byTable.get(row.table_name) ?? [];
    list.push(row.record_id);
    byTable.set(row.table_name, list);
  }

  for (const [tableName, recordIds] of byTable) {
    const schema = 'adempiere';
    const physical = tableName.toLowerCase();
    const pkGuess = `${physical}_id`;
    const hasPk = await tableHasColumn(client, schema, physical, pkGuess);

    if (!hasPk) {
      continue;
    }

    const batchSize = 5000;

    for (let i = 0; i < recordIds.length; i += batchSize) {
      const batch = recordIds.slice(i, i + batchSize);
      const file = path.join(
        outDir,
        `patch_${physical}_${fromExclusive}_${toInclusive}_${i}${compressedCsvExt()}`,
      );
      const idList = batch.join(',');
      const result = await copyQueryToGzipFile(
        client,
        `
          SELECT *
          FROM ${qualifyTable(schema, physical)}
          WHERE "${pkGuess.replaceAll('"', '""')}" IN (${idList})
        `,
        file,
        { rowLimit },
      );
      chunks.push({
        key: `cdc.patch.${tableName}:${fromExclusive}:${toInclusive}:${i}`,
        file,
        rowCount: result.rowCount,
        bytes: result.bytes,
        sha256: result.sha256,
        md5: result.md5,
        fromExclusive: fromExclusive.toString(),
        toInclusive: toInclusive.toString(),
      });
    }
  }

  return chunks;
}

async function fullDumpReadableTables(options: {
  client: Client;
  backupDir: string;
  database: string;
  runId: string;
  tables: Array<{ schema: string; table: string }>;
  appendOnlyNames: Set<string>;
  state: DatabaseState;
  pending: PendingState;
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
    runId,
    tables,
    appendOnlyNames,
    rowLimit,
    signal,
    progress,
  } = options;
  let { state, pending } = options;
  const chunks: ChunkResult[] = [];
  const outDir = path.join(backupDir, 'runs', runId, database, 'full');
  const workTables = tables.filter((t) => !appendOnlyNames.has(t.table));
  let tablesDone = 0;

  for (const table of workTables) {
    if (signal?.aborted) {
      throw new BackupCancelledError(runId);
    }

    const key = `full:${table.schema}.${table.table}`;

    if (pending.completedChunkKeys.includes(key)) {
      tablesDone += 1;
      continue;
    }

    const qualified = `${table.schema}.${table.table}`;
    const outputPath = path.join(outDir, `${qualified}${compressedCsvExt()}`);
    progress?.onTableProgress({
      database,
      table: qualified,
      tablesDone,
      tablesTotal: workTables.length,
      inFlight: true,
    });

    let reportedBytes = 0;
    const result = await copyFullTable({
      client,
      schema: table.schema,
      table: table.table,
      outputPath,
      rowLimit,
      onBytes: (delta) => {
        reportedBytes += delta;
        progress?.onTableProgress({
          database,
          table: qualified,
          tablesDone,
          tablesTotal: workTables.length,
          bytesDelta: delta,
          inFlight: true,
        });
      },
    });
    chunks.push({
      key,
      file: result.file,
      rowCount: result.rowCount,
      bytes: result.bytes,
      sha256: result.sha256,
      md5: result.md5,
      fromExclusive: '0',
      toInclusive: 'full',
    });
    pending = markChunkComplete(pending, key);
    state = await persistPending(backupDir, database, state, pending);
    tablesDone += 1;
    progress?.onTableProgress({
      database,
      table: qualified,
      tablesDone,
      tablesTotal: workTables.length,
      rowsDelta: Math.max(result.rowCount, 0),
      bytesDelta: Math.max(result.bytes - reportedBytes, 0),
      inFlight: false,
    });
  }

  return { chunks, state, pending };
}

export async function backupAdempiereDatabase(options: {
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

  let state = loadState(backupDir, database, 'adempiere');
  const watermarkBefore = state.watermark;
  const forceFull = mode === 'full';
  const doFullDump = forceFull || !state.initialFullDone;

  const schemas = await findSchemas(client, ['adempiere', 'public']);

  if (!schemas.includes('adempiere')) {
    throw new Error('produce: schema adempiere not usable');
  }

  const { tables, skipped } = await listReadableTables(client, ['adempiere']);
  skippedTables.push(...skipped);

  const tip = await captureTipByOrder(
    client,
    WATERMARK_TABLE.schema,
    WATERMARK_TABLE.table,
    WATERMARK_TABLE.idColumn,
  );
  const capturedFresh = formatWatermark(tip);

  let pending = beginOrResumePending(state, capturedFresh, runId);
  const captured = pending.captured;
  state = await persistPending(backupDir, database, state, pending);

  const saved = parseWatermark(state.watermark);
  const range = buildIdRange(saved, BigInt(captured));

  try {
    if (doFullDump) {
      const appendNames = new Set(APPEND_ONLY.map((t) => t.table));
      const full = await fullDumpReadableTables({
        client,
        backupDir,
        database,
        runId: pending.runId,
        tables,
        appendOnlyNames: appendNames,
        state,
        pending,
        rowLimit,
        signal,
        progress,
      });
      allChunks.push(...full.chunks);
      state = full.state;
      pending = full.pending;
    }

    if (range) {
      // Full / first run: append-only from 0. Incremental: (saved, captured].
      const appendRange = doFullDump
        ? buildIdRange(null, range.toInclusive)
        : range;

      if (appendRange) {
        for (const append of APPEND_ONLY) {
          const exists = tables.some((t) => t.table === append.table);

          if (!exists) {
            skippedTables.push({
              schema: 'adempiere',
              table: append.table,
              reason: 'table not found or not readable',
            });
            continue;
          }

          const hasCol = await tableHasColumn(
            client,
            'adempiere',
            append.table,
            append.idColumn,
          );

          if (!hasCol) {
            skippedTables.push({
              schema: 'adempiere',
              table: append.table,
              reason: `missing id column ${append.idColumn}`,
            });
            continue;
          }

          const copied = await copyAppendChunks({
            client,
            backupDir,
            database,
            runId: pending.runId,
            schema: 'adempiere',
            table: append.table,
            idColumn: append.idColumn,
            fromExclusive: appendRange.fromExclusive,
            toInclusive: appendRange.toInclusive,
            chunkSize: effectiveChunkSize,
            state,
            pending,
            rowLimit,
          });
          allChunks.push(...copied.chunks);
          state = copied.state;
          pending = copied.pending;
        }
      }

      if (!doFullDump) {
        const cdcChunks = await exportChangedBusinessRows({
          client,
          backupDir,
          database,
          runId: pending.runId,
          fromExclusive: range.fromExclusive,
          toInclusive: range.toInclusive,
          rowLimit,
        });
        allChunks.push(...cdcChunks);
      }
    }

    state = commitWatermark(state, captured);
    saveState(backupDir, database, state);

    return {
      database,
      group: source.group,
      profile: 'adempiere',
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
