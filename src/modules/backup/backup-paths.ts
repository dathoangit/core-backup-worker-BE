import path from 'node:path';

import type { SourceGroup } from './types';

export type BackupVolumeGroup = 'HIS' | 'EMR' | 'LIS';

export interface BackupVolumeDirs {
  HIS: string;
  EMR: string;
  LIS: string;
}

export interface ResolvedBackupPaths {
  /** Orchestration root: lock file lives here. */
  metaDir: string;
  volumeDirs: BackupVolumeDirs;
  /** Present when BACKUP_ROOT (or legacy BACKUP_DIR as root) is used. */
  backupRoot: string | null;
}

export interface BackupPathInputs {
  backupRoot?: string;
  /** Legacy single-root setting; used as BACKUP_ROOT when BACKUP_ROOT unset. */
  backupDir?: string;
  volumeMeta?: string;
  volumeHis?: string;
  volumeEmr?: string;
  volumeLis?: string;
  /** Absolute cwd for resolving relative paths (defaults to process.cwd()). */
  cwd?: string;
  isDevelopment?: boolean;
}

const DEFAULT_VOLUME_META = 'volumes/meta';
const DEFAULT_VOLUME_HIS = 'volumes/his';
const DEFAULT_VOLUME_EMR = 'volumes/emr';
const DEFAULT_VOLUME_LIS = 'volumes/lis';

/** HIS produce; LIS lab databases; remaining scheduled DBs use the EMR volume. */
const HIS_DATABASES = new Set(['produce']);
const LIS_DATABASES = new Set([
  'BloodStorage_XanhPon',
  'Labconnect_Card',
  'LabconnXP',
  'LabInventory_XP',
]);

export function isDevelopmentNodeEnv(
  nodeEnv = process.env.NODE_ENV,
): boolean {
  return (nodeEnv ?? '').toLowerCase() === 'development';
}

/** True for POSIX absolute, Windows drive (C:\...), or UNC (\\server\share). */
export function isAbsolutePath(value: string): boolean {
  if (path.isAbsolute(value)) {
    return true;
  }

  return /^[A-Za-z]:[\\/]/.test(value) || value.startsWith('\\\\');
}

export function resolvePathMaybeRelative(
  value: string,
  baseDir: string,
): string {
  return isAbsolutePath(value) ? value : path.resolve(baseDir, value);
}

/**
 * Resolves meta + HIS/EMR volume roots.
 *
 * - Absolute BACKUP_VOLUME_* paths are used as-is.
 * - Relative volume paths join BACKUP_ROOT (or legacy BACKUP_DIR as root).
 * - Dev default root: `../.backup-dev` from cwd (repo `.backup-dev` when cwd is BE).
 */
export function resolveBackupPaths(inputs: BackupPathInputs): ResolvedBackupPaths {
  const cwd = inputs.cwd ?? process.cwd();
  const isDev = inputs.isDevelopment ?? isDevelopmentNodeEnv();

  const rootRaw =
    inputs.backupRoot?.trim() ||
    inputs.backupDir?.trim() ||
    (isDev ? path.resolve(cwd, '../.backup-dev') : '');

  if (!rootRaw && !inputs.volumeMeta?.trim()) {
    throw new Error(
      'Missing backup paths. Set BACKUP_ROOT (or legacy BACKUP_DIR) and/or absolute BACKUP_VOLUME_META / HIS / EMR / LIS.',
    );
  }

  const backupRoot = rootRaw
    ? resolvePathMaybeRelative(rootRaw, cwd)
    : null;

  const resolveVolume = (raw: string | undefined, fallbackRel: string): string => {
    const value = raw?.trim() || fallbackRel;
    if (isAbsolutePath(value)) {
      return value;
    }
    if (!backupRoot) {
      throw new Error(
        `Relative volume path "${value}" requires BACKUP_ROOT or BACKUP_DIR`,
      );
    }

    return path.resolve(backupRoot, value);
  };

  return {
    metaDir: resolveVolume(inputs.volumeMeta, DEFAULT_VOLUME_META),
    volumeDirs: {
      HIS: resolveVolume(inputs.volumeHis, DEFAULT_VOLUME_HIS),
      EMR: resolveVolume(inputs.volumeEmr, DEFAULT_VOLUME_EMR),
      LIS: resolveVolume(inputs.volumeLis, DEFAULT_VOLUME_LIS),
    },
    backupRoot,
  };
}

export function volumeGroupForSourceGroup(
  group: SourceGroup,
): BackupVolumeGroup {
  if (group === 'HIS') {
    return 'HIS';
  }

  if (group === 'LIS') {
    return 'LIS';
  }

  // EMR + BADL (if ever runnable) share EMR-style volume layout for now.
  return 'EMR';
}

export function volumeGroupForDatabase(database: string): BackupVolumeGroup {
  if (HIS_DATABASES.has(database)) {
    return 'HIS';
  }

  if (LIS_DATABASES.has(database)) {
    return 'LIS';
  }

  return 'EMR';
}

export function volumeRoots(volumeDirs: BackupVolumeDirs): string[] {
  return [volumeDirs.HIS, volumeDirs.EMR, volumeDirs.LIS];
}

export function volumeDirForGroup(
  volumeDirs: BackupVolumeDirs,
  group: SourceGroup,
): string {
  return volumeDirs[volumeGroupForSourceGroup(group)];
}

export function volumeDirForDatabase(
  volumeDirs: BackupVolumeDirs,
  database: string,
): string {
  return volumeDirs[volumeGroupForDatabase(database)];
}

export function applyDevRowLimitPolicy(
  rawLimit: number | undefined,
  isDevelopment: boolean,
): number {
  if (isDevelopment) {
    if (rawLimit === undefined) {
      return 100;
    }
    if (rawLimit <= 0) {
      throw new Error(
        'BACKUP_DEV_ROW_LIMIT must be > 0 in development (yarn dev). Use yarn start for production backups.',
      );
    }

    return rawLimit;
  }

  if (rawLimit !== undefined && rawLimit > 0) {
    throw new Error(
      'BACKUP_DEV_ROW_LIMIT must be 0 in production (yarn start). Sample dumps are only allowed with yarn dev.',
    );
  }

  return 0;
}
