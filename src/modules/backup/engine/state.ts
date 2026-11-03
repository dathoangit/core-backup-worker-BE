import fs from 'node:fs';
import path from 'node:path';

import {
  type BackupMode,
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

/**
 * Legacy pending files (no mode) are treated as `full` so an interrupted
 * baseline is not adopted by a later incremental cron.
 */
export function effectivePendingMode(
  pending: PendingState | null | undefined,
): BackupMode | null {
  if (!pending) {
    return null;
  }

  return pending.mode ?? 'full';
}

export function pendingOwnedByMode(
  pending: PendingState | null | undefined,
  mode: BackupMode,
): boolean {
  if (!pending) {
    return true;
  }

  return effectivePendingMode(pending) === mode;
}

export function beginOrResumePending(
  state: DatabaseState,
  captured: string,
  runId: string,
  mode: BackupMode = 'incremental',
): PendingState {
  if (state.pending && pendingOwnedByMode(state.pending, mode)) {
    if (state.pending.captured === captured) {
      return { ...state.pending, mode };
    }

    // Resume an unfinished capture window instead of expanding mid-flight.
    return {
      ...state.pending,
      mode: state.pending.mode ?? mode,
    };
  }

  return {
    captured,
    runId,
    completedChunkKeys: [],
    mode,
  };
}

/**
 * Persist pending only when this mode owns the checkpoint. A foreign-mode
 * pending (e.g. interrupted full) stays on disk while incremental runs.
 */
export function persistPendingForMode(
  backupDir: string,
  database: string,
  state: DatabaseState,
  pending: PendingState,
  mode: BackupMode,
): DatabaseState {
  if (state.pending && !pendingOwnedByMode(state.pending, mode)) {
    return state;
  }

  const next = { ...state, pending };
  saveState(backupDir, database, next);

  return next;
}

/**
 * On cancel/error, only write pending when this mode owns the checkpoint.
 */
export function savePendingOnFailure(
  backupDir: string,
  database: string,
  state: DatabaseState,
  pending: PendingState,
  mode: BackupMode,
): void {
  if (state.pending && !pendingOwnedByMode(state.pending, mode)) {
    return;
  }

  saveState(backupDir, database, { ...state, pending });
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
  mode?: BackupMode,
): DatabaseState {
  const keepForeign =
    Boolean(mode) &&
    state.pending != null &&
    !pendingOwnedByMode(state.pending, mode!);

  return {
    ...state,
    watermark: captured,
    pending: keepForeign ? state.pending : null,
    initialFullDone: true,
  };
}
