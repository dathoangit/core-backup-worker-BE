import { type BackupRunStatus } from './types';

export const PUBLIC_OVERVIEW_TZ = 'Asia/Ho_Chi_Minh';
export const PUBLIC_OVERVIEW_HISTORY_DAYS = 14;
export const PUBLIC_OVERVIEW_RECENT_JOBS = 12;
export const PUBLIC_OVERVIEW_RUN_SAMPLE = 200;

export interface DayStatusCounts {
  date: string;
  ok: number;
  error: number;
  partial: number;
  running: number;
  /** Sum of gzip bytes written by DB runs that day. */
  bytesWritten: number;
  /** Average run duration in seconds (finished runs only). */
  durationSecAvg: number | null;
  /** Sum of row counts from DB runs that day. */
  rowCountTotal: number;
}

export interface JobSummaryCounts {
  ok: number;
  error: number;
  partial: number;
  running: number;
  total: number;
}

export interface HistoryRunInput {
  startedAt: Date | string;
  finishedAt?: Date | string | null;
  status: BackupRunStatus;
  bytesWritten?: number;
  rowCountTotal?: number;
}

interface DayAccumulator extends DayStatusCounts {
  durationSecSum: number;
  durationSampleCount: number;
}

/** YYYY-MM-DD in Asia/Ho_Chi_Minh. */
export function toVnDateKey(date: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: PUBLIC_OVERVIEW_TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}

export function emptyDayCounts(date: string): DayStatusCounts {
  return {
    date,
    ok: 0,
    error: 0,
    partial: 0,
    running: 0,
    bytesWritten: 0,
    durationSecAvg: null,
    rowCountTotal: 0,
  };
}

function emptyDayAccumulator(date: string): DayAccumulator {
  return {
    ...emptyDayCounts(date),
    durationSecSum: 0,
    durationSampleCount: 0,
  };
}

function runDurationSeconds(
  startedAt: Date | string,
  finishedAt: Date | string | null | undefined,
): number | null {
  if (finishedAt == null) {
    return null;
  }

  const started = startedAt instanceof Date ? startedAt : new Date(startedAt);
  const finished =
    finishedAt instanceof Date ? finishedAt : new Date(finishedAt);

  if (Number.isNaN(started.getTime()) || Number.isNaN(finished.getTime())) {
    return null;
  }

  const sec = Math.round((finished.getTime() - started.getTime()) / 1000);

  return sec >= 0 ? sec : null;
}

export function buildHistoryDayKeys(
  now = new Date(),
  days = PUBLIC_OVERVIEW_HISTORY_DAYS,
): string[] {
  const todayKey = toVnDateKey(now);
  const [year, month, day] = todayKey.split('-').map(Number);
  // Noon UTC avoids DST edge cases when stepping calendar days in VN.
  const cursor = new Date(Date.UTC(year, month - 1, day, 12, 0, 0));
  const keys: string[] = [];

  for (let i = days - 1; i >= 0; i -= 1) {
    const d = new Date(cursor);
    d.setUTCDate(cursor.getUTCDate() - i);
    keys.push(toVnDateKey(d));
  }

  return keys;
}

export function aggregateHistoryByDay(
  runs: HistoryRunInput[],
  now = new Date(),
): DayStatusCounts[] {
  const keys = buildHistoryDayKeys(now);
  const byDate = new Map(keys.map((key) => [key, emptyDayAccumulator(key)]));

  for (const run of runs) {
    const started =
      run.startedAt instanceof Date ? run.startedAt : new Date(run.startedAt);

    if (Number.isNaN(started.getTime())) {
      continue;
    }

    const key = toVnDateKey(started);
    const bucket = byDate.get(key);

    if (!bucket) {
      continue;
    }

    switch (run.status) {
      case 'ok': {
        bucket.ok += 1;
        break;
      }

      case 'error': {
        bucket.error += 1;
        break;
      }

      case 'partial': {
        bucket.partial += 1;
        break;
      }

      case 'running': {
        bucket.running += 1;
        break;
      }

      default: {
        break;
      }
    }

    const bytes = Number(run.bytesWritten ?? 0);

    if (Number.isFinite(bytes) && bytes > 0) {
      bucket.bytesWritten += bytes;
    }

    const rows = Number(run.rowCountTotal ?? 0);

    if (Number.isFinite(rows) && rows > 0) {
      bucket.rowCountTotal += rows;
    }

    const durationSec = runDurationSeconds(run.startedAt, run.finishedAt);

    if (durationSec != null) {
      bucket.durationSecSum += durationSec;
      bucket.durationSampleCount += 1;
    }
  }

  return keys.map((key) => {
    const bucket = byDate.get(key) ?? emptyDayAccumulator(key);

    return {
      date: bucket.date,
      ok: bucket.ok,
      error: bucket.error,
      partial: bucket.partial,
      running: bucket.running,
      bytesWritten: bucket.bytesWritten,
      durationSecAvg:
        bucket.durationSampleCount > 0
          ? Math.round(bucket.durationSecSum / bucket.durationSampleCount)
          : null,
      rowCountTotal: bucket.rowCountTotal,
    };
  });
}

