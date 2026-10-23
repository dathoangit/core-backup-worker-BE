export const BACKUP_CANCEL_CHANNEL = 'backup:cancel';
export const BACKUP_CANCEL_KEY_PREFIX = 'backup:cancel:';
export const BACKUP_CANCEL_TTL_SECONDS = 86_400;

export const BACKUP_PROGRESS_CHANNEL_PREFIX = 'backup:progress:';
export const BACKUP_PROGRESS_LAST_KEY_PREFIX = 'backup:progress:last:';
export const BACKUP_PROGRESS_TTL_SECONDS = 86_400;

export function backupCancelKey(runId: string): string {
  return `${BACKUP_CANCEL_KEY_PREFIX}${runId}`;
}

export function backupProgressChannel(runId: string): string {
  return `${BACKUP_PROGRESS_CHANNEL_PREFIX}${runId}`;
}

export function backupProgressLastKey(runId: string): string {
  return `${BACKUP_PROGRESS_LAST_KEY_PREFIX}${runId}`;
}
