import { createHash } from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

import { Client } from 'pg';

import { BackupCancelledError } from '../../errors/backup-cancelled.error';
import { type BackupProgressSink } from '../../progress/backup-progress.types';
import {
  type DatabaseRunResult,
  type SkippedTable,
  type SourceConfig,
  type TableRef,
} from '../../types';
import { spawnIsolated, waitForProcess } from '../compressed-writer';
import { qualifyTable } from '../copy-writer';
import { listRelationsWithoutDumpAccess } from '../schema';

function hashFileSync(filePath: string): string {
  const hash = createHash('sha256');
  const fd = fs.openSync(filePath, 'r');
  const buf = new Uint8Array(64 * 1024);

  try {
    let bytes = 0;

    while ((bytes = fs.readSync(fd, buf, 0, buf.length, null)) > 0) {
      hash.update(buf.subarray(0, bytes));
    }
  } finally {
    fs.closeSync(fd);
  }

  return hash.digest('hex');
}

async function hashTree(dir: string, base: string): Promise<string[]> {
  const lines: string[] = [];
  const entries = await fsp.readdir(dir, { withFileTypes: true });

  for (const entry of [...entries].sort((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    const full = path.join(dir, entry.name);
    const rel = path.relative(base, full).replaceAll('\\', '/');

    if (entry.isDirectory()) {
      lines.push(...(await hashTree(full, base)));
    } else if (entry.isFile()) {
      lines.push(`${hashFileSync(full)}  ${rel}`);
    }
  }

  return lines;
}

/**
 * pg_dump arguments for a directory-format dump.
 * Relations the role cannot SELECT are excluded so one missing GRANT does not
 * abort the dump of everything else that was granted.
 */
export function buildLogicalDumpArgs(options: {
  host: string;
  port: number;
  user: string;
  database: string;
  jobs: number;
  outputDir: string;
  preferredSchemas?: string[];
  excludeTableData: string[];
  excludeRelations: TableRef[];
}): string[] {
  const args = [
    '-n',
    '19',
    'pg_dump',
    '-h',
    options.host,
    '-p',
    String(options.port),
    '-U',
    options.user,
    '-d',
    options.database,
    '-Fd',
    '-j',
    String(Math.max(1, options.jobs)),
    '--compress=zstd:3',
    '--no-owner',
    '--no-privileges',
    '-f',
    options.outputDir,
  ];

  if (options.preferredSchemas) {
    for (const schema of options.preferredSchemas) {
      args.push('-n', schema);
    }
  }

  for (const table of options.excludeTableData) {
    if (table.trim()) {
      args.push('--exclude-table-data', table.trim());
    }
  }

  for (const relation of options.excludeRelations) {
    args.push('--exclude-table', qualifyTable(relation.schema, relation.table));
  }

  return args;
}

async function listExcludedRelations(
  source: SourceConfig,
  database: string,
): Promise<TableRef[]> {
  const client = new Client({
    host: source.host,
    port: source.port,
    user: source.user,
    password: source.password,
    database,
    connectionTimeoutMillis: 15_000,
  });

  await client.connect();

  try {
    return await listRelationsWithoutDumpAccess(client);
  } finally {
    await client.end();
  }
}

/**
 * Weekly logical dump via pg_dump -Fd --compress=zstd for fast parallel restore.
 * Only objects the backup role can already SELECT are included.
 */
export async function backupPgLogicalDump(options: {
  source: SourceConfig;
  database: string;
  backupDir: string;
  runId: string;
  jobs: number;
  excludeTableData: string[];
  preferredSchemas?: string[];
  signal?: AbortSignal;
  progress?: BackupProgressSink | null;
}): Promise<DatabaseRunResult> {
  const {
    source,
    database,
    backupDir,
    runId,
    jobs,
    excludeTableData,
    preferredSchemas,
    signal,
    progress,
  } = options;

  const finalDir = path.join(backupDir, 'runs', runId, database, 'logical');
  const partialDir = `${finalDir}.partial`;

  if (fs.existsSync(partialDir)) {
    fs.rmSync(partialDir, { recursive: true, force: true });
  }

  fs.mkdirSync(path.dirname(partialDir), { recursive: true });

  const excludeRelations = await listExcludedRelations(source, database);
  const skippedTables: SkippedTable[] = excludeRelations.map((relation) => ({
    schema: relation.schema,
    table: relation.table,
    reason: 'no SELECT privilege',
  }));

  if (skippedTables.length > 0) {
    const preview = skippedTables
      .slice(0, 20)
      .map((relation) => `${relation.schema}.${relation.table}`)
      .join(', ');
    const suffix =
      skippedTables.length > 20 ? ` (+${skippedTables.length - 20} more)` : '';
    progress?.onLog(
      `logical dump skipping ${skippedTables.length} relation(s) without SELECT: ${preview}${suffix}`,
      'warn',
    );
  }

  progress?.onLog(`logical dump starting ${database}`);

  const args = buildLogicalDumpArgs({
    host: source.host,
    port: source.port,
    user: source.user,
    database,
    jobs,
    outputDir: partialDir,
    preferredSchemas,
    excludeTableData,
    excludeRelations,
  });

  const dumpProc = spawnIsolated('nice', args, {
    PGPASSWORD: source.password ?? '',
  });

  const abortHandler = (): void => {
    if (dumpProc.exitCode === null && !dumpProc.killed) {
      dumpProc.kill('SIGKILL');
    }
  };

  signal?.addEventListener('abort', abortHandler, { once: true });

  try {
    if (signal?.aborted) {
      throw new BackupCancelledError(runId);
    }

    await waitForProcess(dumpProc, 'pg_dump-logical', [0]);

    // Verify TOC is readable
    const listProc = spawnIsolated('pg_restore', ['--list', partialDir]);
    await waitForProcess(listProc, 'pg_restore-list', [0]);

    const sums = await hashTree(partialDir, partialDir);
    await fsp.writeFile(
      path.join(partialDir, 'SHA256SUMS'),
      `${sums.join('\n')}\n`,
      { mode: 0o600 },
    );

    if (fs.existsSync(finalDir)) {
      fs.rmSync(finalDir, { recursive: true, force: true });
    }

    await fsp.rename(partialDir, finalDir);
    progress?.onLog(`logical dump complete ${database} -> ${finalDir}`);

    return {
      database,
      group: source.group,
      profile: source.group === 'HIS' ? 'adempiere' : 'envers',
      status: 'ok',
      watermarkBefore: null,
      captured: null,
      watermarkAfter: null,
      chunks: [
        {
          key: `logical:${database}`,
          file: finalDir,
          rowCount: -1,
          bytes: sums.length,
          sha256: createHash('sha256').update(sums.join('\\n')).digest('hex'),
          fromExclusive: '0',
          toInclusive: '0',
        },
      ],
      skippedTables,
    };
  } catch (error) {
    if (fs.existsSync(partialDir)) {
      fs.rmSync(partialDir, { recursive: true, force: true });
    }

    if (
      signal?.aborted ||
      (error instanceof Error &&
        /cancel|abort|terminat|query_canceled|57014/i.test(error.message))
    ) {
      throw new BackupCancelledError(runId);
    }

    return {
      database,
      group: source.group,
      profile: source.group === 'HIS' ? 'adempiere' : 'envers',
      status: 'error',
      watermarkBefore: null,
      captured: null,
      watermarkAfter: null,
      chunks: [],
      skippedTables,
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    signal?.removeEventListener('abort', abortHandler);
  }
}
