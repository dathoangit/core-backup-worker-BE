import type { SourceGroup } from './types';

export const DEFAULT_INCREMENTAL_CRON = '0 */4 * * *';

/** Setting key for a per-database incremental cron override. */
export function incrementalCronSettingKey(database: string): string {
  return `BACKUP_INCREMENTAL_CRON_${database}`;
}

const PER_DB_CRON_KEY =
  /^BACKUP_INCREMENTAL_CRON_([A-Za-z][A-Za-z0-9_]*)$/;

/** True when key is BACKUP_INCREMENTAL_CRON_<database> (not the global key). */
export function isPerDatabaseIncrementalCronKey(key: string): boolean {
  return PER_DB_CRON_KEY.test(key);
}

export function databaseFromIncrementalCronKey(key: string): string | null {
  const match = PER_DB_CRON_KEY.exec(key);

  return match?.[1] ?? null;
}

export type ScheduledDatabase = {
  group: SourceGroup;
  database: string;
};

export type IncrementalCronSources = {
  /** Global fallback (BACKUP_INCREMENTAL_CRON / BACKUP_SCHEDULE_CRON). */
  globalCron: string;
  hisGroupCron?: string;
  emrGroupCron?: string;
  lisGroupCron?: string;
  /** Per-database overrides keyed by database name. */
  perDatabase: Record<string, string>;
};

export function resolveIncrementalCron(
  database: string,
  group: SourceGroup,
  sources: IncrementalCronSources,
): string {
  const perDb = sources.perDatabase[database]?.trim();
  if (perDb) {
    return perDb;
  }

  if (group === 'HIS' && sources.hisGroupCron?.trim()) {
    return sources.hisGroupCron.trim();
  }

  if (group === 'EMR' && sources.emrGroupCron?.trim()) {
    return sources.emrGroupCron.trim();
  }

  if (group === 'LIS' && sources.lisGroupCron?.trim()) {
    return sources.lisGroupCron.trim();
  }

  return sources.globalCron.trim() || DEFAULT_INCREMENTAL_CRON;
}

export type IncrementalCronBucket = {
  cron: string;
  databases: ScheduledDatabase[];
};

/** Group databases that share the same resolved cron into one scheduled job. */
export function groupDatabasesByIncrementalCron(
  databases: ScheduledDatabase[],
  sources: IncrementalCronSources,
): IncrementalCronBucket[] {
  const buckets = new Map<string, ScheduledDatabase[]>();

  for (const entry of databases) {
    const cron = resolveIncrementalCron(entry.database, entry.group, sources);
    const list = buckets.get(cron) ?? [];
    list.push(entry);
    buckets.set(cron, list);
  }

  return [...buckets.entries()].map(([cron, dbs]) => ({
    cron,
    databases: dbs,
  }));
}

/** Default HIS/EMR databases used for settings allowlist / seed. */
export const KNOWN_SCHEDULED_DATABASES: ScheduledDatabase[] = [
  { group: 'HIS', database: 'produce' },
  { group: 'EMR', database: 'signer' },
  { group: 'EMR', database: 'file_service' },
  { group: 'EMR', database: 'vital_signs' },
  { group: 'EMR', database: 'research_management' },
  { group: 'EMR', database: 'medical_incident' },
  { group: 'EMR', database: 'html_editor' },
  { group: 'EMR', database: 'phat_thuoc' },
  { group: 'LIS', database: 'BloodStorage_XanhPon' },
  { group: 'LIS', database: 'Labconnect_Card' },
  { group: 'LIS', database: 'LabconnXP' },
  { group: 'LIS', database: 'LabInventory_XP' },
];
