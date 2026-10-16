import fs from 'node:fs';
import path from 'node:path';

const LOCK_FILE = 'backup.lock';

export interface LockHandle {
  release: () => void;
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

export function acquireLock(backupDir: string): LockHandle | null {
  fs.mkdirSync(backupDir, { recursive: true });
  const lockPath = path.join(backupDir, LOCK_FILE);

  if (fs.existsSync(lockPath)) {
    try {
      const raw = fs.readFileSync(lockPath, 'utf8').trim();
      const existingPid = Number.parseInt(raw, 10);

      if (isProcessAlive(existingPid)) {
        return null;
      }
    } catch {
      // stale/corrupt lock — replace
    }

    fs.unlinkSync(lockPath);
  }

  const fd = fs.openSync(lockPath, 'wx');
  fs.writeFileSync(fd, `${process.pid}\n`, 'utf8');
  fs.closeSync(fd);

  return {
    release: () => {
      try {
        if (fs.existsSync(lockPath)) {
          const raw = fs.readFileSync(lockPath, 'utf8').trim();
          if (Number.parseInt(raw, 10) === process.pid) {
            fs.unlinkSync(lockPath);
          }
        }
      } catch {
        // ignore unlock races
      }
    },
  };
}
