import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { type DatabaseRunResult } from '../types';

function hashFileHex(filePath: string): string {
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

/**
 * Write a sha256sum-compatible sidecar from in-memory chunk digests.
 * Chunk files are not re-read; schema dump (if present) is hashed once.
 */
export async function writeDatabaseSha256Sums(
  dbRunDir: string,
  result: DatabaseRunResult,
): Promise<string | null> {
  const lines: string[] = [];

  for (const chunk of result.chunks) {
    if (!chunk.sha256 || !chunk.file) {
      continue;
    }

    const rel = path.relative(dbRunDir, chunk.file).replaceAll('\\', '/');
    lines.push(`${chunk.sha256}  ${rel}`);
  }

  for (const candidate of [
    path.join(dbRunDir, 'schema', 'schema.sql.zst'),
    path.join(dbRunDir, 'schema', 'schema.sql.gz'),
  ]) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
      const rel = path.relative(dbRunDir, candidate).replaceAll('\\', '/');
      lines.push(`${hashFileHex(candidate)}  ${rel}`);
      break;
    }
  }

  if (lines.length === 0) {
    return null;
  }

  fs.mkdirSync(dbRunDir, { recursive: true });
  const outPath = path.join(dbRunDir, 'SHA256SUMS');
  fs.writeFileSync(outPath, `${lines.join('\n')}\n`, { mode: 0o600 });

  return outPath;
}
