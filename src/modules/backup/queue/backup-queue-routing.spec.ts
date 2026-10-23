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
});
