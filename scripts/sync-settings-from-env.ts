/* eslint-disable no-console */
/* eslint-disable n/no-process-exit */
/* eslint-disable unicorn/no-process-exit */
/**
 * Upsert allowlisted app_settings from an env file into the app database.
 *
 * Usage (from core-backup-worker-BE):
 *   yarn settings:sync-from-env
 *   yarn settings:sync-from-env -- --env-file=.env.production --force
 *   yarn settings:sync-from-env -- --sources --force --dry-run
 *
 * Default: only HIS_/EMR_/LIS_/BADL_ keys (credentials + hosts).
 * --all: every allowlisted key present in the env file (still skips volume paths
 *        unless --include-paths).
 * --force: overwrite non-empty DB values.
 * Without --force: insert missing / fill empty only.
 */
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { config as loadEnv } from 'dotenv';
import { DataSource } from 'typeorm';

import { SETTING_KEY_DEFS } from '../src/modules/settings/settings.constants';
import { encryptSecret } from '../src/modules/settings/settings-crypto';
import { AppSettingEntity } from '../src/modules/settings/entities/app-setting.entity';
import { SnakeNamingStrategy } from '../src/snake-naming.strategy';

const VOLUME_PATH_KEYS = new Set([
  'BACKUP_DIR',
  'BACKUP_ROOT',
  'BACKUP_VOLUME_META',
  'BACKUP_VOLUME_HIS',
  'BACKUP_VOLUME_EMR',
  'BACKUP_VOLUME_LIS',
]);

function hasFlag(name: string): boolean {
  return process.argv.includes(name);
}

function readArg(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  if (index === -1) {
    return undefined;
  }

  return process.argv[index + 1];
}

function isSourceKey(key: string): boolean {
  return /^(HIS|EMR|LIS|BADL)_/.test(key);
}

function resolveEnvFile(): string {
  const fromArg = readArg('--env-file');
  if (fromArg) {
    return path.resolve(process.cwd(), fromArg);
  }

  if (process.env.NODE_ENV === 'production') {
    const prod = path.resolve(process.cwd(), '.env.production');
    if (fs.existsSync(prod)) {
      return prod;
    }
  }

  return path.resolve(process.cwd(), '.env');
}

async function main(): Promise<void> {
  const envFile = resolveEnvFile();
  if (!fs.existsSync(envFile)) {
    throw new Error(`Env file not found: ${envFile}`);
  }

  loadEnv({ path: envFile, override: true });

  const force = hasFlag('--force');
  const dryRun = hasFlag('--dry-run');
  const allKeys = hasFlag('--all');
  const includePaths = hasFlag('--include-paths');
  const sourcesOnly = !allKeys;

  const secretKey = process.env.SETTINGS_SECRET_KEY ?? '';
  if (!secretKey.trim()) {
    throw new Error(
      'SETTINGS_SECRET_KEY is required in the env file (must match the running app)',
    );
  }

  const dbType = (process.env.DB_TYPE || 'postgres').toLowerCase();
  const normalizedDbType = dbType === 'mysql' ? 'mysql' : 'postgres';

  const dataSource = new DataSource({
    type: normalizedDbType,
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT),
    username: process.env.DB_USERNAME,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_DATABASE,
    ...(normalizedDbType === 'mysql' ? { charset: 'utf8mb4_unicode_ci' } : {}),
    namingStrategy: new SnakeNamingStrategy(),
    entities: [AppSettingEntity],
    synchronize: false,
  });

  await dataSource.initialize();
  const repo = dataSource.getRepository(AppSettingEntity);

  let inserted = 0;
  let updated = 0;
  let skipped = 0;

  console.log(
    `[settings:sync] file=${envFile} db=${process.env.DB_HOST}/${process.env.DB_DATABASE} ` +
      `mode=${sourcesOnly ? 'sources' : 'all'}${includePaths ? '+paths' : ''} ` +
      `force=${force} dryRun=${dryRun}`,
  );

  for (const def of SETTING_KEY_DEFS) {
    if (sourcesOnly && !isSourceKey(def.key)) {
      continue;
    }

    if (!includePaths && VOLUME_PATH_KEYS.has(def.key)) {
      skipped += 1;
      continue;
    }

    const fromEnv = process.env[def.key];
    if (fromEnv === undefined || fromEnv === null || fromEnv === '') {
      skipped += 1;
      continue;
    }

    const storedValue = def.isSecret
      ? encryptSecret(fromEnv, secretKey)
      : fromEnv;

    const existing = await repo.findOne({ where: { key: def.key } });
    if (!existing) {
      console.log(`  + insert ${def.key}${def.isSecret ? ' (secret)' : ''}`);
      if (!dryRun) {
        await repo.save(
          repo.create({
            id: randomUUID() as Uuid,
            key: def.key,
            category: def.category,
            isSecret: def.isSecret,
            value: storedValue,
          }),
        );
      }
      inserted += 1;
      continue;
    }

    const empty =
      existing.value === null ||
      existing.value === undefined ||
      existing.value === '';
    if (!empty && !force) {
      skipped += 1;
      continue;
    }

    console.log(
      `  ~ ${empty ? 'fill' : 'overwrite'} ${def.key}${
        def.isSecret ? ' (secret)' : ''
      }`,
    );
    if (!dryRun) {
      existing.value = storedValue;
      existing.isSecret = def.isSecret;
      existing.category = def.category;
      await repo.save(existing);
    }
    updated += 1;
  }

  await dataSource.destroy();

  console.log(
    `[settings:sync] done inserted=${inserted} updated=${updated} skipped=${skipped}` +
      (dryRun ? ' (dry-run)' : ''),
  );
}

void main().catch((error: unknown) => {
  console.error(
    '[settings:sync] fatal',
    error instanceof Error ? error.message : error,
  );
  process.exit(1);
});
