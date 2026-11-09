import { describe, expect, it } from '@jest/globals';

import { buildLogicalDumpArgs } from './pg-logical-dump.profile';

describe('buildLogicalDumpArgs', () => {
  it('excludes tables and sequences the role cannot read', () => {
    const args = buildLogicalDumpArgs({
      host: '10.0.0.1',
      port: 5432,
      user: 'emr_stpaul',
      database: 'signer',
      jobs: 4,
      outputDir: '/tmp/signer.partial',
      preferredSchemas: ['adempiere'],
      excludeTableData: ['adempiere.ad_changelog'],
      excludeRelations: [
        { schema: 'signer', table: 'nguoi_than' },
        { schema: 'adempiere', table: 'HEN_KHAM_LAI1111_SEQ' },
      ],
    });

    expect(args).toContain('--exclude-table-data');
    expect(args).toContain('adempiere.ad_changelog');
    expect(args).toContain('--exclude-table');
    expect(args).toContain('"signer"."nguoi_than"');
    expect(args).toContain('"adempiere"."HEN_KHAM_LAI1111_SEQ"');
    expect(args).toContain('-n');
    expect(args).toContain('adempiere');
  });
});
