import { describe, expect, it } from '@jest/globals';

import {
  estimatedRowsTotal,
  estimateGzipCompression,
  lagMinutesFromLastStartedAt,
} from './public-overview.util';

describe('public overview metrics helpers', () => {
  it('computes lag minutes from lastStartedAt', () => {
    const now = new Date('2026-10-23T12:00:00.000Z');
    const lag = lagMinutesFromLastStartedAt('2026-10-23T11:45:00.000Z', now);
    expect(lag).toBe(15);
  });

  it('estimates gzip compression from row/byte samples', () => {
    const result = estimateGzipCompression([
      { rowCountTotal: 1000, bytesTotal: 20_000 },
    ]);
    expect(result.compressionRatio).toBe(9);
    expect(result.compressionSavingsPercent).toBe(89);
  });

  it('estimates total rows from percent progress', () => {
    expect(estimatedRowsTotal(500, 25)).toBe(2000);
    expect(estimatedRowsTotal(0, 10)).toBeNull();
  });
});
