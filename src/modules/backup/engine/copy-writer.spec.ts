import { describe, expect, it } from '@jest/globals';

import { withDevRowLimit } from './copy-writer';

describe('withDevRowLimit', () => {
  it('returns original SQL when limit unset or <= 0', () => {
    const sql = 'SELECT * FROM foo';
    expect(withDevRowLimit(sql)).toBe(sql);
    expect(withDevRowLimit(sql, 0)).toBe(sql);
    expect(withDevRowLimit(sql, -1)).toBe(sql);
  });

  it('wraps SELECT with LIMIT for sample dumps', () => {
    expect(withDevRowLimit('SELECT * FROM foo', 100)).toBe(
      'SELECT * FROM (SELECT * FROM foo) AS _backup_dev_sample LIMIT 100',
    );
  });
});
