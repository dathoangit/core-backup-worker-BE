import fs from 'node:fs';
import path from 'node:path';

import {
  type BackupProfile,
  type DatabaseState,
  type PendingState,
} from '../types';

function stateDir(backupDir: string): string {
  return path.join(backupDir, 'state');
}

function statePath(backupDir: string, database: string): string {
  return path.join(stateDir(backupDir), `${database}.json`);
}

export function defaultState(profile: BackupProfile): DatabaseState {
  return {
    watermark: null,
    pending: null,
    initialFullDone: false,
    profile,
    updatedAt: new Date().toISOString(),
  };
}

export function loadState(
  backupDir: string,
  database: string,
  profile: BackupProfile,
): DatabaseState {
  const file = statePath(backupDir, database);

  if (!fs.existsSync(file)) {
    return defaultState(profile);
  }

  const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as DatabaseState;

  return {
    watermark: parsed.watermark ?? null,
    pending: parsed.pending ?? null,
    initialFullDone: Boolean(parsed.initialFullDone),
    profile: parsed.profile ?? profile,
    updatedAt: parsed.updatedAt ?? new Date().toISOString(),
  };
}

export function saveState(
  backupDir: string,
  database: string,
  state: DatabaseState,
): void {
  fs.mkdirSync(stateDir(backupDir), { recursive: true });
  const next: DatabaseState = {
    ...state,
    updatedAt: new Date().toISOString(),
  };
  fs.writeFileSync(
    statePath(backupDir, database),
    `${JSON.stringify(next, null, 2)}\n`,
    'utf8',
  );
}

export function beginOrResumePending(
  state: DatabaseState,
  captured: string,
  runId: string,
): PendingState {
  if (state.pending && state.pending.captured === captured) {
    return state.pending;
  }

  if (state.pending) {
    // Resume an unfinished capture window instead of expanding mid-flight.
    return state.pending;
  }

  return {
    captured,
    runId,
    completedChunkKeys: [],
  };
}

export function markChunkComplete(
  pending: PendingState,
  chunkKey: string,
): PendingState {
  if (pending.completedChunkKeys.includes(chunkKey)) {
    return pending;
  }

  return {
    ...pending,
    completedChunkKeys: [...pending.completedChunkKeys, chunkKey],
  };
}

export function commitWatermark(
  state: DatabaseState,
  captured: string,
): DatabaseState {
  return {
    ...state,
    watermark: captured,
    pending: null,
    initialFullDone: true,
  };
}
