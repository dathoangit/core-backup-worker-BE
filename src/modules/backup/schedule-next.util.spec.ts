import { describe, expect, it } from '@jest/globals';

import {
  buildNextScheduleTimes,
  earliestNextFire,
  formatNextFullLabel,
} from './schedule-next.util';

describe('schedule-next.util', () => {
  it('picks the earliest next fire among cron expressions', () => {
    const next = earliestNextFire(['0 2 * * 0', '0 */4 * * *']);
    expect(next).toBeInstanceOf(Date);
    expect(Number.isNaN(next!.getTime())).toBe(false);
  });

  it('formats next full label in Asia/Ho_Chi_Minh', () => {
    const date = new Date('2026-10-25T01:30:00+07:00');
    expect(formatNextFullLabel(date)).toMatch(/^[A-Za-z]{3} \d{2}:\d{2}$/);
  });

  it('returns databases for the earliest incremental bucket', () => {
    const result = buildNextScheduleTimes({
      enabled: false,
      incrementalBuckets: [
        {
          cron: '0 */4 * * *',
          databases: [
            { group: 'HIS', database: 'produce' },
            { group: 'EMR', database: 'signer' },
          ],
        },
        {
          // Farther weekly job — should not win over */4
          cron: '0 3 * * 0',
          databases: [{ group: 'LIS', database: 'LabconnXP' }],
        },
      ],
      fullGroups: [
        {
          group: 'HIS',
          cron: '0 2 * * 0',
          databases: [{ group: 'HIS', database: 'produce' }],
        },
      ],
    });

    expect(result.nextIncrementalAt).toBeTruthy();
    expect(
      result.nextIncrementalDatabases.map((d) => d.database).sort(),
    ).toEqual(['produce', 'signer'].sort());
    expect(result.nextFullDatabases).toEqual([
      { group: 'HIS', database: 'produce' },
    ]);
    expect(result.nextFullGroups).toEqual(['HIS']);
    expect(result.nextFullLabel).toMatch(/^[A-Za-z]{3} \d{2}:\d{2}$/);
  });
});
