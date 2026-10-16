import {
  incrementalCronSettingKey,
  isPerDatabaseIncrementalCronKey,
  KNOWN_SCHEDULED_DATABASES,
} from '../backup/incremental-schedule';
import { type SourceGroup } from '../backup/types';

export type SettingCategory = 'backup' | 'his' | 'emr' | 'badl' | 'lis';

export interface SettingKeyDef {
  key: string;
  category: SettingCategory;
  isSecret: boolean;
}

function categoryForGroup(group: SourceGroup): SettingCategory {
  switch (group) {
    case 'HIS': {
      return 'his';
    }
    case 'EMR': {
      return 'emr';
    }
    case 'LIS': {
      return 'lis';
    }
    default: {
      return 'backup';
    }
  }
}

const PER_DB_INCREMENTAL_CRON_DEFS: SettingKeyDef[] =
  KNOWN_SCHEDULED_DATABASES.map((entry) => ({
    key: incrementalCronSettingKey(entry.database),
    category: categoryForGroup(entry.group),
    isSecret: false,
  }));

/** Allowlist of keys that may be stored / seeded from env. */
export const SETTING_KEY_DEFS: SettingKeyDef[] = [
  // general (API category value remains "backup")
  { key: 'BACKUP_DIR', category: 'backup', isSecret: false },
  { key: 'BACKUP_ROOT', category: 'backup', isSecret: false },
  { key: 'BACKUP_VOLUME_META', category: 'backup', isSecret: false },
  { key: 'BACKUP_VOLUME_HIS', category: 'backup', isSecret: false },
  { key: 'BACKUP_VOLUME_EMR', category: 'backup', isSecret: false },
  { key: 'BACKUP_VOLUME_LIS', category: 'backup', isSecret: false },
  { key: 'BACKUP_SCHEDULE_ENABLED', category: 'backup', isSecret: false },
  /** Global incremental fallback when group/per-DB cron is unset. */
  { key: 'BACKUP_INCREMENTAL_CRON', category: 'backup', isSecret: false },
  { key: 'BACKUP_SCHEDULE_CRON', category: 'backup', isSecret: false },
  { key: 'BACKUP_TIMEZONE', category: 'backup', isSecret: false },
  { key: 'BACKUP_HISTORY_ENABLED', category: 'backup', isSecret: false },
  { key: 'BACKUP_RETENTION_DAYS', category: 'backup', isSecret: false },
  { key: 'BACKUP_FRESHNESS_MAX_AGE_HOURS', category: 'backup', isSecret: false },
  { key: 'BACKUP_ARCHIVE_TARGET', category: 'backup', isSecret: false },
  { key: 'BACKUP_CHUNK_SIZE', category: 'backup', isSecret: false },
  { key: 'BACKUP_STATEMENT_TIMEOUT_MS', category: 'backup', isSecret: false },
  /** Cap rows per COPY for local sample dumps; 0 = unlimited (production). */
  { key: 'BACKUP_DEV_ROW_LIMIT', category: 'backup', isSecret: false },
  // his
  { key: 'BACKUP_HIS_INCREMENTAL_CRON', category: 'his', isSecret: false },
  { key: 'BACKUP_HIS_FULL_CRON', category: 'his', isSecret: false },
  { key: 'HIS_HOST', category: 'his', isSecret: false },
  { key: 'HIS_PORT', category: 'his', isSecret: false },
  { key: 'HIS_USER', category: 'his', isSecret: false },
  { key: 'HIS_PASSWORD', category: 'his', isSecret: true },
  { key: 'HIS_DATABASES', category: 'his', isSecret: false },
  // emr
  { key: 'BACKUP_EMR_INCREMENTAL_CRON', category: 'emr', isSecret: false },
  { key: 'BACKUP_EMR_FULL_CRON', category: 'emr', isSecret: false },
  { key: 'EMR_HOST', category: 'emr', isSecret: false },
  { key: 'EMR_PORT', category: 'emr', isSecret: false },
  { key: 'EMR_USER', category: 'emr', isSecret: false },
  { key: 'EMR_PASSWORD', category: 'emr', isSecret: true },
  { key: 'EMR_DATABASES', category: 'emr', isSecret: false },
  // lis
  { key: 'BACKUP_LIS_INCREMENTAL_CRON', category: 'lis', isSecret: false },
  { key: 'BACKUP_LIS_FULL_CRON', category: 'lis', isSecret: false },
  { key: 'LIS_HOST', category: 'lis', isSecret: false },
  { key: 'LIS_PORT', category: 'lis', isSecret: false },
  { key: 'LIS_USER', category: 'lis', isSecret: false },
  { key: 'LIS_PASSWORD', category: 'lis', isSecret: true },
  { key: 'LIS_DATABASES', category: 'lis', isSecret: false },
  // badl
  { key: 'BADL_HOST', category: 'badl', isSecret: false },
  { key: 'BADL_PORT', category: 'badl', isSecret: false },
  { key: 'BADL_USER', category: 'badl', isSecret: false },
  { key: 'BADL_PASSWORD', category: 'badl', isSecret: true },
  { key: 'BADL_DATABASES', category: 'badl', isSecret: false },
  ...PER_DB_INCREMENTAL_CRON_DEFS,
];

export const SETTING_KEY_SET = new Set(SETTING_KEY_DEFS.map((d) => d.key));

/**
 * Cron / timezone keys are read by the scheduler at process boot.
 * Changing them requires a backend restart — only allow while no backup is running.
 */
export const RESTART_REQUIRED_SETTING_KEYS = new Set<string>([
  'BACKUP_INCREMENTAL_CRON',
  'BACKUP_SCHEDULE_CRON',
  'BACKUP_HIS_INCREMENTAL_CRON',
  'BACKUP_EMR_INCREMENTAL_CRON',
  'BACKUP_HIS_FULL_CRON',
  'BACKUP_EMR_FULL_CRON',
  'BACKUP_LIS_INCREMENTAL_CRON',
  'BACKUP_LIS_FULL_CRON',
  'BACKUP_TIMEZONE',
  ...PER_DB_INCREMENTAL_CRON_DEFS.map((d) => d.key),
]);

export function getSettingDef(key: string): SettingKeyDef | undefined {
  return SETTING_KEY_DEFS.find((d) => d.key === key);
}

export function isAllowlistedSettingKey(key: string): boolean {
  if (SETTING_KEY_SET.has(key)) {
    return true;
  }

  // Allow per-DB cron keys for databases added later via HIS_DATABASES / EMR_DATABASES.
  return isPerDatabaseIncrementalCronKey(key);
}

export function isRestartRequiredSettingKey(key: string): boolean {
  if (RESTART_REQUIRED_SETTING_KEYS.has(key)) {
    return true;
  }

  return isPerDatabaseIncrementalCronKey(key);
}
