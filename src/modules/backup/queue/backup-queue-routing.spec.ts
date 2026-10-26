import { describe, expect, it } from '@jest/globals';

import {
  BACKUP_FULL_PRIORITY,
  BACKUP_FULL_QUEUE_NAME,
  BACKUP_INCREMENTAL_PRIORITY,
  BACKUP_INCREMENTAL_QUEUE_NAME,
} from './backup-queue.constants';

describe('backup queue routing', () => {
  it('uses separate queue names for incremental and full', () => {
    expect(BACKUP_INCREMENTAL_QUEUE_NAME).toBe('queue-incremental');
    expect(BACKUP_FULL_QUEUE_NAME).toBe('queue-full');
    expect(BACKUP_INCREMENTAL_PRIORITY).toBeLessThan(BACKUP_FULL_PRIORITY);
  });

  it('routes logical mode to the full queue (non-incremental)', () => {
    const queueForMode = (mode: 'incremental' | 'full' | 'logical') =>
      mode === 'incremental'
        ? BACKUP_INCREMENTAL_QUEUE_NAME
        : BACKUP_FULL_QUEUE_NAME;

    expect(queueForMode('logical')).toBe(BACKUP_FULL_QUEUE_NAME);
    expect(queueForMode('full')).toBe(BACKUP_FULL_QUEUE_NAME);
    expect(queueForMode('incremental')).toBe(BACKUP_INCREMENTAL_QUEUE_NAME);
  });
});
