import path from 'node:path';

import {
  composeDiskUsage,
  formatBytesShort,
  parseDuDatabaseBytes,
  parseDuTotalBytes,
} from './disk-stats.util';

describe('disk-stats.util', () => {
  it('formats byte sizes', () => {
    expect(formatBytesShort(0)).toBe('0 B');
    expect(formatBytesShort(1024)).toBe('1.0 KB');
    expect(formatBytesShort(1536 * 1024 * 1024)).toBe('1.5 GB');
  });

  it('sums database folders and ignores parent du lines', () => {
    const root = path.join('/backup', 'volumes', 'his');
    const stdout = [
      `100\t${path.join(root, 'runs', 'run-1', 'produce')}`,
      `100\t${path.join(root, 'runs', 'run-1')}`,
      `40\t${path.join(root, 'snapshots', 'produce')}`,
      `20\t${path.join(root, 'runs', 'run-2', 'signer')}`,
      `200\t${root}`,
    ].join('\n');

    const usage = parseDuDatabaseBytes(root, stdout);

    expect(usage.get('produce')).toBe(140 * 1024);
    expect(usage.get('signer')).toBe(20 * 1024);
    expect(usage.size).toBe(2);
  });

  it('reads a du total line', () => {
    expect(parseDuTotalBytes('1536\t/backup/volumes/meta\n')).toBe(1536 * 1024);
    expect(parseDuTotalBytes('')).toBe(0);
  });

  it('fits database folders, other data, and free space into one disk', () => {
    const usage = composeDiskUsage({
      path: '/backup',
      exists: true,
      totalBytes: 1000,
      freeBytes: 400,
      availableBytes: 380,
      folders: [
        { id: 'signer', label: 'signer', bytes: 50 },
        { id: 'produce', label: 'produce', bytes: 150 },
        { id: 'empty', label: 'empty', bytes: 0 },
      ],
    });

    expect(usage.usedBytes).toBe(600);
    expect(usage.usedPercent).toBe(60);
    expect(usage.folders.map((folder) => [folder.id, folder.bytes])).toEqual([
      ['produce', 150],
      ['signer', 50],
      ['other', 400],
      ['free', 400],
    ]);
  });

  it('scales folder bytes down when they exceed filesystem used space', () => {
    const usage = composeDiskUsage({
      path: '/backup',
      exists: true,
      totalBytes: 1000,
      freeBytes: 400,
      availableBytes: 400,
      folders: [
        { id: 'produce', label: 'produce', bytes: 900 },
        { id: 'signer', label: 'signer', bytes: 100 },
      ],
    });

    expect(usage.folders.map((folder) => [folder.id, folder.bytes])).toEqual([
      ['produce', 540],
      ['signer', 60],
      ['free', 400],
    ]);
  });
});
