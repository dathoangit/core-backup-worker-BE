import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGzip } from 'node:zlib';

import sql from 'mssql';

import { BackupCancelledError } from '../../errors/backup-cancelled.error';
import { type BackupProgressSink } from '../../progress/backup-progress.types';
import { type BackupCancelRegistry } from '../../queue/backup-cancel.registry';
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

const DEFAULT_LIS_CHUNK_ROWS = 500_000;

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

/** Single-column clustered PK / unique index suitable for keyset pagination. */
async function findKeysetColumn(
  pool: sql.ConnectionPool,
  schema: string,
  table: string,
): Promise<string | null> {
  const result = await pool
    .request()
    .input('schema', sql.NVarChar, schema)
    .input('table', sql.NVarChar, table).query(`
      SELECT TOP 1 c.name AS column_name
      FROM sys.indexes AS i
      INNER JOIN sys.index_columns AS ic
        ON i.object_id = ic.object_id AND i.index_id = ic.index_id
      INNER JOIN sys.columns AS c
        ON ic.object_id = c.object_id AND ic.column_id = c.column_id
      INNER JOIN sys.tables AS t ON i.object_id = t.object_id
      INNER JOIN sys.schemas AS s ON t.schema_id = s.schema_id
      INNER JOIN sys.types AS ty ON c.user_type_id = ty.user_type_id
      WHERE s.name = @schema
        AND t.name = @table
        AND i.is_unique = 1
        AND ic.key_ordinal = 1
        AND NOT EXISTS (
          SELECT 1
          FROM sys.index_columns AS ic2
          WHERE ic2.object_id = i.object_id
            AND ic2.index_id = i.index_id
            AND ic2.key_ordinal > 1
        )
        AND ty.name IN (
          'bigint', 'int', 'smallint', 'tinyint',
          'decimal', 'numeric', 'money', 'smallmoney',
          'uniqueidentifier', 'varchar', 'nvarchar', 'char', 'nchar',
          'date', 'datetime', 'datetime2', 'smalldatetime'
        )
      ORDER BY CASE WHEN i.is_primary_key = 1 THEN 0 ELSE 1 END, i.index_id
    `);

  const name = result.recordset[0]?.column_name;

  return typeof name === 'string' && name.length > 0 ? name : null;
}

interface StreamExportResult {
  rowCount: number;
  bytes: number;
  sha256: string;
  md5: string;
  lastKeyValue: unknown | undefined;
}

async function streamQueryToGzip(options: {
  pool: sql.ConnectionPool;
  query: string;
  outputPath: string;
  keyColumn?: string;
  onRequest?: (request: sql.Request) => void;
}): Promise<StreamExportResult> {
  const { pool, query, outputPath, keyColumn, onRequest } = options;
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  const tmpPath = `${outputPath}.partial`;

  if (fs.existsSync(tmpPath)) {
    fs.unlinkSync(tmpPath);
  }

  const request = pool.request();
  request.stream = true;
  onRequest?.(request);

  let headers: string[] = [];
  let rowCount = 0;
  let lastKeyValue: unknown;
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

    if (keyColumn) {
      lastKeyValue = row[keyColumn];
    }

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
  const sha256 = createHash('sha256');
  const md5 = createHash('md5');
  const hasher = new Transform({
    transform(chunk, _encoding, callback) {
      sha256.update(chunk);
      md5.update(chunk);
      callback(null, chunk);
    },
  });
  const out = fs.createWriteStream(tmpPath);

  try {
    await Promise.all([
      pipeline(readable, gzip, hasher, out),
      request.query(query),
    ]);
  } catch (error) {
    if (fs.existsSync(tmpPath)) {
      fs.unlinkSync(tmpPath);
    }

    throw error;
  }

  if (rowCount === 0) {
    fs.unlinkSync(tmpPath);

    return {
      rowCount: 0,
      bytes: 0,
      sha256: '',
      md5: '',
      lastKeyValue: undefined,
    };
  }

  const bytes = fs.statSync(tmpPath).size;
  fs.renameSync(tmpPath, outputPath);

  return {
    rowCount,
    bytes,
    sha256: sha256.digest('hex'),
    md5: md5.digest('hex'),
    lastKeyValue,
  };
}

