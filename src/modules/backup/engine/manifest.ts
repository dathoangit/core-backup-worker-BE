import fs from 'node:fs';
import path from 'node:path';

import type { DatabaseRunResult, RunManifest } from '../types';

export function createRunId(now = new Date()): string {
  const iso = now.toISOString().replace(/[:.]/g, '-');
  return iso;
}

export function runDir(backupDir: string, runId: string): string {
  return path.join(backupDir, 'runs', runId);
}

export function ensureRunDir(backupDir: string, runId: string): string {
  const dir = runDir(backupDir, runId);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function writeManifest(backupDir: string, manifest: RunManifest): void {
  const dir = ensureRunDir(backupDir, manifest.runId);
  fs.writeFileSync(
    path.join(dir, 'manifest.json'),
    `${JSON.stringify(manifest, null, 2)}\n`,
    'utf8',
  );
}

export function upsertDatabaseResult(
  manifest: RunManifest,
  result: DatabaseRunResult,
): RunManifest {
  const others = manifest.databases.filter((d) => d.database !== result.database);
  return {
    ...manifest,
    databases: [...others, result],
  };
}
