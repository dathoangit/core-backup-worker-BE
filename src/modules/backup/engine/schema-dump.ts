import fs from 'node:fs';
import path from 'node:path';

import {
  spawnIsolated,
  waitForProcess,
  writeStreamToCompressedFile,
} from './compressed-writer';
import { qualifyTable } from './copy-writer';

export function buildSchemaDumpArgs(options: {
  host: string;
  port: number;
  user: string;
  database: string;
  schemas?: string[];
  excludeTables?: Array<{ schema: string; table: string }>;
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
    '--schema-only',
    '--no-owner',
    '--no-privileges',
  ];

  if (options.schemas && options.schemas.length > 0) {
    for (const schema of options.schemas) {
      args.push('-n', schema);
    }
  }

  for (const table of options.excludeTables ?? []) {
    args.push('--exclude-table', qualifyTable(table.schema, table.table));
  }

  return args;
}

export async function dumpPostgresSchema(options: {
  host: string;
  port: number;
  user: string;
  password?: string;
  database: string;
  schemas?: string[];
  excludeTables?: Array<{ schema: string; table: string }>;
  outputPath: string;
  signal?: AbortSignal;
}): Promise<string> {
  const {
    host,
    port,
    user,
    password,
    database,
    schemas,
    excludeTables,
    outputPath,
    signal,
  } = options;

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });

  const args = buildSchemaDumpArgs({
    host,
    port,
    user,
    database,
    schemas,
    excludeTables,
  });

  const dumpProc = spawnIsolated('nice', args, {
    PGPASSWORD: password ?? '',
  });

  const abortHandler = (): void => {
    if (dumpProc.exitCode === null && !dumpProc.killed) {
      dumpProc.kill('SIGKILL');
    }
  };

  signal?.addEventListener('abort', abortHandler, { once: true });

  try {
    await Promise.all([
      writeStreamToCompressedFile(dumpProc.stdout!, outputPath, {
        signal,
      }),
      waitForProcess(dumpProc, 'pg_dump-schema', [0]),
    ]);
  } finally {
    signal?.removeEventListener('abort', abortHandler);
  }

  return outputPath;
}
