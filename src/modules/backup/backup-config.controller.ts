import {
  BadRequestException,
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Post,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { IsObject, IsOptional } from 'class-validator';
import { CronJob } from 'cron';

import { Auth } from '../../decorators';
import {
  isAllowlistedSettingKey,
  isRestartRequiredSettingKey,
} from '../settings/settings.constants';
import { SettingsService } from '../settings/settings.service';
import { BackupScheduler } from './backup.scheduler';

class UpdateBackupConfigDto {
  @IsOptional()
  @IsObject()
  settings?: Record<string, string | null>;
}

@Controller('config')
@ApiTags('config')
export class BackupConfigController {
  constructor(
    private readonly settingsService: SettingsService,
    private readonly backupScheduler: BackupScheduler,
  ) {}

  @Post()
  @HttpCode(HttpStatus.OK)
  @Auth()
  async updateConfig(@Body() body: UpdateBackupConfigDto) {
    const entries = Object.entries(body.settings ?? {});

    if (entries.length === 0) {
      throw new BadRequestException('settings object is required');
    }

    for (const [key, value] of entries) {
      if (!isAllowlistedSettingKey(key)) {
        throw new BadRequestException(`Key ${key} is not allowlisted`);
      }

      if (
        isRestartRequiredSettingKey(key) &&
        typeof value === 'string' &&
        /cron|timezone/i.test(key)
      ) {
        this.assertValidCronOrTimezone(key, value);
      }

      await this.settingsService.update(
        key,
        { value },
        { skipScheduleReload: true },
      );
    }

    const reloaded = await this.backupScheduler.reload();

    return {
      updated: entries.map(([key]) => key),
      schedule: reloaded,
    };
  }

  private assertValidCronOrTimezone(key: string, value: string): void {
    if (key === 'BACKUP_TIMEZONE') {
      try {
        Intl.DateTimeFormat(undefined, { timeZone: value });
      } catch {
        throw new BadRequestException(`Invalid timezone: ${value}`);
      }

      return;
    }

    try {
      // Validate expression without starting
      // eslint-disable-next-line no-new
      new CronJob(value, () => {}, null, false, 'UTC');
    } catch {
      throw new BadRequestException(
        `Invalid cron expression for ${key}: ${value}`,
      );
    }
  }
}
