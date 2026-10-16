import type { Client } from 'pg';

import { quoteIdent } from './copy-writer';
import type { SkippedTable, TableRef } from '../types';

export interface ReadableTable extends TableRef {
  estimatedBytes: number;
}

export async function listReadableTables(
  client: Client,
  preferredSchemas: string[],
): Promise<{ tables: ReadableTable[]; skipped: SkippedTable[] }> {
  const result = await client.query<{
    schema: string;
    table: string;
    can_select: boolean;
    relpages: string;
  }>(
    `
    SELECT
      n.nspname AS schema,
      c.relname AS table,
      has_table_privilege(c.oid, 'SELECT') AS can_select,
      c.relpages::text AS relpages
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relkind = 'r'
      AND n.nspname = ANY($1::text[])
    ORDER BY n.nspname, c.relname
    `,
    [preferredSchemas],
  );

  const tables: ReadableTable[] = [];
  const skipped: SkippedTable[] = [];

  for (const row of result.rows) {
    if (!row.can_select) {
      skipped.push({
        schema: row.schema,
        table: row.table,
        reason: 'no SELECT privilege',
      });
      continue;
    }

    tables.push({
      schema: row.schema,
      table: row.table,
      estimatedBytes: Number(row.relpages) * 8192,
    });
  }

  return { tables, skipped };
}

export async function findSchemas(
  client: Client,
  candidates: string[],
): Promise<string[]> {
  const result = await client.query<{ nspname: string }>(
    `
    SELECT nspname
    FROM pg_namespace
    WHERE nspname = ANY($1::text[])
      AND has_schema_privilege(nspname, 'USAGE')
    ORDER BY nspname
    `,
    [candidates],
  );
  return result.rows.map((r) => r.nspname);
}

export async function tableHasColumn(
  client: Client,
  schema: string,
  table: string,
  column: string,
): Promise<boolean> {
  const result = await client.query(
    `
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = $1
      AND table_name = $2
      AND column_name = $3
    LIMIT 1
    `,
    [schema, table, column],
  );
  return result.rowCount !== null && result.rowCount > 0;
}

export async function getPrimaryKeyColumns(
  client: Client,
  schema: string,
  table: string,
): Promise<string[]> {
  const result = await client.query<{ column_name: string }>(
    `
    SELECT a.attname AS column_name
    FROM pg_index i
    JOIN pg_class c ON c.oid = i.indrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = ANY(i.indkey)
    WHERE i.indisprimary
      AND n.nspname = $1
      AND c.relname = $2
    ORDER BY array_position(i.indkey, a.attnum)
    `,
    [schema, table],
  );
  return result.rows.map((r) => r.column_name);
}

export async function captureMaxId(
  client: Client,
  schema: string,
  table: string,
  idColumn: string,
): Promise<bigint> {
  const result = await client.query<{ max: string | null }>(
    `
    SELECT max(${quoteIdent(idColumn)})::text AS max
    FROM ${quoteIdent(schema)}.${quoteIdent(table)}
    `,
  );
  const max = result.rows[0]?.max;
  return max ? BigInt(max) : 0n;
}

export async function captureTipByOrder(
  client: Client,
  schema: string,
  table: string,
  idColumn: string,
): Promise<bigint> {
  const result = await client.query<{ id: string | null }>(
    `
    SELECT ${quoteIdent(idColumn)}::text AS id
    FROM ${quoteIdent(schema)}.${quoteIdent(table)}
    ORDER BY ${quoteIdent(idColumn)} DESC
    LIMIT 1
    `,
  );
  const id = result.rows[0]?.id;
  return id ? BigInt(id) : 0n;
}
