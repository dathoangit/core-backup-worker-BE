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
}

export interface JobSummaryCounts {
  ok: number;
  error: number;
  partial: number;
  running: number;
  total: number;
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
  return { date, ok: 0, error: 0, partial: 0, running: 0 };
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
  runs: Array<{ startedAt: Date | string; status: BackupRunStatus }>,
  now = new Date(),
): DayStatusCounts[] {
  const keys = buildHistoryDayKeys(now);
  const byDate = new Map(keys.map((key) => [key, emptyDayCounts(key)]));

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
  }

  return keys.map((key) => byDate.get(key) ?? emptyDayCounts(key));
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
