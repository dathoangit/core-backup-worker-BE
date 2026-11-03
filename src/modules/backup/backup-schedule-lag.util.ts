import { CronJob } from 'cron';

import { PUBLIC_OVERVIEW_TZ } from './public-overview.util';

export type BackupLagState =
  | 'no_data'
  | 'on_time'
  | 'overdue'
  | 'missed'
  | 'error';

export const BACKUP_LAG_GRACE_MINUTES = 30;

/** Soft “past due” window — keep amber until about a week, not after ~1 day. */
export const BACKUP_LAG_OVERDUE_MAX_DAYS = 7;

/** Recent enough to still treat as on schedule when cron is unknown. */
export const BACKUP_LAG_ON_TIME_MAX_DAYS = 2;

function cronDateToJs(value: unknown): Date | null {
  if (!value) {
    return null;
  }

  if (value instanceof Date) {
    return value;
  }

  if (typeof (value as { toJSDate?: () => Date }).toJSDate === 'function') {
    return (value as { toJSDate: () => Date }).toJSDate();
  }

  const parsed = new Date(String(value));

  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function createCronJob(cronExpr: string, timezone: string): CronJob | null {
  const expr = cronExpr.trim();

  if (!expr) {
    return null;
  }

  try {
    return new CronJob(expr, () => {}, null, false, timezone);
  } catch {
    return null;
  }
}

/** Next fire time from the current instant (same semantics as wallboard schedule). */
export function cronNextFireIso(
  cronExpr: string | null | undefined,
  timezone = PUBLIC_OVERVIEW_TZ,
): Date | null {
  const job = createCronJob(cronExpr?.trim() ?? '', timezone);

  if (!job) {
    return null;
  }

  const next = job.nextDates(1)?.[0];

  return cronDateToJs(next);
}

/** Milliseconds between the next two scheduled fires (incremental cadence). */
export function cronIncrementalIntervalMs(
  cronExpr: string,
  timezone = PUBLIC_OVERVIEW_TZ,
): number | null {
  const job = createCronJob(cronExpr, timezone);

  if (!job) {
    return null;
  }

  const dates = job.nextDates(2);

  if (!dates || dates.length < 2) {
    return null;
  }

  const first = cronDateToJs(dates[0]);
  const second = cronDateToJs(dates[1]);

  if (!first || !second) {
    return null;
  }

  const ms = second.getTime() - first.getTime();

  return ms > 0 ? ms : null;
}

/** Start of the current backup window: last cron tick before the upcoming fire. */
export function cronPreviousScheduledFire(
  cronExpr: string,
  timezone = PUBLIC_OVERVIEW_TZ,
): Date | null {
  const next = cronNextFireIso(cronExpr, timezone);
  const intervalMs = cronIncrementalIntervalMs(cronExpr, timezone);

  if (!next || !intervalMs) {
    return null;
  }

  return new Date(next.getTime() - intervalMs);
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Age-based freshness. A missed cron slot stays green until 2 days,
 * yellow until 1 week, then red.
 */
function lagStateFromAge(lastOk: Date, now: Date): BackupLagState {
  const ageMs = Math.max(0, now.getTime() - lastOk.getTime());

  if (ageMs < BACKUP_LAG_ON_TIME_MAX_DAYS * DAY_MS) {
    return 'on_time';
  }

  if (ageMs < BACKUP_LAG_OVERDUE_MAX_DAYS * DAY_MS) {
    return 'overdue';
  }

  return 'missed';
}

export function resolveBackupLagState(options: {
  lastOkAt: string | null | undefined;
  lastDbStatus: 'ok' | 'error' | 'skipped' | null;
  cronExpr: string | null | undefined;
  timezone?: string;
  now?: Date;
  graceMinutes?: number;
}): BackupLagState {
  if (options.lastDbStatus === 'error') {
    return 'error';
  }

  if (!options.lastOkAt) {
    return 'no_data';
  }

  const lastOk = new Date(options.lastOkAt);

  if (Number.isNaN(lastOk.getTime())) {
    return 'no_data';
  }

  const now = options.now ?? new Date();

  return lagStateFromAge(lastOk, now);
}
