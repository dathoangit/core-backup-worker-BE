/* eslint-disable no-console */
/* eslint-disable n/no-process-exit */
/* eslint-disable unicorn/no-process-exit */
/* eslint-disable unicorn/prefer-top-level-await */
import { NestFactory } from '@nestjs/core';

import { BackupService } from './backup.service';
import { BackupWorkerModule } from './backup-worker.module';
import { type SourceGroup } from './types';

const SOURCE_GROUPS = new Set<SourceGroup>([
  'HIS',
  'EMR',
  'BADL',
  'LIS',
  'PACS',
]);

function readSourceGroups(): SourceGroup[] | undefined {
  const index = process.argv.indexOf('--group');

  if (index === -1) {
    return undefined;
  }

  const raw = process.argv[index + 1];

  if (!raw) {
    throw new Error('--group requires a value such as LIS');
  }

  const groups = raw
    .split(',')
    .map((part) => part.trim().toUpperCase())
    .filter((part): part is SourceGroup =>
      SOURCE_GROUPS.has(part as SourceGroup),
    );

  if (groups.length === 0) {
    throw new Error(`Unknown --group value: ${raw}`);
  }

  return groups;
}

async function main(): Promise<void> {
  const app = await NestFactory.createApplicationContext(BackupWorkerModule, {
    logger: ['error', 'warn', 'log'],
  });

  let exitCode = 0;

  try {
    const backupService = app.get(BackupService);
    console.log('[backup] starting via Nest standalone context');
    const manifest = await backupService.runOnceAndWait({
      trigger: 'manual',
      mode: process.argv.includes('--full') ? 'full' : 'incremental',
      sourceGroups: readSourceGroups(),
    });
    const failed = manifest.databases.filter((d) => d.status === 'error');
    console.log(
      `[backup] finished run ${manifest.runId}: ${manifest.databases.length} databases, ${failed.length} errors`,
    );
    exitCode = failed.length > 0 ? 1 : 0;
  } catch (error) {
    console.error('[backup] fatal', error);
    exitCode = 1;
  } finally {
    await app.close();
  }

  process.exit(exitCode);
}

void main();
