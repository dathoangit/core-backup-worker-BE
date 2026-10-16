import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGzip } from 'node:zlib';

import sql from 'mssql';

import {
  type ChunkResult,
  type DatabaseRunResult,
  type DatabaseState,
  type PendingState,
  type SkippedTable,
  type SourceConfig,
  type TableRef,
} from '../../types';
import {
  beginOrResumePending,
  commitWatermark,
  loadState,
  markChunkComplete,
  saveState,
} from '../state';

function quoteIdent(ident: string): string {
  return `[${ident.replaceAll(']', ']]')}]`;
}

function csvCell(value: unknown): string {
  if (value === null || value === undefined) {
    return '';
  }

  let text: string;

  if (value instanceof Date) {
    text = value.toISOString();
  } else if (Buffer.isBuffer(value)) {
    text = value.toString('base64');
  } else if (typeof value === 'object') {
    text = JSON.stringify(value);
  } else {
    text = String(value);
  }

  if (/[\n\r",]/.test(text)) {
    return `"${text.replaceAll('"', '""')}"`;
  }

  return text;
}

function persistPending(
  backupDir: string,
  database: string,
  state: DatabaseState,
  pending: PendingState,
): DatabaseState {
  const next = { ...state, pending };
  saveState(backupDir, database, next);

  return next;
}

async function listUserTables(
  pool: sql.ConnectionPool,
): Promise<Array<{ schema: string; table: string }>> {
  const result = await pool.request().query(`
    SELECT s.name AS schema_name, t.name AS table_name
    FROM sys.tables AS t
    INNER JOIN sys.schemas AS s ON t.schema_id = s.schema_id
    WHERE t.is_ms_shipped = 0
    ORDER BY s.name, t.name
  `);

  return result.recordset.map(
    (row: { schema_name: string; table_name: string }) => ({
      schema: row.schema_name,
      table: row.table_name,
    }),
  );
}

async function exportTable(options: {
  pool: sql.ConnectionPool;
  schema: string;
  table: string;
  outputPath: string;
  rowLimit?: number;
}): Promise<{ rowCount: number; bytes: number }> {
  const { pool, schema, table, outputPath, rowLimit } = options;
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  const tmpPath = `${outputPath}.partial`;

  if (fs.existsSync(tmpPath)) {
    fs.unlinkSync(tmpPath);
  }

  const limit =
    rowLimit && rowLimit > 0 ? `TOP (${Math.floor(rowLimit)}) ` : '';
  const query = `SELECT ${limit}* FROM ${quoteIdent(schema)}.${quoteIdent(
    table,
  )}`;
  const request = pool.request();
  request.stream = true;

  let headers: string[] = [];
  let rowCount = 0;
  const readable = new Readable({
    read() {
      request.resume();
    },
  });

  request.on('recordset', (columns: Record<string, unknown>) => {
    headers = Object.keys(columns);

    if (!readable.push(`${headers.map((name) => csvCell(name)).join(',')}\n`)) {
      request.pause();
    }
  });
  request.on('row', (row: Record<string, unknown>) => {
    rowCount += 1;
    const line = `${headers.map((name) => csvCell(row[name])).join(',')}\n`;

    if (!readable.push(line)) {
      request.pause();
    }
  });
  request.on('error', (error: Error) => {
    readable.destroy(error);
  });
  request.on('done', () => {
    readable.push(null);
  });

  const gzip = createGzip({ level: 6 });
  const out = fs.createWriteStream(tmpPath);

  try {
    await Promise.all([pipeline(readable, gzip, out), request.query(query)]);
  } catch (error) {
    if (fs.existsSync(tmpPath)) {
      fs.unlinkSync(tmpPath);
    }

    throw error;
  }

  if (rowCount === 0) {
    fs.unlinkSync(tmpPath);

    return { rowCount: 0, bytes: 0 };
  }

  const bytes = fs.statSync(tmpPath).size;
  fs.renameSync(tmpPath, outputPath);

  return { rowCount, bytes };
}

export async function backupMssqlSnapshot(options: {
  source: SourceConfig;
  database: string;
  backupDir: string;
  runId: string;
  devRowLimit?: number;
  statementTimeoutMs?: number;
}): Promise<DatabaseRunResult> {
  const {
    source,
    database,
    backupDir,
    runId,
    devRowLimit = 0,
    statementTimeoutMs = 0,
  } = options;
  const rowLimit = devRowLimit > 0 ? devRowLimit : undefined;
  const skippedTables: SkippedTable[] = [];
  const emptyTables: TableRef[] = [];
  const chunks: ChunkResult[] = [];
  const captured = new Date().toISOString();

  let state = loadState(backupDir, database, 'snapshot');
  const watermarkBefore = state.watermark;
  let pending = beginOrResumePending(state, captured, runId);
  state = persistPending(backupDir, database, state, pending);

  const pool = new sql.ConnectionPool({
    server: source.host,
    port: source.port,
    user: source.user,
    password: source.password,
    database,
    connectionTimeout: 15_000,
    requestTimeout: statementTimeoutMs > 0 ? statementTimeoutMs : 0,
    options: {
      encrypt: false,
      trustServerCertificate: true,
    },
  });

  try {
    await pool.connect();
    const tables = await listUserTables(pool);
    const outDir = path.join(backupDir, 'runs', runId, database, 'full');

    for (const table of tables) {
      const key = `full:${table.schema}.${table.table}`;

      if (pending.completedChunkKeys.includes(key)) {
        continue;
      }

      const outputPath = path.join(
        outDir,
        `${table.schema}.${table.table}.csv.gz`,
      );

      try {
        // Sequential so a failed table does not overlap writes on one connection.
        // eslint-disable-next-line no-await-in-loop
        const exported = await exportTable({
          pool,
          schema: table.schema,
          table: table.table,
          outputPath,
          rowLimit,
        });

        if (exported.rowCount === 0) {
          emptyTables.push({ schema: table.schema, table: table.table });
          continue;
        }

        chunks.push({
          key,
          file: outputPath,
          rowCount: exported.rowCount,
          bytes: exported.bytes,
          fromExclusive: '0',
          toInclusive: 'full',
        });
        pending = markChunkComplete(pending, key);
        state = persistPending(backupDir, database, state, pending);
      } catch (error) {
        skippedTables.push({
          schema: table.schema,
          table: table.table,
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    }

    state = commitWatermark(state, pending.captured);
    saveState(backupDir, database, state);

    return {
      database,
      group: source.group,
      profile: 'snapshot',
      status: 'ok',
      watermarkBefore,
      captured: pending.captured,
      watermarkAfter: state.watermark,
      chunks,
      skippedTables,
      emptyTables,
    };
  } finally {
    await pool.close();
  }
}
