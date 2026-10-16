import {
  aggregateHistoryByDay,
  summarizeJobs,
  toVnDateKey,
  truncateError,
} from './public-overview.util';

describe('public-overview.util', () => {
  it('formats VN date keys', () => {
    // 2026-03-15 17:00 UTC = 2026-03-16 00:00 VN
    expect(toVnDateKey(new Date('2026-03-15T17:00:00.000Z'))).toBe(
      '2026-03-16',
    );
  });

  it('aggregates history into fixed 14-day window', () => {
    const now = new Date('2026-03-16T05:00:00.000Z');
    const history = aggregateHistoryByDay(
      [
        { startedAt: new Date('2026-03-16T01:00:00.000Z'), status: 'ok' },
        { startedAt: new Date('2026-03-16T02:00:00.000Z'), status: 'error' },
        { startedAt: new Date('2026-03-15T10:00:00.000Z'), status: 'partial' },
      ],
      now,
    );

    expect(history).toHaveLength(14);
    expect(history[history.length - 1]?.date).toBe('2026-03-16');
    expect(history[history.length - 1]).toMatchObject({
      ok: 1,
      error: 1,
      partial: 0,
      running: 0,
    });
  });

  it('falls back job summary to full sample when 24h window empty', () => {
    const now = new Date('2026-03-16T05:00:00.000Z');
    const summary = summarizeJobs(
      [{ startedAt: new Date('2026-01-01T00:00:00.000Z'), status: 'ok' }],
      now,
    );
    expect(summary).toEqual({
      ok: 1,
      error: 0,
      partial: 0,
      running: 0,
      total: 1,
    });
  });

  it('truncates long errors', () => {
    expect(truncateError('x'.repeat(200))?.length).toBe(120);
    expect(truncateError(null)).toBeNull();
  });
});
