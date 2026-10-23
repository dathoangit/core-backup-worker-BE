import fs from 'node:fs';
import path from 'node:path';

import { toVnDateKey } from './public-overview.util';

export const DISK_USAGE_HISTORY_FILENAME = 'disk-usage-samples.json';
export const DISK_USAGE_HISTORY_DAYS = 7;

export interface DiskUsageSample {
  date: string;
  usedBytes: number;
}

export interface DiskGrowthForecast {
  dailyGrowthBytes: number | null;
  estimatedDaysUntilFull: number | null;
}

function historyPath(metaPath: string): string {
  return path.join(metaPath, 'state', DISK_USAGE_HISTORY_FILENAME);
}

export function readDiskUsageSamples(metaPath: string): DiskUsageSample[] {
  const file = historyPath(metaPath);

  try {
    const raw = fs.readFileSync(file, 'utf8');
    const parsed = JSON.parse(raw) as unknown;

    if (!Array.isArray(parsed)) {
      return [];
    }

    return parsed.filter(
      (row): row is DiskUsageSample =>
        typeof row === 'object' &&
        row !== null &&
        typeof (row as DiskUsageSample).date === 'string' &&
        typeof (row as DiskUsageSample).usedBytes === 'number' &&
        Number.isFinite((row as DiskUsageSample).usedBytes),
    );
  } catch {
    return [];
  }
}

/** Upsert today's sample (VN calendar day). Keeps at most `keepDays` entries. */
export function recordDiskUsageSample(
  metaPath: string,
  usedBytes: number,
  now = new Date(),
  keepDays = DISK_USAGE_HISTORY_DAYS + 1,
): DiskUsageSample[] {
  if (!metaPath || !Number.isFinite(usedBytes) || usedBytes < 0) {
    return [];
  }

  const today = toVnDateKey(now);
  const samples = readDiskUsageSamples(metaPath).filter(
    (row) => row.date !== today,
  );
  samples.push({ date: today, usedBytes });
  samples.sort((a, b) => a.date.localeCompare(b.date));

  const trimmed = samples.slice(-keepDays);
  const dir = path.dirname(historyPath(metaPath));

  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      historyPath(metaPath),
      `${JSON.stringify(trimmed, null, 2)}\n`,
      'utf8',
    );
  } catch {
    // Wallboard must not fail if meta volume is read-only.
  }

  return trimmed;
}

export function daysUntilFull(
  dailyGrowthBytes: number | null,
  freeBytes: number,
): number | null {
  if (
    dailyGrowthBytes == null ||
    dailyGrowthBytes <= 0 ||
    !Number.isFinite(freeBytes) ||
    freeBytes <= 0
  ) {
    return null;
  }

  return Math.max(1, Math.round(freeBytes / dailyGrowthBytes));
}

export function computeDiskGrowthForecast(
  samples: DiskUsageSample[],
  freeBytes: number,
): DiskGrowthForecast {
  if (samples.length < 2) {
    return { dailyGrowthBytes: null, estimatedDaysUntilFull: null };
  }

  const oldest = samples[0]!;
  const newest = samples.at(-1)!;
  const daySpan = Math.max(
    1,
    Math.round(
      (Date.parse(`${newest.date}T12:00:00Z`) -
        Date.parse(`${oldest.date}T12:00:00Z`)) /
        86_400_000,
    ),
  );
  const delta = newest.usedBytes - oldest.usedBytes;
  const dailyGrowthBytes = Math.round(delta / daySpan);

  if (dailyGrowthBytes <= 0) {
    return {
      dailyGrowthBytes: 0,
      estimatedDaysUntilFull: null,
    };
  }

  return {
    dailyGrowthBytes,
    estimatedDaysUntilFull: daysUntilFull(dailyGrowthBytes, freeBytes),
  };
}

/**
 * Fallback when disk sample history has &lt;2 days: average gzip bytes written
 * by successful DB runs over the last `windowDays`.
 */
export function estimateGrowthFromBackupBytes(
  writtenBytes: number,
  freeBytes: number,
  windowDays = DISK_USAGE_HISTORY_DAYS,
): DiskGrowthForecast {
  if (
    !Number.isFinite(writtenBytes) ||
    writtenBytes <= 0 ||
    !Number.isFinite(windowDays) ||
    windowDays <= 0
  ) {
    return { dailyGrowthBytes: null, estimatedDaysUntilFull: null };
  }

  const dailyGrowthBytes = Math.round(writtenBytes / windowDays);

  return {
    dailyGrowthBytes,
    estimatedDaysUntilFull: daysUntilFull(dailyGrowthBytes, freeBytes),
  };
}
