import { describe, expect, it } from '@jest/globals';

import {
  buildIdRange,
  chunkKey,
  formatWatermark,
  parseWatermark,
  splitIdRange,
} from './checkpoint';

describe('buildIdRange', () => {
  it('returns null when captured equals saved', () => {
    expect(buildIdRange(100n, 100n)).toBeNull();
  });

  it('returns null when captured is below saved', () => {
    expect(buildIdRange(100n, 99n)).toBeNull();
  });

  it('uses exclusive lower bound after a saved watermark', () => {
    expect(buildIdRange(100n, 150n)).toEqual({
      fromExclusive: 100n,
      toInclusive: 150n,
    });
  });

  it('starts from 0 on first run so ids begin at 1', () => {
    expect(buildIdRange(null, 50n)).toEqual({
      fromExclusive: 0n,
      toInclusive: 50n,
    });
  });
});

describe('splitIdRange', () => {
  it('splits into contiguous exclusive/inclusive chunks', () => {
    const chunks = splitIdRange({ fromExclusive: 0n, toInclusive: 25n }, 10n);
    expect(chunks).toEqual([
      { fromExclusive: 0n, toInclusive: 10n },
      { fromExclusive: 10n, toInclusive: 20n },
      { fromExclusive: 20n, toInclusive: 25n },
    ]);
  });

  it('keeps a single chunk when range fits', () => {
    const chunks = splitIdRange({ fromExclusive: 10n, toInclusive: 15n }, 100n);
    expect(chunks).toEqual([{ fromExclusive: 10n, toInclusive: 15n }]);
  });
});

describe('watermark helpers', () => {
  it('round-trips bigint watermarks as strings', () => {
    expect(formatWatermark(1_163_406_409n)).toBe('1163406409');
    expect(parseWatermark('1163406409')).toBe(1_163_406_409n);
    expect(parseWatermark(null)).toBeNull();
  });

  it('builds stable chunk keys', () => {
    expect(chunkKey('adempiere', 'ad_changelog', 0n, 1000n)).toBe(
      'adempiere.ad_changelog:0:1000',
    );
  });
});
