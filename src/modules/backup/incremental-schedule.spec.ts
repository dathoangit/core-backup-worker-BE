import { describe, expect, it } from '@jest/globals';

import {
  databaseFromIncrementalCronKey,
  groupDatabasesByIncrementalCron,
  incrementalCronSettingKey,
  isPerDatabaseIncrementalCronKey,
  resolveIncrementalCron,
} from './incremental-schedule';

describe('incremental-schedule', () => {
  it('builds and parses per-database cron keys', () => {
    expect(incrementalCronSettingKey('file_service')).toBe(
      'BACKUP_INCREMENTAL_CRON_file_service',
    );
    expect(isPerDatabaseIncrementalCronKey('BACKUP_INCREMENTAL_CRON')).toBe(
      false,
    );
    expect(
      isPerDatabaseIncrementalCronKey('BACKUP_INCREMENTAL_CRON_produce'),
    ).toBe(true);
    expect(
      isPerDatabaseIncrementalCronKey('BACKUP_INCREMENTAL_CRON_LabconnXP'),
    ).toBe(true);
    expect(
      databaseFromIncrementalCronKey('BACKUP_INCREMENTAL_CRON_LabconnXP'),
    ).toBe('LabconnXP');
  });

  it('resolves per-db over group over global', () => {
    const sources = {
      globalCron: '0 */4 * * *',
      hisGroupCron: '0 */6 * * *',
      emrGroupCron: '30 */4 * * *',
      lisGroupCron: '15 */4 * * *',
      perDatabase: { produce: '0 */2 * * *' },
    };

    expect(resolveIncrementalCron('produce', 'HIS', sources)).toBe(
      '0 */2 * * *',
    );
    expect(resolveIncrementalCron('other_his', 'HIS', sources)).toBe(
      '0 */6 * * *',
    );
    expect(resolveIncrementalCron('signer', 'EMR', sources)).toBe(
      '30 */4 * * *',
    );
    expect(resolveIncrementalCron('LabconnXP', 'LIS', sources)).toBe(
      '15 */4 * * *',
    );
  });

  it('groups databases that share a cron into one bucket', () => {
    const buckets = groupDatabasesByIncrementalCron(
      [
        { group: 'HIS', database: 'produce' },
        { group: 'EMR', database: 'signer' },
        { group: 'EMR', database: 'vital_signs' },
      ],
      {
        globalCron: '0 */4 * * *',
        hisGroupCron: '0 */4 * * *',
        emrGroupCron: '30 */2 * * *',
        perDatabase: { vital_signs: '0 1 * * *' },
      },
    );

    expect(buckets).toHaveLength(3);
    const byCron = Object.fromEntries(
      buckets.map((b) => [b.cron, b.databases.map((d) => d.database)]),
    );
    expect(byCron['0 */4 * * *']).toEqual(['produce']);
    expect(byCron['30 */2 * * *']).toEqual(['signer']);
    expect(byCron['0 1 * * *']).toEqual(['vital_signs']);
  });
});
