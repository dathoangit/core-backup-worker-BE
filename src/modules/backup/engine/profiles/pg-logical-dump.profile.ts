import { createHash } from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

import { BackupCancelledError } from '../../errors/backup-cancelled.error';
import { type BackupProgressSink } from '../../progress/backup-progress.types';
import { type DatabaseRunResult, type SourceConfig } from '../../types';
import { spawnIsolated, waitForProcess } from '../compressed-writer';

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
 * Weekly logical dump via pg_dump -Fd --compress=zstd for fast parallel restore.
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

  progress?.onLog(`logical dump starting ${database}`);

  const args = [
    '-n',
    '19',
    'pg_dump',
    '-h',
    source.host,
    '-p',
    String(source.port),
    '-U',
    source.user,
    '-d',
    database,
    '-Fd',
    '-j',
    String(Math.max(1, jobs)),
    '--compress=zstd:3',
    '--no-owner',
    '--no-privileges',
    '-f',
    partialDir,
  ];

  if (preferredSchemas) {
    for (const schema of preferredSchemas) {
      args.push('-n', schema);
    }
  }

  for (const table of excludeTableData) {
    if (table.trim()) {
      args.push('--exclude-table-data', table.trim());
    }
  }

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
      skippedTables: [],
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
      skippedTables: [],
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    signal?.removeEventListener('abort', abortHandler);
  }
}
