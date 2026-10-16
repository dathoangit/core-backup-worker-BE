import { formatBytesShort } from './disk-stats.util';

describe('disk-stats.util', () => {
  it('formats byte sizes', () => {
    expect(formatBytesShort(0)).toBe('0 B');
    expect(formatBytesShort(1024)).toBe('1.0 KB');
    expect(formatBytesShort(1536 * 1024 * 1024)).toBe('1.5 GB');
  });
});
