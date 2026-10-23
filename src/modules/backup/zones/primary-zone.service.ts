import fs from 'node:fs';
import path from 'node:path';

import { Injectable } from '@nestjs/common';

import { BackupConfigService } from '../backup-config.service';
import {
  type BackupVolumeDirs,
  volumeDirForDatabase,
  volumeRoots,
} from '../backup-paths';
import {
  isLockHeldByPeer,
  listHeldDatabaseLocks,
  LOCK_OWNER_ID,
  readLockPayload,
} from '../engine/lock';
import { loadState } from '../engine/state';
import { type BackupProfile } from '../types';

export interface PrimaryZoneStatus {
  /** Meta volume (lock). */
  backupDir: string;
  volumes: {
    meta: string;
    his: string;
    emr: string;
    lis: string;
  };
  exists: boolean;
  lockHeld: boolean;
  lockPid: number | null;
  runCount: number;
  stateDatabases: string[];
  freeHint: string | null;
}

@Injectable()
export class PrimaryZoneService {
  constructor(private readonly backupConfig: BackupConfigService) {}

  async getBackupDir(): Promise<string> {
    return (await this.backupConfig.getSettings()).backupDir;
  }

  async getVolumeDirs(): Promise<BackupVolumeDirs> {
    return (await this.backupConfig.getSettings()).volumeDirs;
  }

  async volumeDirForDatabase(database: string): Promise<string> {
    const volumeDirs = await this.getVolumeDirs();

    return volumeDirForDatabase(volumeDirs, database);
  }

  async ensureLayout(): Promise<void> {
    const settings = await this.backupConfig.getSettings();
    const roots = [settings.backupDir, ...volumeRoots(settings.volumeDirs)];

    for (const root of roots) {
      fs.mkdirSync(path.join(root, 'runs'), { recursive: true });
      fs.mkdirSync(path.join(root, 'state'), { recursive: true });
      fs.mkdirSync(path.join(root, 'snapshots'), { recursive: true });
    }

    fs.mkdirSync(path.join(settings.backupDir, 'locks'), { recursive: true });
  }

  async getStatus(): Promise<PrimaryZoneStatus> {
    let settings;

    try {
      settings = await this.backupConfig.getSettings();
    } catch {
      return {
        backupDir: '',
        volumes: { meta: '', his: '', emr: '', lis: '' },
        exists: false,
        lockHeld: false,
        lockPid: null,
        runCount: 0,
        stateDatabases: [],
        freeHint: 'Backup volumes not configured (BACKUP_ROOT / VOLUME_*)',
      };
    }

    const metaDir = settings.backupDir;
    const exists = fs.existsSync(metaDir);
    let lockHeld = false;
    let lockPid: number | null = null;

    const payload = readLockPayload(metaDir);

    if (payload) {
      lockPid = payload.pid;
      lockHeld = isLockHeldByPeer(payload, LOCK_OWNER_ID);
    }

    const dbLocks = listHeldDatabaseLocks(metaDir, LOCK_OWNER_ID);

    if (dbLocks.length > 0) {
      lockHeld = true;
      lockPid = dbLocks[0]?.payload.pid ?? lockPid;
    }

    const runIds = await this.listRunIds();
    const stateDatabases = this.listStateDatabases(
      volumeRoots(settings.volumeDirs),
    );

    return {
      backupDir: metaDir,
      volumes: {
        meta: metaDir,
        his: settings.volumeDirs.HIS,
        emr: settings.volumeDirs.EMR,
        lis: settings.volumeDirs.LIS,
      },
      exists,
      lockHeld,
      lockPid,
      runCount: runIds.length,
      stateDatabases,
      freeHint: settings.backupRoot ? `root=${settings.backupRoot}` : null,
    };
  }

  async readWatermark(
    database: string,
    profile: BackupProfile = 'adempiere',
  ): Promise<string | null> {
    try {
      const volumeDir = await this.volumeDirForDatabase(database);

      return loadState(volumeDir, database, profile).watermark;
    } catch {
      return null;
    }
  }

  async listRunIds(): Promise<string[]> {
    let volumeDirs: BackupVolumeDirs;
    let metaDir: string;

    try {
      const settings = await this.backupConfig.getSettings();
      volumeDirs = settings.volumeDirs;
      metaDir = settings.backupDir;
    } catch {
      return [];
    }

    const ids = new Set<string>();

    for (const root of [metaDir, ...volumeRoots(volumeDirs)]) {
      for (const id of this.listRunIdsUnder(root)) {
        ids.add(id);
      }
    }

    return [...ids].sort();
  }

  /**
   * Run directory on a specific volume (or meta when volume omitted).
   * Prefer {@link runDirForDatabase} when the database is known.
   */
  async runDir(runId: string, volumeRoot?: string): Promise<string> {
    const root = volumeRoot ?? (await this.getBackupDir());

    return path.join(root, 'runs', runId);
  }

  async runDirForDatabase(runId: string, database: string): Promise<string> {
    const volumeDir = await this.volumeDirForDatabase(database);

    return path.join(volumeDir, 'runs', runId);
  }

  async readManifest(runId: string): Promise<unknown | null> {
    const settings = await this.backupConfig.getSettings();
    const candidates = [
      path.join(settings.backupDir, 'runs', runId, 'manifest.json'),
      path.join(settings.volumeDirs.HIS, 'runs', runId, 'manifest.json'),
      path.join(settings.volumeDirs.EMR, 'runs', runId, 'manifest.json'),
      path.join(settings.volumeDirs.LIS, 'runs', runId, 'manifest.json'),
    ];

    for (const manifestPath of candidates) {
      if (fs.existsSync(manifestPath)) {
        return JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as unknown;
      }
    }

    return null;
  }

  private listRunIdsUnder(root: string): string[] {
    const runsDir = path.join(root, 'runs');

    if (!fs.existsSync(runsDir)) {
      return [];
    }

    return fs.readdirSync(runsDir).filter((name) => {
      try {
        return fs.statSync(path.join(runsDir, name)).isDirectory();
      } catch {
        return false;
      }
    });
  }

  private listStateDatabases(roots: string[]): string[] {
    const names = new Set<string>();

    for (const root of roots) {
      const stateDir = path.join(root, 'state');

      if (!fs.existsSync(stateDir)) {
        continue;
      }

      for (const f of fs.readdirSync(stateDir)) {
        if (f.endsWith('.json')) {
          names.add(f.replace(/\.json$/, ''));
        }
      }
    }

    return [...names].sort();
  }
}
