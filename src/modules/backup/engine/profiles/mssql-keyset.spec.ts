import { describe, expect, it } from '@jest/globals';

describe('lis keyset chunk naming', () => {
  it('orders chunk files by zero-padded sequence', () => {
    const files = [
      'dbo.LabResult.000010.csv.gz',
      'dbo.LabResult.000002.csv.gz',
      'dbo.LabResult.000001.csv.gz',
    ];

    const sorted = [...files].sort((a, b) => {
      const seqA = a.match(/\.(\d{6})\.csv\.gz$/)?.[1] ?? '0';
      const seqB = b.match(/\.(\d{6})\.csv\.gz$/)?.[1] ?? '0';

      return Number.parseInt(seqA, 10) - Number.parseInt(seqB, 10);
    });

    expect(sorted).toEqual([
      'dbo.LabResult.000001.csv.gz',
      'dbo.LabResult.000002.csv.gz',
      'dbo.LabResult.000010.csv.gz',
    ]);
  });
});
