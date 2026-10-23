import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from '@jest/globals';

import {
  acquireDatabaseLock,
  clearStaleDatabaseLocks,
  databaseLockFileName,
  listHeldDatabaseLocks,
} from './lock';

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'db-lock-'));
  tempDirs.push(dir);

  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();

    if (dir) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe('per-database locks', () => {
  it('allows different databases concurrently', () => {
    const dir = makeTempDir();
    const a = acquireDatabaseLock(dir, 'produce', 'run-a');
    const b = acquireDatabaseLock(dir, 'signer', 'run-b');
    expect(a).toBeTruthy();
    expect(b).toBeTruthy();
    a!.release();
    b!.release();
  });

  it('blocks same database for a second run', () => {
    const dir = makeTempDir();
    const first = acquireDatabaseLock(dir, 'produce', 'run-a');
    expect(first).toBeTruthy();
    const second = acquireDatabaseLock(dir, 'produce', 'run-b');
    expect(second).toBeNull();
    first!.release();
    const third = acquireDatabaseLock(dir, 'produce', 'run-c');
    expect(third).toBeTruthy();
    third!.release();
  });

  it('lists held locks and clears stale ones', () => {
    const dir = makeTempDir();
    const lockPath = path.join(dir, databaseLockFileName('produce'));
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    fs.writeFileSync(
      lockPath,
      `${JSON.stringify({
        ownerId: 'other-boot',
        runId: 'old',
        pid: 999_999_999,
        createdAt: new Date().toISOString(),
      })}\n`,
      'utf8',
    );

    expect(listHeldDatabaseLocks(dir, 'this-boot')).toHaveLength(0);
    expect(clearStaleDatabaseLocks(dir, 'this-boot')).toContain('produce');
  });
});
