import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export interface IDiskFolderUsage {
  id: string;
  label: string;
  bytes: number;
}

/** One physical disk. `folders` are backup directories on that disk, plus free/other. */
export interface IBackupDiskUsage {
  path: string;
  exists: boolean;
  totalBytes: number;
  usedBytes: number;
  freeBytes: number;
  availableBytes: number;
  usedPercent: number;
  folders: IDiskFolderUsage[];
}

export interface IBackupDiskUsageInput {
  /** Filesystem to stat. Usually BACKUP_ROOT. */
  diskPath: string;
  /** Orchestration directory (lock, manifests). Counted as one folder when it is a sibling. */
  metaPath: string;
  /** HIS / EMR / LIS roots. Database bytes are summed from `runs/<runId>/<db>` and `snapshots/<db>`. */
  volumePaths: string[];
}

const CACHE_TTL_MS = 60_000;
const OTHER_FOLDER: Pick<IDiskFolderUsage, 'id' | 'label'> = {
  id: 'other',
  label: 'Khác',
};
const FREE_FOLDER: Pick<IDiskFolderUsage, 'id' | 'label'> = {
  id: 'free',
  label: 'Trống',
};

interface ICacheEntry {
  key: string;
  at: number;
  value: IBackupDiskUsage;
}

let cache: ICacheEntry | null = null;

function readStatFs(targetPath: string): {
  totalBytes: number;
  freeBytes: number;
  availableBytes: number;
} | null {
  try {
    const stats = fs.statfsSync(targetPath);
    const bsize = Number(stats.bsize) || 0;
    const blocks = Number(stats.blocks) || 0;
    const bfree = Number(stats.bfree) || 0;
    const bavail = Number(stats.bavail) || 0;

    if (bsize <= 0 || blocks <= 0) {
      return null;
    }

    return {
      totalBytes: blocks * bsize,
      freeBytes: bfree * bsize,
      availableBytes: bavail * bsize,
    };
  } catch {
    return null;
  }
}

function sameOrNested(parent: string, child: string): boolean {
  const rel = path.relative(path.resolve(parent), path.resolve(child));

  return (
    rel === '' ||
    (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel))
  );
}

function databaseNameFromDuRelative(relative: string): string | null {
  const parts = relative.split(path.sep);

  if (parts.length === 3 && parts[0] === 'runs' && parts[2]) {
    return parts[2];
  }

  if (parts.length === 2 && parts[0] === 'snapshots' && parts[1]) {
    return parts[1];
  }

  return null;
}

function relativeInsideRoot(root: string, absolute: string): string | null {
  const relative = path.relative(root, absolute);

  if (
    relative === '' ||
    relative.startsWith('..') ||
    path.isAbsolute(relative)
  ) {
    return null;
  }

  return relative;
}

/**
 * `du -k -d 3 <volume>` reports directory totals.
 * Database payload lives at `runs/<runId>/<database>` (depth 3) and
 * `snapshots/<database>` (depth 2). Parent lines are ignored.
 */
export function parseDuDatabaseBytes(
  volumeRoot: string,
  stdout: string,
): Map<string, number> {
  const root = path.resolve(volumeRoot);
  const totals = new Map<string, number>();

  for (const line of stdout.split('\n')) {
    const match = /^(\d+)\s+(.+)$/.exec(line.trim());

    if (!match) {
      continue;
    }

    const kilobytes = Number(match[1]);
    const relative = relativeInsideRoot(root, path.resolve(match[2]));
    const database = relative ? databaseNameFromDuRelative(relative) : null;

    if (!database || !Number.isFinite(kilobytes) || kilobytes < 0) {
      continue;
    }

    totals.set(database, (totals.get(database) ?? 0) + kilobytes * 1024);
  }

  return totals;
}

/** Last `du` line is the directory total, in 1 KiB blocks. */
export function parseDuTotalBytes(stdout: string): number {
  const line = stdout
    .split('\n')
    .map((row) => row.trim())
    .filter(Boolean)
    .pop();

  if (!line) {
    return 0;
  }

  const match = /^(\d+)\s+/.exec(line);

  if (!match) {
    return 0;
  }

  const kilobytes = Number(match[1]);

  return Number.isFinite(kilobytes) && kilobytes > 0 ? kilobytes * 1024 : 0;
}

