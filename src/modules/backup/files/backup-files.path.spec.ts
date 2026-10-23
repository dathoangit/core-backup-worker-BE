import path from 'node:path';

import { describe, expect, it } from '@jest/globals';

/** Mirrors BackupFilesService relative-path rejection rules (unit, no Nest). */
function isUnsafeRelativePath(relativePath: string): boolean {
  if (
    !relativePath ||
    relativePath.includes('\0') ||
    path.isAbsolute(relativePath) ||
    relativePath.split(/[/\\]/).includes('..')
  ) {
    return true;
  }

  return false;
}

describe('backup files path guard', () => {
  it('rejects traversal and absolute paths', () => {
    expect(isUnsafeRelativePath('../etc/passwd')).toBe(true);
    expect(isUnsafeRelativePath('/etc/passwd')).toBe(true);
    expect(isUnsafeRelativePath('runs/../../secret')).toBe(true);
    expect(isUnsafeRelativePath('')).toBe(true);
  });

  it('allows nested run paths', () => {
    expect(
      isUnsafeRelativePath('runs/run-1/produce/full/adempiere.ad_user.csv.gz'),
    ).toBe(false);
  });
});
