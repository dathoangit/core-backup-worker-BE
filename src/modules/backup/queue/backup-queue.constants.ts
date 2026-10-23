export const BACKUP_INCREMENTAL_QUEUE_NAME = 'queue-incremental';
export const BACKUP_FULL_QUEUE_NAME = 'queue-full';

/** @deprecated Use BACKUP_INCREMENTAL_QUEUE_NAME / BACKUP_FULL_QUEUE_NAME */
export const BACKUP_QUEUE_NAME = BACKUP_INCREMENTAL_QUEUE_NAME;

export const BACKUP_QUEUE_JOB_NAME = 'run';

/** Lower number = higher priority in BullMQ. */
export const BACKUP_INCREMENTAL_PRIORITY = 1;
export const BACKUP_FULL_PRIORITY = 10;

export const BACKUP_QUEUE_LOCK_DURATION_MS = 6 * 60 * 60 * 1000;
export const BACKUP_QUEUE_STALLED_INTERVAL_MS = 5 * 60 * 1000;
export const BACKUP_QUEUE_MAX_STALLED_COUNT = 1;

export const BACKUP_INCREMENTAL_CONCURRENCY = 2;
export const BACKUP_FULL_CONCURRENCY = 1;

export const DEFAULT_STATEMENT_TIMEOUT_MS = 21_600_000;
