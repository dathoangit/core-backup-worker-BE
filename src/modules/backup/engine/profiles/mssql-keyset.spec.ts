import { describe, expect, it } from '@jest/globals';

const sortChunks = (files: string[]) =>
  [...files].sort((a, b) => {
    const seqA = a.match(/\.(\d{6})\.csv\.(?:gz|zst)$/)?.[1] ?? '0';
    const seqB = b.match(/\.(\d{6})\.csv\.(?:gz|zst)$/)?.[1] ?? '0';

    return Number.parseInt(seqA, 10) - Number.parseInt(seqB, 10);
  });

describe('lis keyset chunk naming', () => {
  it('orders chunk files by zero-padded sequence (gzip)', () => {
    const files = [
      'dbo.LabResult.000010.csv.gz',
      'dbo.LabResult.000002.csv.gz',
      'dbo.LabResult.000001.csv.gz',
    ];

    expect(sortChunks(files)).toEqual([
      'dbo.LabResult.000001.csv.gz',
      'dbo.LabResult.000002.csv.gz',
      'dbo.LabResult.000010.csv.gz',
    ]);
  });

  it('orders chunk files by zero-padded sequence (zstd)', () => {
    const files = [
      'dbo.LabResult.000010.csv.zst',
      'dbo.LabResult.000002.csv.zst',
      'dbo.LabResult.000001.csv.zst',
    ];

    expect(sortChunks(files)).toEqual([
      'dbo.LabResult.000001.csv.zst',
      'dbo.LabResult.000002.csv.zst',
      'dbo.LabResult.000010.csv.zst',
    ]);
  });
});
