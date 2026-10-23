import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  MethodNotAllowedException,
  OnModuleInit,
  Optional,
  forwardRef,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import type { Repository } from 'typeorm';
import { randomUUID } from 'node:crypto';

import { BackupService } from '../backup/backup.service';
import {
  getSettingDef,
  isAllowlistedSettingKey,
  isRestartRequiredSettingKey,
  SETTING_KEY_DEFS,
  type SettingCategory,
  type SettingKeyDef,
} from './settings.constants';
import {
  DEFAULT_INCREMENTAL_CRON,
  isPerDatabaseIncrementalCronKey,
} from '../backup/incremental-schedule';
import { decryptSecret, encryptSecret } from './settings-crypto';
import type {
  CreateSettingDto,
  SettingResponseDto,
  UpdateSettingDto,
} from './dtos/setting.dto';
import { AppSettingEntity } from './entities/app-setting.entity';

@Injectable()
export class SettingsService implements OnModuleInit {
  private readonly logger = new Logger(SettingsService.name);

  constructor(
    @InjectRepository(AppSettingEntity)
    private readonly repo: Repository<AppSettingEntity>,
    private readonly configService: ConfigService,
    @Optional()
    @Inject(forwardRef(() => BackupService))
    private readonly backupService?: BackupService,
  ) {}

  async onModuleInit(): Promise<void> {
    try {
      await this.seedFromEnvIfEmpty();
      await this.ensureMissingAllowlistedSettings();
      await this.fillEmptySettingsFromEnv();
    } catch (error) {
      this.logger.warn(
        `Settings seed skipped: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
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
    let inserted = 0;
    for (const def of SETTING_KEY_DEFS) {
      const existing = await this.repo.findOne({ where: { key: def.key } });
      if (existing) {
        continue;
      }

      const value = this.defaultValueForKey(def.key);
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
   * Fills allowlisted rows that exist but have an empty value, from process env.
   * Does not overwrite non-empty DB values (use `yarn settings:sync-from-env -- --force`).
   */
  async fillEmptySettingsFromEnv(): Promise<number> {
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

      const value = this.defaultValueForKey(def.key);
      if (value === undefined) {
        continue;
      }

      existing.value = def.isSecret ? this.encryptOrThrow(value) : value;
      await this.repo.save(existing);
      filled += 1;
    }

    if (filled > 0) {
      this.logger.log(`Filled ${filled} empty setting(s) from env`);
    }

    return filled;
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

    return undefined;
  }

  /**
   * Resolved plaintext value: DB first, then env fallback.
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
            `Failed to decrypt ${key}: ${error instanceof Error ? error.message : String(error)}`,
          );

          return undefined;
        }
      }

      return row.value;
    }

    const fromEnv = this.configService.get<string>(key);

    return fromEnv === null || fromEnv === undefined || fromEnv === ''
      ? undefined
      : fromEnv;
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
  async update(key: string, dto: UpdateSettingDto): Promise<SettingResponseDto> {
    this.assertAllowlisted(key);
    await this.assertCanMutateRestartRequiredKey(key);

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

  private async assertCanMutateRestartRequiredKey(key: string): Promise<void> {
    if (!isRestartRequiredSettingKey(key)) {
      return;
    }

    if (!this.backupService) {
      return;
    }

    if (await this.backupService.isBackupInProgress()) {
      const runId = this.backupService.getInFlightRunId();
      throw new ForbiddenException(
        runId
          ? `Cannot change ${key} while backup ${runId} is running. Wait for it to finish, then restart the backend after updating cron/timezone.`
          : `Cannot change ${key} while a backup is in progress (lock held). Wait for it to finish, then restart the backend after updating cron/timezone.`,
      );
    }
  }

  private secretKey(): string {
    return this.configService.get<string>('SETTINGS_SECRET_KEY') ?? '';
  }

  private encryptOrThrow(plaintext: string): string {
    return encryptSecret(plaintext, this.secretKey());
  }

  private toResponse(row: AppSettingEntity): SettingResponseDto {
    const hasValue = row.value !== null && row.value !== undefined && row.value !== '';

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
