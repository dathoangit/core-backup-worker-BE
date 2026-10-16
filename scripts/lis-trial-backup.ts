/* eslint-disable no-console, unicorn/prefer-top-level-await */
import fs from 'node:fs';
import path from 'node:path';
import { gzipSync } from 'node:zlib';

import { config as loadEnv } from 'dotenv';
import sql from 'mssql';

loadEnv();

const ROWS_PER_TABLE = 20;
const OUTPUT_ROOT = path.resolve(__dirname, '../../.backup-dev/lis-trial');

const REQUIRED_ENV = [
  'LIS_HOST',
  'LIS_USER',
  'LIS_PASSWORD',
  'LIS_DATABASES',
] as const;

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

function toCsv(
  rows: Array<Record<string, unknown>>,
  columns: string[],
): string {
  const headers = columns.length > 0 ? columns : Object.keys(rows[0] ?? {});
  const lines = [
    headers.map((name) => csvCell(name)).join(','),
    ...rows.map((row) => headers.map((name) => csvCell(row[name])).join(',')),
  ];

  return `${lines.join('\n')}\n`;
}

function readConfig(database: string): sql.config {
  const missing = REQUIRED_ENV.filter((key) => !process.env[key]);

  if (missing.length > 0) {
    throw new Error(`Missing required env: ${missing.join(', ')}`);
  }

  const port = Number(process.env.LIS_PORT ?? 1433);

  if (!Number.isInteger(port) || port <= 0) {
    throw new Error(`Invalid LIS_PORT: ${process.env.LIS_PORT}`);
  }

  return {
    server: process.env.LIS_HOST!,
    port,
    user: process.env.LIS_USER,
    password: process.env.LIS_PASSWORD,
    database,
    connectionTimeout: 15_000,
    requestTimeout: 60_000,
    options: {
      encrypt: false,
      trustServerCertificate: true,
    },
  };
}

async function sampleDatabase(database: string): Promise<void> {
  const pool = new sql.ConnectionPool(readConfig(database));
  const outDir = path.join(OUTPUT_ROOT, database);
  fs.mkdirSync(outDir, { recursive: true });

  try {
    await pool.connect();
    const listed = await pool.request().query(`
      SELECT s.name AS schema_name, t.name AS table_name
      FROM sys.tables AS t
      INNER JOIN sys.schemas AS s ON t.schema_id = s.schema_id
      WHERE t.is_ms_shipped = 0
      ORDER BY s.name, t.name
    `);

    let exported = 0;
    let empty = 0;

    for (const table of listed.recordset as Array<{
      schema_name: string;
      table_name: string;
    }>) {
      const query = `
        SELECT TOP (${ROWS_PER_TABLE}) *
        FROM ${quoteIdent(table.schema_name)}.${quoteIdent(table.table_name)}
      `;

      try {
        // eslint-disable-next-line no-await-in-loop
        const rows = await pool.request().query(query);
        const recordset = rows.recordset as sql.IRecordSet<
          Record<string, unknown>
        >;

        if (recordset.length === 0) {
          empty += 1;
          continue;
        }

        const fileName = `${table.schema_name}.${table.table_name}.csv.gz`;
        const csv = toCsv(recordset, Object.keys(recordset.columns));
        fs.writeFileSync(path.join(outDir, fileName), gzipSync(csv));
        exported += 1;
        console.log(`${database}/${fileName} rows=${recordset.length}`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(
          `${database}/${table.schema_name}.${table.table_name} skipped: ${message}`,
        );
      }
    }

    console.log(`${database}: exported=${exported} empty=${empty}`);
  } finally {
    await pool.close();
  }
}

async function main(): Promise<void> {
  const databases = (process.env.LIS_DATABASES ?? '')
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);

  fs.rmSync(OUTPUT_ROOT, { recursive: true, force: true });
  fs.mkdirSync(OUTPUT_ROOT, { recursive: true });
  console.log(`Trial folder: ${OUTPUT_ROOT}`);
  console.log(`Sample: every user table, up to ${ROWS_PER_TABLE} rows each`);

  for (const database of databases) {
    // eslint-disable-next-line no-await-in-loop
    await sampleDatabase(database);
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`LIS trial backup failed: ${message}`);
  process.exitCode = 1;
});
