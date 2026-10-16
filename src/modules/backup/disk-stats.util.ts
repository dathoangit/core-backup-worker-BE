import fs from 'node:fs';

export type DiskVolumeId = 'meta' | 'his' | 'emr';

export type DiskVolumeStats = {
  id: DiskVolumeId;
  label: string;
  /** Absolute mount/path used for statfs (ops wallboard). */
  path: string;
  exists: boolean;
  totalBytes: number;
  usedBytes: number;
  freeBytes: number;
  availableBytes: number;
  usedPercent: number;
};

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

export function collectVolumeDiskStats(volumes: {
  meta: string;
  his: string;
  emr: string;
}): DiskVolumeStats[] {
  const entries: Array<{ id: DiskVolumeId; label: string; path: string }> = [
    { id: 'meta', label: 'Meta', path: volumes.meta },
    { id: 'his', label: 'HIS', path: volumes.his },
    { id: 'emr', label: 'EMR', path: volumes.emr },
  ];

  return entries.map((entry) => {
    const exists = Boolean(entry.path) && fs.existsSync(entry.path);
    if (!exists) {
      return {
        id: entry.id,
        label: entry.label,
        path: entry.path || '—',
        exists: false,
        totalBytes: 0,
        usedBytes: 0,
        freeBytes: 0,
        availableBytes: 0,
        usedPercent: 0,
      };
    }

    const stat = readStatFs(entry.path);
    if (!stat) {
      return {
        id: entry.id,
        label: entry.label,
        path: entry.path,
        exists: true,
        totalBytes: 0,
        usedBytes: 0,
        freeBytes: 0,
        availableBytes: 0,
        usedPercent: 0,
      };
    }

    const usedBytes = Math.max(0, stat.totalBytes - stat.freeBytes);
    const usedPercent =
      stat.totalBytes > 0
        ? Math.round((usedBytes / stat.totalBytes) * 1000) / 10
        : 0;

    return {
      id: entry.id,
      label: entry.label,
      path: entry.path,
      exists: true,
      totalBytes: stat.totalBytes,
      usedBytes,
      freeBytes: stat.freeBytes,
      availableBytes: stat.availableBytes,
      usedPercent,
    };
  });
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