function sqlLiteral(value: unknown): string {
  if (value === null || value === undefined) {
    return 'NULL';
  }

  if (typeof value === 'number' || typeof value === 'bigint') {
    return String(value);
  }

  if (value instanceof Date) {
    return `'${value.toISOString()}'`;
  }

  if (typeof value === 'boolean') {
    return value ? '1' : '0';
  }

  const text = String(value).replaceAll("'", "''");

  return `N'${text}'`;
}

export async function backupMssqlSnapshot(options: {
  source: SourceConfig;
  database: string;
  backupDir: string;
  runId: string;
  devRowLimit?: number;
  statementTimeoutMs?: number;
  chunkSize?: number;
  signal?: AbortSignal;
  progress?: BackupProgressSink;
  cancelRegistry?: BackupCancelRegistry;
}): Promise<DatabaseRunResult> {
  const {
    source,
    database,
    backupDir,
    runId,
    devRowLimit = 0,
    statementTimeoutMs = 0,
    chunkSize = DEFAULT_LIS_CHUNK_ROWS,
    signal,
    progress,
    cancelRegistry,
  } = options;
  const rowLimit = devRowLimit > 0 ? devRowLimit : undefined;
  const lisChunk =
    rowLimit && rowLimit > 0
      ? Math.min(chunkSize, rowLimit)
      : Math.max(1, chunkSize);
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

  let activeRequest: sql.Request | null = null;
  let activeSpid: number | null = null;
  const unregisterKiller = cancelRegistry?.registerKiller(runId, async () => {
    try {
      activeRequest?.cancel();
    } catch {
      // ignore
    }

    if (activeSpid != null) {
      try {
        const killPool = new sql.ConnectionPool({
          server: source.host,
          port: source.port,
          user: source.user,
          password: source.password,
          database,
          connectionTimeout: 10_000,
          requestTimeout: 10_000,
          options: { encrypt: false, trustServerCertificate: true },
        });
        await killPool.connect();

        try {
          await killPool.request().query(`KILL ${activeSpid}`);
        } finally {
          await killPool.close();
        }
      } catch (error) {
        // ALTER ANY CONNECTION may be missing — request.cancel is the primary path
        progress?.onLog(
          `KILL ${activeSpid} failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
          'warn',
        );
      }
    }
  });

  try {
    await pool.connect();
    const tables = await listUserTables(pool);
    const outDir = path.join(backupDir, 'runs', runId, database, 'full');
    let tablesDone = 0;

    for (const table of tables) {
      if (signal?.aborted) {
        throw new BackupCancelledError(runId);
      }

      const qualified = `${table.schema}.${table.table}`;
      progress?.onTableProgress({
        database,
        table: qualified,
        tablesDone,
        tablesTotal: tables.length,
      });

      try {
        const keyColumn = await findKeysetColumn(
          pool,
          table.schema,
          table.table,
        );

        if (keyColumn) {
          let lastValue: unknown;
          let seq = 0;
          let tableRows = 0;

          // Resume: find highest completed seq for this table
          for (const completed of pending.completedChunkKeys) {
            const match = completed.match(
              new RegExp(`^full:${qualified.replaceAll('.', '\\.')}:(\\d+)$`),
            );

            if (match) {
              seq = Math.max(seq, Number.parseInt(match[1], 10));
            }
          }

          // eslint-disable-next-line no-constant-condition
          while (true) {
            if (signal?.aborted) {
              throw new BackupCancelledError(runId);
            }

            const nextSeq = seq + 1;
            const key = `full:${qualified}:${nextSeq}`;

            if (pending.completedChunkKeys.includes(key)) {
              seq = nextSeq;
              continue;
            }

            const where =
              lastValue === undefined
                ? ''
                : ` WHERE ${quoteIdent(keyColumn)} > ${sqlLiteral(lastValue)}`;
            const query = `
              SELECT TOP (${lisChunk}) *
              FROM ${quoteIdent(table.schema)}.${quoteIdent(table.table)}
              ${where}
              ORDER BY ${quoteIdent(keyColumn)}
            `;

            const outputPath = path.join(
              outDir,
              `${qualified}.${String(nextSeq).padStart(6, '0')}.csv.gz`,
            );

            const spidResult = await pool
              .request()
              .query('SELECT @@SPID AS spid');
            activeSpid = Number(spidResult.recordset[0]?.spid) || null;

            const exported = await streamQueryToGzip({
              pool,
              query,
              outputPath,
              keyColumn,
              onRequest: (request) => {
                activeRequest = request;
              },
            });
            activeRequest = null;

            if (exported.rowCount === 0) {
              if (nextSeq === 1 && tableRows === 0) {
                emptyTables.push({ schema: table.schema, table: table.table });
              }

              break;
            }

            chunks.push({
              key,
              file: outputPath,
              rowCount: exported.rowCount,
              bytes: exported.bytes,
              sha256: exported.sha256,
              md5: exported.md5,
              fromExclusive: lastValue === undefined ? '0' : String(lastValue),
              toInclusive: String(exported.lastKeyValue ?? ''),
            });
            pending = markChunkComplete(pending, key);
            state = persistPending(backupDir, database, state, pending);
            lastValue = exported.lastKeyValue;
            seq = nextSeq;
            tableRows += exported.rowCount;
            progress?.onTableProgress({
              database,
              table: qualified,
              tablesDone,
              tablesTotal: tables.length,
              rowsDelta: exported.rowCount,
              bytesDelta: exported.bytes,
            });

            if (rowLimit && tableRows >= rowLimit) {
              break;
            }

            if (exported.rowCount < lisChunk) {
              break;
            }
          }
        } else {
          const key = `full:${qualified}`;

          if (pending.completedChunkKeys.includes(key)) {
            tablesDone += 1;
            continue;
          }

          progress?.onLog(
            `${qualified}: no single-column key — full stream fallback`,
            'warn',
          );

          const outputPath = path.join(outDir, `${qualified}.csv.gz`);
          const limit =
            rowLimit && rowLimit > 0 ? `TOP (${Math.floor(rowLimit)}) ` : '';
          const query = `SELECT ${limit}* FROM ${quoteIdent(
            table.schema,
          )}.${quoteIdent(table.table)}`;

          const spidResult = await pool
            .request()
            .query('SELECT @@SPID AS spid');
          activeSpid = Number(spidResult.recordset[0]?.spid) || null;

          const exported = await streamQueryToGzip({
            pool,
            query,
            outputPath,
            onRequest: (request) => {
              activeRequest = request;
            },
          });
          activeRequest = null;

          if (exported.rowCount === 0) {
            emptyTables.push({ schema: table.schema, table: table.table });
          } else {
            chunks.push({
              key,
              file: outputPath,
              rowCount: exported.rowCount,
              bytes: exported.bytes,
              sha256: exported.sha256,
              md5: exported.md5,
              fromExclusive: '0',
              toInclusive: 'full',
            });
            pending = markChunkComplete(pending, key);
            state = persistPending(backupDir, database, state, pending);
            progress?.onTableProgress({
              database,
              table: qualified,
              tablesDone: tablesDone + 1,
              tablesTotal: tables.length,
              rowsDelta: exported.rowCount,
              bytesDelta: exported.bytes,
            });
          }
        }
      } catch (error) {
        if (
          signal?.aborted ||
          (error instanceof Error &&
            /cancel|abort|timeout|terminated/i.test(error.message))
        ) {
          throw new BackupCancelledError(runId);
        }

        skippedTables.push({
          schema: table.schema,
          table: table.table,
          reason: error instanceof Error ? error.message : String(error),
        });
      }

      tablesDone += 1;
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
    unregisterKiller?.();
    await pool.close();
  }
}
