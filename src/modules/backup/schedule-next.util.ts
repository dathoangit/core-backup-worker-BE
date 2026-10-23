import { CronJob } from 'cron';

import { type ScheduledDatabase } from './incremental-schedule';
import { PUBLIC_OVERVIEW_TZ } from './public-overview.util';
import { type SourceGroup } from './types';

export interface NextScheduleJobTarget {
  group: SourceGroup;
  database: string;
}

export interface NextScheduleTimes {
  nextIncrementalAt: string | null;
  nextFullAt: string | null;
  nextFullLabel: string | null;
  nextIncrementalDatabases: NextScheduleJobTarget[];
  nextFullDatabases: NextScheduleJobTarget[];
  nextFullGroups: SourceGroup[];
}

export interface IncrementalScheduleBucketInput {
  cron: string;
  databases: ScheduledDatabase[];
}

export interface FullScheduleGroupInput {
  group: SourceGroup;
  cron: string;
  databases: ScheduledDatabase[];
}

function nextFireIso(
  cronExpr: string | null | undefined,
  timezone = PUBLIC_OVERVIEW_TZ,
): Date | null {
  const expr = cronExpr?.trim();

  if (!expr) {
    return null;
  }

  try {
    const job = new CronJob(expr, () => {}, null, false, timezone);
    const next = job.nextDates(1)?.[0];

    if (!next) {
      return null;
    }

    if (typeof (next as { toJSDate?: () => Date }).toJSDate === 'function') {
      return (next as { toJSDate: () => Date }).toJSDate();
    }

    if (next instanceof Date) {
      return next;
    }

    return new Date(String(next));
  } catch {
    return null;
  }
}

export function earliestNextFire(
  cronExprs: Array<string | null | undefined>,
  timezone = PUBLIC_OVERVIEW_TZ,
): Date | null {
  let earliest: Date | null = null;

  for (const expr of cronExprs) {
    const next = nextFireIso(expr, timezone);

    if (!next || Number.isNaN(next.getTime())) {
      continue;
    }

    if (!earliest || next.getTime() < earliest.getTime()) {
      earliest = next;
    }
  }

  return earliest;
}

export function formatNextFullLabel(
  date: Date | null,
  timezone = PUBLIC_OVERVIEW_TZ,
): string | null {
  if (!date) {
    return null;
  }

  const weekday = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    weekday: 'short',
  }).format(date);
  const time = new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(date);

  return `${weekday} ${time}`;
}

const SAME_FIRE_TOLERANCE_MS = 1000;

function pickEarliestBuckets<T extends { cron: string }>(
  items: T[],
  timezone: string,
): { at: Date | null; items: T[] } {
  let earliestMs = Number.POSITIVE_INFINITY;
  const scored: Array<{ item: T; at: Date }> = [];

  for (const item of items) {
    const at = nextFireIso(item.cron, timezone);

    if (!at) {
      continue;
    }

    scored.push({ item, at });
    earliestMs = Math.min(earliestMs, at.getTime());
  }

  if (!Number.isFinite(earliestMs)) {
    return { at: null, items: [] };
  }

  const winners = scored
    .filter(
      (row) =>
        Math.abs(row.at.getTime() - earliestMs) <= SAME_FIRE_TOLERANCE_MS,
    )
    .map((row) => row.item);

  return { at: new Date(earliestMs), items: winners };
}

function uniqueTargets(
  databases: ScheduledDatabase[],
): NextScheduleJobTarget[] {
  const seen = new Set<string>();
  const result: NextScheduleJobTarget[] = [];

  for (const entry of databases) {
    const key = `${entry.group}:${entry.database}`;

    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    result.push({ group: entry.group, database: entry.database });
  }

  return result;
}

export function buildNextScheduleTimes(options: {
  enabled: boolean | null;
  incrementalBuckets: IncrementalScheduleBucketInput[];
  fullGroups: FullScheduleGroupInput[];
  timezone?: string;
}): NextScheduleTimes {
  // Always compute next fire times so wallboard can show countdown even when
  // BACKUP_SCHEDULE_ENABLED is false (FE shows a "schedule off" warning).
  const tz = options.timezone ?? PUBLIC_OVERVIEW_TZ;

  const incrementalPick = pickEarliestBuckets(
    options.incrementalBuckets.filter((b) => b.cron.trim()),
    tz,
  );
  const nextIncrementalDatabases = uniqueTargets(
    incrementalPick.items.flatMap((bucket) => bucket.databases),
  );

  const fullPick = pickEarliestBuckets(
    options.fullGroups.filter((g) => g.cron.trim()),
    tz,
  );
  const nextFullDatabases = uniqueTargets(
    fullPick.items.flatMap((group) => group.databases),
  );
  const nextFullGroups = [
    ...new Set(fullPick.items.map((group) => group.group)),
  ];

  return {
    nextIncrementalAt: incrementalPick.at?.toISOString() ?? null,
    nextFullAt: fullPick.at?.toISOString() ?? null,
    nextFullLabel: formatNextFullLabel(fullPick.at, tz),
    nextIncrementalDatabases,
    nextFullDatabases,
    nextFullGroups,
  };
}
