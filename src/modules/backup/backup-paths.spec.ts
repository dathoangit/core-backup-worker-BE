import path from 'node:path';

import { describe, expect, it } from '@jest/globals';

import {
  applyDevRowLimitPolicy,
  resolveBackupPaths,
  volumeDirForDatabase,
  volumeGroupForDatabase,
} from './backup-paths';

describe('backup-paths', () => {
  const cwd = '/repo/core-backup-worker-BE';

  it('resolves relative volumes under BACKUP_ROOT', () => {
    const resolved = resolveBackupPaths({
      backupRoot: '../.backup-dev',
      cwd,
      isDevelopment: true,
    });

    expect(resolved.backupRoot).toBe(path.resolve(cwd, '../.backup-dev'));
    expect(resolved.metaDir).toBe(
      path.join(resolved.backupRoot!, 'volumes', 'meta'),
    );
    expect(resolved.volumeDirs.HIS).toBe(
      path.join(resolved.backupRoot!, 'volumes', 'his'),
    );
    expect(resolved.volumeDirs.EMR).toBe(
      path.join(resolved.backupRoot!, 'volumes', 'emr'),
    );
    expect(resolved.volumeDirs.LIS).toBe(
      path.join(resolved.backupRoot!, 'volumes', 'lis'),
    );
  });

  it('keeps absolute volume paths independent of root', () => {
    const resolved = resolveBackupPaths({
      backupRoot: '/unused',
      volumeMeta: '/mnt/meta',
      volumeHis: 'D:\\his',
      volumeEmr: '/mnt/emr',
      cwd,
      isDevelopment: false,
    });

    expect(resolved.metaDir).toBe('/mnt/meta');
    expect(resolved.volumeDirs.HIS).toBe('D:\\his');
    expect(resolved.volumeDirs.EMR).toBe('/mnt/emr');
  });

  it('maps produce to HIS volume and other DBs to EMR', () => {
    const dirs = { HIS: '/his', EMR: '/emr', LIS: '/lis' };
    expect(volumeGroupForDatabase('produce')).toBe('HIS');
    expect(volumeGroupForDatabase('signer')).toBe('EMR');
    expect(volumeGroupForDatabase('LabconnXP')).toBe('LIS');
    expect(volumeDirForDatabase(dirs, 'produce')).toBe('/his');
    expect(volumeDirForDatabase(dirs, 'signer')).toBe('/emr');
    expect(volumeDirForDatabase(dirs, 'LabconnXP')).toBe('/lis');
  });

  it('enforces dev vs production row-limit policy', () => {
    expect(applyDevRowLimitPolicy(undefined, true)).toBe(100);
    expect(applyDevRowLimitPolicy(50, true)).toBe(50);
    expect(applyDevRowLimitPolicy(0, true)).toBe(100);
    expect(applyDevRowLimitPolicy(undefined, false)).toBe(0);
    expect(applyDevRowLimitPolicy(0, false)).toBe(0);
    expect(() => applyDevRowLimitPolicy(10, false)).toThrow(/production/);
  });

  it('defaults BACKUP_ROOT to repo .backup-dev in development', () => {
    const resolved = resolveBackupPaths({
      cwd,
      isDevelopment: true,
    });

    expect(resolved.backupRoot).toBe(path.resolve(cwd, '../.backup-dev'));
    expect(resolved.volumeDirs.HIS).not.toBe(resolved.volumeDirs.EMR);
    expect(resolved.metaDir).not.toBe(resolved.volumeDirs.HIS);
  });

  it('requires configured paths in production when unset', () => {
    expect(() =>
      resolveBackupPaths({
        cwd,
        isDevelopment: false,
      }),
    ).toThrow(/Missing backup paths/);
  });
});
