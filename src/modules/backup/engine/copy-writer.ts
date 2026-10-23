import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGzip } from 'node:zlib';

import { type Client } from 'pg';
import { to as copyTo } from 'pg-copy-streams';

import { type ChunkResult } from '../types';

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
export function withDevRowLimit(
  selectSql: string,
  rowLimit: number | undefined,
): string {
  if (!rowLimit || rowLimit <= 0) {
    return selectSql;
  }

  return `SELECT * FROM (${selectSql}) AS _backup_dev_sample LIMIT ${Math.floor(
    rowLimit,
  )}`;
}

function createHashingTransform(): {
  transform: Transform;
  digests: () => { sha256: string; md5: string };
} {
  const sha256 = createHash('sha256');
  const md5 = createHash('md5');
  const transform = new Transform({
    transform(chunk, _encoding, callback) {
      sha256.update(chunk);
      md5.update(chunk);
      callback(null, chunk);
    },
  });

  return {
    transform,
    digests: () => ({
      sha256: sha256.digest('hex'),
      md5: md5.digest('hex'),
    }),
  };
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

export async function copyQueryToGzipFile(
  client: Client,
  selectSql: string,
  outputPath: string,
  options?: { rowLimit?: number },
): Promise<{ rowCount: number; bytes: number; sha256: string; md5: string }> {
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });

  const tmpPath = `${outputPath}.partial`;

  if (fs.existsSync(tmpPath)) {
    fs.unlinkSync(tmpPath);
  }

  const limitedSql = withDevRowLimit(selectSql, options?.rowLimit);
  const copySql = `COPY (${limitedSql}) TO STDOUT WITH (FORMAT csv, HEADER true, ENCODING 'UTF8')`;
  const copyStream = client.query(copyTo(copySql));
  const gzip = createGzip({ level: 6 });
  const hasher = createHashingTransform();
  const out = fs.createWriteStream(tmpPath);

  await pipeline(copyStream, gzip, hasher.transform, out);

  const bytes = fs.statSync(tmpPath).size;
  fs.renameSync(tmpPath, outputPath);

  const rowCount =
    typeof (copyStream as { rowCount?: number }).rowCount === 'number'
      ? (copyStream as { rowCount: number }).rowCount
      : -1;

  const { sha256, md5 } = hasher.digests();

  return { rowCount, bytes, sha256, md5 };
}

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
  } = options;

  const sql = `
    SELECT *
    FROM ${qualifyTable(schema, table)}
    WHERE ${quoteIdent(idColumn)} > ${fromExclusive.toString()}
      AND ${quoteIdent(idColumn)} <= ${toInclusive.toString()}
    ORDER BY ${quoteIdent(idColumn)}
  `;

  const { rowCount, bytes, sha256, md5 } = await copyQueryToGzipFile(
    client,
    sql,
    outputPath,
    {
      rowLimit,
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
}): Promise<{
  rowCount: number;
  bytes: number;
  file: string;
  sha256: string;
  md5: string;
}> {
  const { client, schema, table, outputPath, rowLimit } = options;
  const sql = `SELECT * FROM ${qualifyTable(schema, table)}`;
  const { rowCount, bytes, sha256, md5 } = await copyQueryToGzipFile(
    client,
    sql,
    outputPath,
    {
      rowLimit,
    },
  );

  return { rowCount, bytes, file: outputPath, sha256, md5 };
}
