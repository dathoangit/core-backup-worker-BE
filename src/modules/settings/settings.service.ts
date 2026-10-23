import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import {
  ConflictException,
  Injectable,
  Logger,
  MethodNotAllowedException,
  type OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { parse as parseDotenv } from 'dotenv';
import { type Repository } from 'typeorm';

import {
  DEFAULT_INCREMENTAL_CRON,
  isPerDatabaseIncrementalCronKey,
} from '../backup/incremental-schedule';
import { BackupScheduleReloadBus } from '../backup/schedule/backup-schedule-reload.bus';
import {
  type CreateSettingDto,
  type SettingResponseDto,
  type UpdateSettingDto,
} from './dtos/setting.dto';
import { AppSettingEntity } from './entities/app-setting.entity';
import {
  getSettingDef,
  isAllowlistedSettingKey,
  isCronHotReloadSettingKey,
  SETTING_KEY_DEFS,
  type SettingCategory,
  type SettingKeyDef,
} from './settings.constants';
import { decryptSecret, encryptSecret } from './settings-crypto';

/** Default path for one-shot settings bootstrap (not loaded into process.env). */
const DEFAULT_SETTINGS_SEED_FILE = '.env.settings';

@Injectable()
export class SettingsService implements OnModuleInit {
  private readonly logger = new Logger(SettingsService.name);

  constructor(
    @InjectRepository(AppSettingEntity)
    private readonly repo: Repository<AppSettingEntity>,
    private readonly configService: ConfigService,
    private readonly scheduleReloadBus: BackupScheduleReloadBus,
  ) {}

  async onModuleInit(): Promise<void> {
    try {
      // Prefer SETTINGS_SEED_FILE (.env.settings) so runtime .env stays minimal.
      const fromSeed = await this.seedFromSeedFileIfEmpty();

      if (fromSeed === 0) {
        await this.seedFromEnvIfEmpty();
      }

      await this.ensureMissingAllowlistedSettings();
      await this.fillEmptySettingsFromSeedOrEnv();
    } catch (error) {
      this.logger.warn(
        `Settings seed skipped: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  /**
   * First boot: insert allowlisted settings from SETTINGS_SEED_FILE (default
   * `.env.settings`). Secrets are encrypted with SETTINGS_SECRET_KEY.
   * Does not mutate process.env — runtime .env can stay infrastructure-only.
   */
  async seedFromSeedFileIfEmpty(): Promise<number> {
    const count = await this.repo.count();

    if (count > 0) {
      return 0;
    }

    const seed = this.loadSeedFileValues();

    if (!seed) {
      return 0;
    }

    let inserted = 0;

    for (const def of SETTING_KEY_DEFS) {
      const value = this.valueFromSeedOrDefaults(def.key, seed);

      if (value === undefined) {
        continue;
      }

      const row = this.repo.create({
        id: randomUUID() as Uuid,
        key: def.key,
        category: def.category,
        isSecret: def.isSecret,
        value: def.isSecret ? this.encryptOrThrow(value) : value,
      });
      await this.repo.save(row);
      inserted += 1;
    }

    this.logger.log(
      `Seeded ${inserted} settings from seed file (${this.resolveSeedFilePath()})`,
    );

    return inserted;
  }

  async seedFromEnvIfEmpty(): Promise<number> {
    const count = await this.repo.count();

    if (count > 0) {
      return 0;
    }

    let inserted = 0;

    for (const def of SETTING_KEY_DEFS) {
      const value = this.defaultValueForKey(def.key);

      if (value === undefined) {
        continue;
      }

      const row = this.repo.create({
        id: randomUUID() as Uuid,
        key: def.key,
        category: def.category,
        isSecret: def.isSecret,
        value: def.isSecret ? this.encryptOrThrow(value) : value,
      });
      await this.repo.save(row);
      inserted += 1;
    }

    this.logger.log(`Seeded ${inserted} settings from env`);

    return inserted;
  }

  /**
   * Inserts newly allowlisted keys into existing installs.
   * When env has no value, inserts an empty row so FE can fill it (e.g. EMR_PASSWORD).
   * Never overwrites values the operator already set.
   */
  async ensureMissingAllowlistedSettings(): Promise<number> {
    const seed = this.loadSeedFileValues() ?? {};
    let inserted = 0;

    for (const def of SETTING_KEY_DEFS) {
      const existing = await this.repo.findOne({ where: { key: def.key } });

      if (existing) {
        continue;
      }

      const value = this.valueFromSeedOrDefaults(def.key, seed);
      const stored =
        value === undefined
          ? null
          : def.isSecret
            ? this.encryptOrThrow(value)
            : value;

      const row = this.repo.create({
        id: randomUUID() as Uuid,
        key: def.key,
        category: def.category,
        isSecret: def.isSecret,
        value: stored,
      });
      await this.repo.save(row);
      inserted += 1;
    }

    if (inserted > 0) {
      this.logger.log(`Inserted ${inserted} missing settings`);
    }

    return inserted;
  }

  /**
   * Fills allowlisted rows that exist but have an empty value.
   * Prefers SETTINGS_SEED_FILE, then process env. Never overwrites non-empty DB values.
   */
  async fillEmptySettingsFromSeedOrEnv(): Promise<number> {
    const seed = this.loadSeedFileValues() ?? {};
    let filled = 0;

    for (const def of SETTING_KEY_DEFS) {
      const existing = await this.repo.findOne({ where: { key: def.key } });

      if (!existing) {
        continue;
      }

      if (
        existing.value !== null &&
        existing.value !== undefined &&
        existing.value !== ''
      ) {
        continue;
      }

      const value = this.valueFromSeedOrDefaults(def.key, seed);

      if (value === undefined) {
        continue;
      }

      existing.value = def.isSecret ? this.encryptOrThrow(value) : value;
      await this.repo.save(existing);
      filled += 1;
    }

    if (filled > 0) {
      this.logger.log(`Filled ${filled} empty setting(s) from seed file / env`);
    }

    return filled;
  }

  /** @deprecated Use fillEmptySettingsFromSeedOrEnv */
  async fillEmptySettingsFromEnv(): Promise<number> {
    return this.fillEmptySettingsFromSeedOrEnv();
  }

  private resolveSeedFilePath(): string {
    const raw =
      this.configService.get<string>('SETTINGS_SEED_FILE')?.trim() ||
      DEFAULT_SETTINGS_SEED_FILE;

    return path.isAbsolute(raw) ? raw : path.resolve(process.cwd(), raw);
  }

  /** Parse seed file without loading into process.env. */
  private loadSeedFileValues(): Record<string, string> | null {
    const filePath = this.resolveSeedFilePath();

    if (!fs.existsSync(filePath)) {
      return null;
    }

    try {
      const parsed = parseDotenv(fs.readFileSync(filePath));
      const out: Record<string, string> = {};

      for (const [key, value] of Object.entries(parsed)) {
        if (value !== undefined && value !== '') {
          out[key] = value;
        }
      }

      return out;
    } catch (error) {
      this.logger.warn(
        `Failed to read settings seed file ${filePath}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );

      return null;
    }
  }

  private valueFromSeedOrDefaults(
    key: string,
    seed: Record<string, string>,
  ): string | undefined {
    const fromSeed = seed[key];

    if (fromSeed !== undefined && fromSeed !== '') {
      return fromSeed;
    }

    return this.defaultValueForKey(key);
  }

  private defaultValueForKey(key: string): string | undefined {
    const fromEnv = this.configService.get<string>(key);

    if (fromEnv !== undefined && fromEnv !== null && fromEnv !== '') {
      return fromEnv;
    }

    if (
      key === 'BACKUP_HIS_INCREMENTAL_CRON' ||
      key === 'BACKUP_EMR_INCREMENTAL_CRON' ||
      key === 'BACKUP_LIS_INCREMENTAL_CRON'
    ) {
      return (
        this.configService.get<string>('BACKUP_INCREMENTAL_CRON') ??
        this.configService.get<string>('BACKUP_SCHEDULE_CRON') ??
        DEFAULT_INCREMENTAL_CRON
      );
    }

    if (key.startsWith('BACKUP_INCREMENTAL_CRON_')) {
      const database = key.slice('BACKUP_INCREMENTAL_CRON_'.length);

      if (!database) {
        return undefined;
      }

      return (
        this.configService.get<string>('BACKUP_INCREMENTAL_CRON') ??
        this.configService.get<string>('BACKUP_SCHEDULE_CRON') ??
        DEFAULT_INCREMENTAL_CRON
      );
    }

    if (key === 'BACKUP_DEV_ROW_LIMIT') {
      return '0';
    }

    if (key === 'BACKUP_RETENTION_DAYS') {
      return '15';
    }

    if (key === 'ALERT_DISK_FREE_THRESHOLD_PERCENT') {
      return '15';
    }

    if (
      key === 'ALERT_TELEGRAM_ENABLED' ||
      key === 'ALERT_EMAIL_ENABLED' ||
      key === 'ALERT_SMTP_SECURE'
    ) {
      return 'false';
    }

    return undefined;
  }

  /**
   * Resolved plaintext value: DB first.
   * Secrets (*_PASSWORD / isSecret) never fall back to env — runtime reads DB only.
   * Non-secrets may fall back to env when the DB row is empty.
   * Decrypts secrets transparently.
   */
  async get(key: string): Promise<string | undefined> {
    const row = await this.repo.findOne({ where: { key } });

    if (row?.value !== null && row?.value !== undefined && row.value !== '') {
      if (row.isSecret) {
        try {
          return decryptSecret(row.value, this.secretKey());
        } catch (error) {
          this.logger.warn(
            `Failed to decrypt ${key}: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );

          return undefined;
        }
      }

      return row.value;
    }

    if (this.isSecretSettingKey(key)) {
      return undefined;
    }

    const fromEnv = this.configService.get<string>(key);

    return fromEnv === null || fromEnv === undefined || fromEnv === ''
      ? undefined
      : fromEnv;
  }

  private isSecretSettingKey(key: string): boolean {
    const def = getSettingDef(key);

    if (def?.isSecret) {
      return true;
    }

    return key.endsWith('_PASSWORD');
  }

  async getOrDefault(key: string, fallback: string): Promise<string> {
    return (await this.get(key)) ?? fallback;
  }

  async list(category?: SettingCategory): Promise<SettingResponseDto[]> {
    const where = category ? { category } : {};
    const rows = await this.repo.find({
      where,
      order: { category: 'ASC', key: 'ASC' },
    });
    const byKey = new Map(rows.map((row) => [row.key, row]));

    const defs = category
      ? SETTING_KEY_DEFS.filter((def) => def.category === category)
      : SETTING_KEY_DEFS;

    const result: SettingResponseDto[] = [];
    const seen = new Set<string>();

    for (const def of defs) {
      seen.add(def.key);
      const row = byKey.get(def.key);
      result.push(row ? this.toResponse(row) : this.toPlaceholderResponse(def));
    }

    // Extra allowlisted rows (e.g. per-DB cron added later) not in static defs.
    for (const row of rows) {
      if (seen.has(row.key) || !isAllowlistedSettingKey(row.key)) {
        continue;
      }

      result.push(this.toResponse(row));
    }

    return result.sort((a, b) => {
      if (a.category !== b.category) {
        return a.category.localeCompare(b.category);
      }

      return a.key.localeCompare(b.key);
    });
  }

  async getOne(key: string): Promise<SettingResponseDto> {
    this.assertAllowlisted(key);
    const row = await this.repo.findOne({ where: { key } });

    if (row) {
      return this.toResponse(row);
    }

    return this.toPlaceholderResponse(this.resolveSettingDef(key));
  }

  async create(_dto: CreateSettingDto): Promise<SettingResponseDto> {
    throw new MethodNotAllowedException(
      'Creating settings is not allowed; use PUT /admin/settings/:key to upsert',
    );
  }

  /**
   * Upsert allowlisted setting. Missing rows (e.g. EMR_PASSWORD never seeded)
   * are created so operators can fill secrets from the FE without editing env.
   */
  async update(
    key: string,
    dto: UpdateSettingDto,
    options?: { skipScheduleReload?: boolean },
  ): Promise<SettingResponseDto> {
    this.assertAllowlisted(key);

    let row = await this.repo.findOne({ where: { key } });

    if (!row) {
      const def = this.resolveSettingDef(key);
      row = this.repo.create({
        id: randomUUID() as Uuid,
        key: def.key,
        category: def.category,
        isSecret: def.isSecret,
        value: null,
      });
    }

    if (dto.value !== undefined) {
      const raw = dto.value;
      row.value =
        raw !== null && raw !== '' && row.isSecret
          ? this.encryptOrThrow(raw)
          : raw;
    }

    const saved = await this.repo.save(row);

    if (!options?.skipScheduleReload && isCronHotReloadSettingKey(key)) {
      try {
        await this.scheduleReloadBus.requestReload();
      } catch (error) {
        this.logger.warn(
          `Schedule reload after updating ${key} failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }

    return this.toResponse(saved);
  }

  async remove(_key: string): Promise<void> {
    throw new MethodNotAllowedException(
      'Deleting settings is not allowed; update the value instead',
    );
  }

  private assertAllowlisted(key: string): void {
    if (!isAllowlistedSettingKey(key)) {
      throw new ConflictException(
        `Key ${key} is not in the allowlist of manageable settings`,
      );
    }
  }

  private resolveSettingDef(key: string): SettingKeyDef {
    const def = getSettingDef(key);

    if (def) {
      return def;
    }

    if (isPerDatabaseIncrementalCronKey(key)) {
      return { key, category: 'backup', isSecret: false };
    }

    throw new ConflictException(
      `Key ${key} is not in the allowlist of manageable settings`,
    );
  }

  /** Virtual row for allowlisted keys not yet persisted (FE can still edit via PUT). */
  private toPlaceholderResponse(def: SettingKeyDef): SettingResponseDto {
    const epoch = new Date(0);

    return {
      id: '',
      key: def.key,
      value: null,
      isSecret: def.isSecret,
      hasValue: false,
      category: def.category,
      createdAt: epoch,
      updatedAt: epoch,
    };
  }

  private secretKey(): string {
    return this.configService.get<string>('SETTINGS_SECRET_KEY') ?? '';
  }

  private encryptOrThrow(plaintext: string): string {
    return encryptSecret(plaintext, this.secretKey());
  }

  private toResponse(row: AppSettingEntity): SettingResponseDto {
    const hasValue =
      row.value !== null && row.value !== undefined && row.value !== '';

    return {
      id: row.id,
      key: row.key,
      value: row.isSecret ? null : row.value,
      isSecret: row.isSecret,
      hasValue,
      category: row.category,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }
}