export function summarizeJobs(
  runs: Array<{ startedAt: Date | string; status: BackupRunStatus }>,
  now = new Date(),
  windowMs = 24 * 60 * 60 * 1000,
): JobSummaryCounts {
  const cutoff = now.getTime() - windowMs;
  const inWindow = runs.filter((run) => {
    const started =
      run.startedAt instanceof Date ? run.startedAt : new Date(run.startedAt);

    return !Number.isNaN(started.getTime()) && started.getTime() >= cutoff;
  });
  const sample = inWindow.length > 0 ? inWindow : runs;

  const summary: JobSummaryCounts = {
    ok: 0,
    error: 0,
    partial: 0,
    running: 0,
    total: sample.length,
  };

  for (const run of sample) {
    switch (run.status) {
      case 'ok': {
        summary.ok += 1;
        break;
      }

      case 'error': {
        summary.error += 1;
        break;
      }

      case 'partial': {
        summary.partial += 1;
        break;
      }

      case 'running': {
        summary.running += 1;
        break;
      }

      default: {
        break;
      }
    }
  }

  return summary;
}

export function truncateError(
  error: string | null | undefined,
  maxLen = 120,
): string | null {
  if (!error) {
    return null;
  }

  const trimmed = error.trim();

  if (trimmed.length <= maxLen) {
    return trimmed;
  }

  return `${trimmed.slice(0, maxLen - 1)}…`;
}

/** Minutes since lastStartedAt. Null when timestamp missing/invalid. */
export function lagMinutesFromLastStartedAt(
  lastStartedAt: string | null | undefined,
  now = new Date(),
): number | null {
  if (!lastStartedAt) {
    return null;
  }

  const started = new Date(lastStartedAt);

  if (Number.isNaN(started.getTime())) {
    return null;
  }

  return Math.max(0, Math.round((now.getTime() - started.getTime()) / 60_000));
}

/**
 * Approximate CSV payload before gzip. Tuned for wallboard display only —
 * not a measured uncompressed size from the COPY pipeline.
 */
export const AVG_ROW_BYTES_ESTIMATE = 180;

export interface CompressionEstimate {
  compressionRatio: number | null;
  compressionSavingsPercent: number | null;
}

export function estimateGzipCompression(
  samples: Array<{ rowCountTotal: number; bytesTotal: number }>,
  avgRowBytes = AVG_ROW_BYTES_ESTIMATE,
): CompressionEstimate {
  let rows = 0;
  let gzipBytes = 0;

  for (const sample of samples) {
    if (
      Number.isFinite(sample.rowCountTotal) &&
      sample.rowCountTotal > 0 &&
      Number.isFinite(sample.bytesTotal) &&
      sample.bytesTotal > 0
    ) {
      rows += sample.rowCountTotal;
      gzipBytes += sample.bytesTotal;
    }
  }

  if (rows <= 0 || gzipBytes <= 0) {
    return { compressionRatio: null, compressionSavingsPercent: null };
  }

  const estimatedRaw = rows * avgRowBytes;

  if (estimatedRaw <= gzipBytes) {
    return { compressionRatio: null, compressionSavingsPercent: null };
  }

  const compressionRatio = Math.round((estimatedRaw / gzipBytes) * 10) / 10;
  const compressionSavingsPercent = Math.round(
    (1 - gzipBytes / estimatedRaw) * 100,
  );

  return { compressionRatio, compressionSavingsPercent };
}

export function estimatedRowsTotal(
  rowsProcessed: number,
  percent: number,
): number | null {
  if (
    !Number.isFinite(rowsProcessed) ||
    rowsProcessed <= 0 ||
    !Number.isFinite(percent) ||
    percent <= 0
  ) {
    return null;
  }

  return Math.max(rowsProcessed, Math.round(rowsProcessed / (percent / 100)));
}
