import { createHash } from 'node:crypto';
import fs from 'node:fs';

import { type Client } from 'pg';
import { to as copyTo } from 'pg-copy-streams';

import { type ChunkResult } from '../types';
import { writeStreamToCompressedFile } from './compressed-writer';

export function quoteIdent(ident: string): string {
  return `"${ident.replaceAll('"', '""')}"`;
}

export function qualifyTable(schema: string, table: string): string {
  return `${quoteIdent(schema)}.${quoteIdent(table)}`;
}

/**
 * Wraps a SELECT so COPY only streams up to `rowLimit` rows.
 * Used for local/dev sample backups (BACKUP_DEV_ROW_LIMIT).
 */
export function withDevRowLimit(selectSql: string, rowLimit?: number): string {
  if (!rowLimit || rowLimit <= 0) {
    return selectSql;
  }

  return `SELECT * FROM (${selectSql}) AS _backup_dev_sample LIMIT ${Math.floor(
    rowLimit,
  )}`;
}

export async function hashFile(
  filePath: string,
): Promise<{ sha256: string; md5: string; bytes: number }> {
  const sha256 = createHash('sha256');
  const md5 = createHash('md5');
  const stream = fs.createReadStream(filePath);

  for await (const chunk of stream) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    sha256.update(Uint8Array.from(buf));
    md5.update(Uint8Array.from(buf));
  }

  const bytes = fs.statSync(filePath).size;

  return {
    sha256: sha256.digest('hex'),
    md5: md5.digest('hex'),
    bytes,
  };
}

export async function copyQueryToCompressedFile(
  client: Client,
  selectSql: string,
  outputPath: string,
  options?: {
    rowLimit?: number;
    onBytes?: (delta: number) => void;
    signal?: AbortSignal;
  },
): Promise<{ rowCount: number; bytes: number; sha256: string; md5: string }> {
  const limitedSql = withDevRowLimit(selectSql, options?.rowLimit);
  const copySql = `COPY (${limitedSql}) TO STDOUT WITH (FORMAT csv, HEADER true, ENCODING 'UTF8')`;
  const copyStream = client.query(copyTo(copySql));

  const { bytes, sha256, md5 } = await writeStreamToCompressedFile(
    copyStream,
    outputPath,
    {
      onBytes: options?.onBytes,
      signal: options?.signal,
    },
  );

  const rowCount =
    typeof (copyStream as { rowCount?: number }).rowCount === 'number'
      ? (copyStream as { rowCount: number }).rowCount
      : -1;

  return { rowCount, bytes, sha256, md5 };
}

/** @deprecated Use copyQueryToCompressedFile — kept for call-site compatibility. */
export const copyQueryToGzipFile = copyQueryToCompressedFile;

export async function copyTableChunk(options: {
  client: Client;
  schema: string;
  table: string;
  idColumn: string;
  fromExclusive: bigint;
  toInclusive: bigint;
  outputPath: string;
  chunkKey: string;
  rowLimit?: number;
  signal?: AbortSignal;
}): Promise<ChunkResult> {
  const {
    client,
    schema,
    table,
    idColumn,
    fromExclusive,
    toInclusive,
    outputPath,
    chunkKey,
    rowLimit,
    signal,
  } = options;

  const sql = `
    SELECT *
    FROM ${qualifyTable(schema, table)}
    WHERE ${quoteIdent(idColumn)} > ${fromExclusive.toString()}
      AND ${quoteIdent(idColumn)} <= ${toInclusive.toString()}
    ORDER BY ${quoteIdent(idColumn)}
  `;

  const { rowCount, bytes, sha256, md5 } = await copyQueryToCompressedFile(
    client,
    sql,
    outputPath,
    {
      rowLimit,
      signal,
    },
  );

  return {
    key: chunkKey,
    file: outputPath,
    rowCount,
    bytes,
    sha256,
    md5,
    fromExclusive: fromExclusive.toString(),
    toInclusive: toInclusive.toString(),
  };
}

export async function copyFullTable(options: {
  client: Client;
  schema: string;
  table: string;
  outputPath: string;
  rowLimit?: number;
  onBytes?: (delta: number) => void;
  signal?: AbortSignal;
}): Promise<{
  rowCount: number;
  bytes: number;
  file: string;
  sha256: string;
  md5: string;
}> {
  const { client, schema, table, outputPath, rowLimit, onBytes, signal } =
    options;
  const sql = `SELECT * FROM ${qualifyTable(schema, table)}`;
  const { rowCount, bytes, sha256, md5 } = await copyQueryToCompressedFile(
    client,
    sql,
    outputPath,
    {
      rowLimit,
      onBytes,
      signal,
    },
  );

  return { rowCount, bytes, file: outputPath, sha256, md5 };
}
