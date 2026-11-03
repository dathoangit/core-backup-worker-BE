import { describe, expect, it } from '@jest/globals';

import { buildSchemaDumpArgs } from './schema-dump';

describe('buildSchemaDumpArgs', () => {
  it('excludes tables the role cannot lock', () => {
    const args = buildSchemaDumpArgs({
      host: '10.0.0.1',
      port: 5432,
      user: 'emr_stpaul',
      database: 'signer',
      excludeTables: [{ schema: 'signer', table: 'nguoi_than' }],
    });

    expect(args).toContain('--schema-only');
    expect(args).toContain('--exclude-table');
    expect(args).toContain('"signer"."nguoi_than"');
  });
});
