import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const DEFAULT_LOCK_FILE = 'backup.lock';

/** Unique per process boot — avoids Docker PID 1 collisions across restarts. */
export const LOCK_OWNER_ID = randomUUID();

export interface LockPayload {
  ownerId: string;
  runId: string;
  pid: number;
  createdAt: string;
}

export interface LockHandle {
  release: () => void;
}

export interface AcquireLockOptions {
  runId: string;
  ownerId?: string;
  /** Relative to backupDir. Default: backup.lock */
  lockFileName?: string;
}

function isProcessAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) {
    return false;
  }

  try {
    process.kill(pid, 0);

    return true;
  } catch (error) {
    const err = error as NodeJS.ErrnoException;

    if (err.code === 'EPERM') {
      return true;
    }

    return false;
  }
}

function parseLockPayload(raw: string): LockPayload | null {
  const trimmed = raw.trim();

  if (!trimmed) {
    return null;
  }

  if (trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed) as Partial<LockPayload>;

      if (
        typeof parsed.ownerId === 'string' &&
        typeof parsed.runId === 'string' &&
        typeof parsed.pid === 'number'
      ) {
        return {
          ownerId: parsed.ownerId,
          runId: parsed.runId,
          pid: parsed.pid,
          createdAt:
            typeof parsed.createdAt === 'string'
              ? parsed.createdAt
              : new Date(0).toISOString(),
        };
      }
    } catch {
      return null;
    }

    return null;
  }

  // Legacy plain-PID lock files
  const pid = Number.parseInt(trimmed, 10);

  if (!Number.isFinite(pid)) {
    return null;
  }

  return {
    ownerId: '',
    runId: '',
    pid,
    createdAt: new Date(0).toISOString(),
  };
}

export function databaseLockFileName(database: string): string {
  const safe = database.replaceAll(/[^\w.-]/g, '_');

  return path.join('locks', `${safe}.lock`);
}

export function readLockPayload(
  backupDir: string,
  lockFileName: string = DEFAULT_LOCK_FILE,
): LockPayload | null {
  const lockPath = path.join(backupDir, lockFileName);

  if (!fs.existsSync(lockPath)) {
    return null;
  }

  try {
    return parseLockPayload(fs.readFileSync(lockPath, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * True when lock should block a new acquire.
 * - Different boot ownerId → stale (Docker PID reuse safe).
 * - Legacy PID-only + same pid as us → stale.
 * - Same ownerId → held by this process.
 * - Otherwise → held if pid still alive.
 */
export function isLockHeldByPeer(
  payload: LockPayload,
  ownerId: string = LOCK_OWNER_ID,
): boolean {
  if (payload.ownerId) {
    if (payload.ownerId !== ownerId) {
      return false;
    }

    return true;
  }

  if (payload.pid === process.pid) {
    return false;
  }

  return isProcessAlive(payload.pid);
}

/** Remove lock file when it is stale for this process. */
export function clearStaleLock(
  backupDir: string,
  ownerId: string = LOCK_OWNER_ID,
  lockFileName: string = DEFAULT_LOCK_FILE,
): boolean {
  const payload = readLockPayload(backupDir, lockFileName);

  if (!payload) {
    return false;
  }

  if (isLockHeldByPeer(payload, ownerId)) {
    return false;
  }

  const lockPath = path.join(backupDir, lockFileName);

  try {
    fs.unlinkSync(lockPath);

    return true;
  } catch {
    return false;
  }
}

/** Clear all stale per-database locks under locks/. */
export function clearStaleDatabaseLocks(
  backupDir: string,
  ownerId: string = LOCK_OWNER_ID,
): string[] {
  const locksDir = path.join(backupDir, 'locks');

  if (!fs.existsSync(locksDir)) {
    return [];
  }

  const cleared: string[] = [];

  for (const entry of fs.readdirSync(locksDir)) {
    if (!entry.endsWith('.lock')) {
      continue;
    }

    const lockFileName = path.join('locks', entry);

    if (clearStaleLock(backupDir, ownerId, lockFileName)) {
      cleared.push(entry.replace(/\.lock$/, ''));
    }
  }

  return cleared;
}

export function listHeldDatabaseLocks(
  backupDir: string,
  ownerId: string = LOCK_OWNER_ID,
): Array<{ database: string; payload: LockPayload }> {
  const locksDir = path.join(backupDir, 'locks');

  if (!fs.existsSync(locksDir)) {
    return [];
  }

  const held: Array<{ database: string; payload: LockPayload }> = [];

  for (const entry of fs.readdirSync(locksDir)) {
    if (!entry.endsWith('.lock')) {
      continue;
    }

    const lockFileName = path.join('locks', entry);
    const payload = readLockPayload(backupDir, lockFileName);

    if (payload && isLockHeldByPeer(payload, ownerId)) {
      held.push({
        database: entry.replace(/\.lock$/, ''),
        payload,
      });
    }
  }

  return held;
}

export function acquireLock(
  backupDir: string,
  options: AcquireLockOptions,
): LockHandle | null {
  const ownerId = options.ownerId ?? LOCK_OWNER_ID;
  const lockFileName = options.lockFileName ?? DEFAULT_LOCK_FILE;
  fs.mkdirSync(path.dirname(path.join(backupDir, lockFileName)), {
    recursive: true,
  });
  fs.mkdirSync(backupDir, { recursive: true });
  const lockPath = path.join(backupDir, lockFileName);

  if (fs.existsSync(lockPath)) {
    try {
      const existing = parseLockPayload(fs.readFileSync(lockPath, 'utf8'));

      if (existing && isLockHeldByPeer(existing, ownerId)) {
        return null;
      }
    } catch {
      // stale/corrupt lock — replace
    }

    try {
      fs.unlinkSync(lockPath);
    } catch {
      return null;
    }
  }

  const payload: LockPayload = {
    ownerId,
    runId: options.runId,
    pid: process.pid,
    createdAt: new Date().toISOString(),
  };

  try {
    const fd = fs.openSync(lockPath, 'wx');
    fs.writeFileSync(fd, `${JSON.stringify(payload)}\n`, 'utf8');
    fs.closeSync(fd);
  } catch {
    return null;
  }

  return {
    release: () => {
      try {
        if (!fs.existsSync(lockPath)) {
          return;
        }

        const current = parseLockPayload(fs.readFileSync(lockPath, 'utf8'));

        if (current?.ownerId === ownerId && current.runId === options.runId) {
          fs.unlinkSync(lockPath);
        }
      } catch {
        // ignore unlock races
      }
    },
  };
}

export function acquireDatabaseLock(
  backupDir: string,
  database: string,
  runId: string,
): LockHandle | null {
  return acquireLock(backupDir, {
    runId,
    lockFileName: databaseLockFileName(database),
  });
}
