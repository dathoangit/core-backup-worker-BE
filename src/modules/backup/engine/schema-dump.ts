import fs from 'node:fs';
import path from 'node:path';

import {
  spawnIsolated,
  waitForProcess,
  writeStreamToCompressedFile,
} from './compressed-writer';

export async function dumpPostgresSchema(options: {
  host: string;
  port: number;
  user: string;
  password?: string;
  database: string;
  schemas?: string[];
  outputPath: string;
  signal?: AbortSignal;
}): Promise<string> {
  const { host, port, user, password, database, schemas, outputPath, signal } =
    options;

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });

  const args = [
    '-n',
    '19',
    'pg_dump',
    '-h',
    host,
    '-p',
    String(port),
    '-U',
    user,
    '-d',
    database,
    '--schema-only',
    '--no-owner',
    '--no-privileges',
  ];

  if (schemas && schemas.length > 0) {
    for (const schema of schemas) {
      args.push('-n', schema);
    }
  }

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
