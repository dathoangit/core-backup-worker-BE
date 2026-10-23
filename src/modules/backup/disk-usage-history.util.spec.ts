import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from '@jest/globals';

import {
  computeDiskGrowthForecast,
  estimateGrowthFromBackupBytes,
  recordDiskUsageSample,
} from './disk-usage-history.util';

describe('disk-usage-history.util', () => {
  it('records one sample per VN day and computes growth', () => {
    const meta = fs.mkdtempSync(path.join(os.tmpdir(), 'disk-hist-'));
    const day1 = new Date('2026-10-20T12:00:00+07:00');
    const day2 = new Date('2026-10-23T12:00:00+07:00');

    recordDiskUsageSample(meta, 1000, day1);
    const samples = recordDiskUsageSample(meta, 4000, day2);
    const forecast = computeDiskGrowthForecast(samples, 9000);

    expect(samples).toHaveLength(2);
    expect(forecast.dailyGrowthBytes).toBe(1000);
    expect(forecast.estimatedDaysUntilFull).toBe(9);
  });

  it('returns null ETA when growth is non-positive', () => {
    const forecast = computeDiskGrowthForecast(
      [
        { date: '2026-10-20', usedBytes: 5000 },
        { date: '2026-10-23', usedBytes: 4000 },
      ],
      10_000,
    );

    expect(forecast.dailyGrowthBytes).toBe(0);
    expect(forecast.estimatedDaysUntilFull).toBeNull();
  });

  it('estimates growth from backup bytes written', () => {
    const forecast = estimateGrowthFromBackupBytes(7000, 21_000, 7);
    expect(forecast.dailyGrowthBytes).toBe(1000);
    expect(forecast.estimatedDaysUntilFull).toBe(21);
  });
});
