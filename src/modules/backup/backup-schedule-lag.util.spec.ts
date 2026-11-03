import { afterEach, describe, expect, it, jest } from '@jest/globals';

import {
  BACKUP_LAG_GRACE_MINUTES,
  cronPreviousScheduledFire,
  resolveBackupLagState,
} from './backup-schedule-lag.util';

const TZ = 'Asia/Ho_Chi_Minh';
const CRON = '0 */4 * * *';

describe('backup-schedule-lag.util', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it('marks backup within the current 4h window as on_time', () => {
    jest.useFakeTimers({
      now: new Date('2026-10-24T07:51:00.000Z'),
    });

    const state = resolveBackupLagState({
      lastOkAt: '2026-10-24T05:01:00.000Z',
      lastDbStatus: 'ok',
      cronExpr: CRON,
      timezone: TZ,
    });

    expect(state).toBe('on_time');
  });

  it('stays on schedule until two days even if a cron slot was missed', () => {
    jest.useFakeTimers({
      now: new Date('2026-10-24T09:35:00.000Z'),
    });

    const state = resolveBackupLagState({
      lastOkAt: '2026-10-23T21:00:00.000Z',
      lastDbStatus: 'ok',
      cronExpr: CRON,
      timezone: TZ,
      graceMinutes: BACKUP_LAG_GRACE_MINUTES,
    });

    expect(state).toBe('on_time');
  });

  it('turns yellow after two days and before one week', () => {
    jest.useFakeTimers({
      now: new Date('2026-10-26T10:00:00.000Z'),
    });

    const state = resolveBackupLagState({
      lastOkAt: '2026-10-24T05:00:00.000Z',
      lastDbStatus: 'ok',
      cronExpr: CRON,
      timezone: TZ,
      graceMinutes: BACKUP_LAG_GRACE_MINUTES,
    });

    expect(state).toBe('overdue');
  });

  it('marks lag older than one week as missed', () => {
    jest.useFakeTimers({
      now: new Date('2026-10-24T09:35:00.000Z'),
    });

    const state = resolveBackupLagState({
      lastOkAt: '2026-10-16T09:00:00.000Z',
      lastDbStatus: 'ok',
      cronExpr: CRON,
      timezone: TZ,
      graceMinutes: BACKUP_LAG_GRACE_MINUTES,
    });

    expect(state).toBe('missed');
  });

  it('keeps on_time during grace right after a cron tick', () => {
    jest.useFakeTimers({
      now: new Date('2026-10-24T09:10:00.000Z'),
    });

    const prev = cronPreviousScheduledFire(CRON, TZ);
    expect(prev?.toISOString()).toBe('2026-10-24T09:00:00.000Z');

    const state = resolveBackupLagState({
      lastOkAt: '2026-10-24T05:01:00.000Z',
      lastDbStatus: 'ok',
      cronExpr: CRON,
      timezone: TZ,
    });

    expect(state).toBe('on_time');
  });

  it('returns error when the last database run failed', () => {
    const state = resolveBackupLagState({
      lastOkAt: '2026-10-24T05:01:00.000Z',
      lastDbStatus: 'error',
      cronExpr: CRON,
      timezone: TZ,
    });

    expect(state).toBe('error');
  });
});