export function composeDiskUsage(input: {
  path: string;
  exists: boolean;
  totalBytes: number;
  freeBytes: number;
  availableBytes: number;
  folders: IDiskFolderUsage[];
}): IBackupDiskUsage {
  let folders = input.folders.filter((folder) => folder.bytes > 0);
  const usedBytes = Math.max(0, input.totalBytes - input.freeBytes);
  let folderSum = folders.reduce((sum, folder) => sum + folder.bytes, 0);

  if (usedBytes > 0 && folderSum > usedBytes) {
    const scale = usedBytes / folderSum;
    folders = folders.map((folder) => ({
      ...folder,
      bytes: Math.floor(folder.bytes * scale),
    }));
    folders = folders.filter((folder) => folder.bytes > 0);
    folderSum = folders.reduce((sum, folder) => sum + folder.bytes, 0);
  }

  folders.sort((a, b) => b.bytes - a.bytes || a.label.localeCompare(b.label));

  const segments = [...folders];

  if (input.totalBytes > 0) {
    const otherBytes = Math.max(0, usedBytes - folderSum);

    if (otherBytes > 0) {
      segments.push({ ...OTHER_FOLDER, bytes: otherBytes });
    }

    if (input.freeBytes > 0) {
      segments.push({ ...FREE_FOLDER, bytes: input.freeBytes });
    }
  }

  const usedPercent =
    input.totalBytes > 0
      ? Math.round((usedBytes / input.totalBytes) * 1000) / 10
      : 0;

  return {
    path: input.path || '—',
    exists: input.exists,
    totalBytes: input.totalBytes,
    usedBytes,
    freeBytes: input.freeBytes,
    availableBytes: input.availableBytes,
    usedPercent,
    folders: segments,
  };
}

function runDu(target: string, depth: number): Promise<string> {
  return new Promise((resolve) => {
    execFile(
      'du',
      ['-k', '-d', String(depth), target],
      { maxBuffer: 32 * 1024 * 1024 },
      (_error, stdout) => {
        resolve(typeof stdout === 'string' ? stdout : '');
      },
    );
  });
}

function emptyDisk(diskPath: string): IBackupDiskUsage {
  return {
    path: diskPath || '—',
    exists: false,
    totalBytes: 0,
    usedBytes: 0,
    freeBytes: 0,
    availableBytes: 0,
    usedPercent: 0,
    folders: [],
  };
}

function findExistingPath(candidates: string[]): string | undefined {
  return candidates.find(
    (candidate) => Boolean(candidate) && fs.existsSync(candidate),
  );
}

async function measureVolumeDatabases(
  volumePath: string,
): Promise<Map<string, number>> {
  if (!fs.existsSync(volumePath)) {
    return new Map();
  }

  return parseDuDatabaseBytes(volumePath, await runDu(volumePath, 3));
}

function mergeByteMaps(maps: Array<Map<string, number>>): Map<string, number> {
  const totals = new Map<string, number>();

  for (const usage of maps) {
    for (const [id, bytes] of usage) {
      totals.set(id, (totals.get(id) ?? 0) + bytes);
    }
  }

  return totals;
}

function overlapsAny(target: string, paths: string[]): boolean {
  return paths.some(
    (candidate) =>
      sameOrNested(target, candidate) || sameOrNested(candidate, target),
  );
}

async function appendMetaBytes(
  metaPath: string,
  volumePaths: string[],
  folderBytes: Map<string, number>,
): Promise<void> {
  const trimmed = metaPath.trim();
  const isMetaSeparate =
    Boolean(trimmed) &&
    !overlapsAny(trimmed, volumePaths) &&
    fs.existsSync(trimmed);

  if (!isMetaSeparate) {
    return;
  }

  const metaBytes = parseDuTotalBytes(await runDu(trimmed, 0));

  if (metaBytes > 0) {
    folderBytes.set('meta', (folderBytes.get('meta') ?? 0) + metaBytes);
  }
}

function toFolderUsage(folderBytes: Map<string, number>): IDiskFolderUsage[] {
  return [...folderBytes.entries()].map(([id, bytes]) => ({
    id,
    label: id === 'meta' ? 'Meta' : id,
    bytes,
  }));
}

async function measureBackupDisk(
  input: IBackupDiskUsageInput,
): Promise<IBackupDiskUsage> {
  const volumePaths = input.volumePaths.filter((volumePath) =>
    Boolean(volumePath.trim()),
  );
  const statTarget = findExistingPath([
    input.diskPath,
    input.metaPath,
    ...volumePaths,
  ]);

  if (!statTarget) {
    return emptyDisk(input.diskPath);
  }

  const stat = readStatFs(statTarget);

  if (!stat) {
    return {
      ...emptyDisk(input.diskPath || statTarget),
      exists: true,
    };
  }

  const folderBytes = mergeByteMaps(
    await Promise.all(
      volumePaths.map((volumePath) => measureVolumeDatabases(volumePath)),
    ),
  );
  await appendMetaBytes(input.metaPath, volumePaths, folderBytes);

  return composeDiskUsage({
    path: input.diskPath || statTarget,
    exists: true,
    totalBytes: stat.totalBytes,
    freeBytes: stat.freeBytes,
    availableBytes: stat.availableBytes,
    folders: toFolderUsage(folderBytes),
  });
}

export async function collectBackupDiskUsage(
  input: IBackupDiskUsageInput,
): Promise<IBackupDiskUsage> {
  const key = [input.diskPath, input.metaPath, ...input.volumePaths].join('\0');
  const now = Date.now();

  if (cache && cache.key === key && now - cache.at < CACHE_TTL_MS) {
    return cache.value;
  }

  const value = await measureBackupDisk(input);
  cache = { key, at: now, value };

  return value;
}

export function formatBytesShort(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return '0 B';
  }

  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  let value = bytes;
  let unit = 0;

  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }

  const digits = value >= 100 || unit === 0 ? 0 : 1;

  return `${value.toFixed(digits)} ${units[unit]}`;
}
