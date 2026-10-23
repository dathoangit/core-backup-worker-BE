import {
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { type Subscription } from 'rxjs';

import { BackupConfigService } from '../backup/backup-config.service';
import { collectBackupDiskUsage } from '../backup/disk-stats.util';
import { BackupEventsService } from '../backup/events/backup-events.service';
import { type BackupRunStatusEvent } from '../backup/events/backup-events.types';
import { RedisCacheService } from '../cache/redis-cache.service';
import { SettingsService } from '../settings/settings.service';
import { EmailNotifier } from './email.notifier';
import { TelegramNotifier } from './telegram.notifier';

const DISK_ALERT_REDIS_KEY = 'alerts:disk-low';

@Injectable()
export class AlertService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AlertService.name);

  private subscription: Subscription | null = null;

  private diskAlertActive = false;

  constructor(
    private readonly backupEvents: BackupEventsService,
    private readonly settings: SettingsService,
    private readonly backupConfig: BackupConfigService,
    private readonly telegram: TelegramNotifier,
    private readonly email: EmailNotifier,
    private readonly redis: RedisCacheService,
  ) {}

  onModuleInit(): void {
    this.subscription = this.backupEvents.events$.subscribe((event) => {
      if (event.type !== 'run.status') {
        return;
      }

      if (event.status !== 'error' && event.status !== 'partial') {
        return;
      }

      void this.notifyRunFailure(event);
    });

    void this.redis
      .getString(DISK_ALERT_REDIS_KEY, 'alerts disk state')
      .then((value) => {
        this.diskAlertActive = value === '1';
      })
      .catch(() => {
        /* ignore */
      });
  }

  onModuleDestroy(): void {
    this.subscription?.unsubscribe();
  }

  async sendTest(channel: 'telegram' | 'email'): Promise<{ ok: true }> {
    const text = `[Backup Worker] Test alert (${channel}) at ${new Date().toISOString()}`;

    await (channel === 'telegram'
      ? this.sendTelegram(text)
      : this.sendEmail('[Backup Worker] Test alert', text));

    return { ok: true };
  }

  @Cron(CronExpression.EVERY_10_MINUTES)
  async checkDiskThreshold(): Promise<void> {
    try {
      const settings = await this.backupConfig.getSettings();
      const disk = await collectBackupDiskUsage({
        diskPath: settings.backupRoot ?? settings.backupDir,
        metaPath: settings.backupDir,
        volumePaths: [
          settings.volumeDirs.HIS,
          settings.volumeDirs.EMR,
          settings.volumeDirs.LIS,
        ],
      });

      if (!disk.exists) {
        return;
      }

      const thresholdRaw = await this.settings.get(
        'ALERT_DISK_FREE_THRESHOLD_PERCENT',
      );
      const threshold = Number.parseFloat(thresholdRaw ?? '15');
      const freePercent = Math.max(0, 100 - disk.usedPercent);

      if (freePercent < threshold) {
        if (!this.diskAlertActive) {
          this.diskAlertActive = true;
          await this.redis.setString(
            DISK_ALERT_REDIS_KEY,
            '1',
            7 * 24 * 3600,
            'alerts disk low',
          );
          const text = [
            '[Backup Worker] Disk space low',
            `Free: ${freePercent.toFixed(1)}% (threshold ${threshold}%)`,
            `Used: ${disk.usedPercent}% of ${disk.totalBytes} bytes`,
            `Path: ${disk.path}`,
          ].join('\n');
          await this.dispatch(text, '[Backup Worker] Disk space low');
        }

        return;
      }

      if (this.diskAlertActive) {
        this.diskAlertActive = false;
        await this.redis.delete(DISK_ALERT_REDIS_KEY, 'alerts disk recovered');
        this.logger.log('Disk free space recovered above threshold');
      }
    } catch (error) {
      this.logger.warn(
        `Disk alert check failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  private async notifyRunFailure(event: BackupRunStatusEvent): Promise<void> {
    const text = [
      `[Backup Worker] Run ${event.status}`,
      `runId: ${event.runId}`,
      `mode: ${event.mode ?? '-'}`,
      `trigger: ${event.trigger ?? '-'}`,
      `error: ${event.error ?? '-'}`,
      `at: ${event.at}`,
    ].join('\n');

    await this.dispatch(
      text,
      `[Backup Worker] Run ${event.status}: ${event.runId}`,
    );
  }

  private async dispatch(text: string, subject: string): Promise<void> {
    const tasks: Array<Promise<void>> = [];

    if (await this.isTruthy('ALERT_TELEGRAM_ENABLED')) {
      tasks.push(
        this.sendTelegram(text).catch((error) => {
          this.logger.warn(
            `Telegram alert skipped: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }),
      );
    }

    if (await this.isTruthy('ALERT_EMAIL_ENABLED')) {
      tasks.push(
        this.sendEmail(subject, text).catch((error) => {
          this.logger.warn(
            `Email alert skipped: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }),
      );
    }

    await Promise.all(tasks);
  }

  private async sendTelegram(text: string): Promise<void> {
    const botToken = await this.settings.get('ALERT_TELEGRAM_BOT_TOKEN');
    const chatId = await this.settings.get('ALERT_TELEGRAM_CHAT_ID');

    if (!botToken || !chatId) {
      throw new Error('Telegram bot token or chat id missing');
    }

    await this.telegram.send({ botToken, chatId, text });
  }

  private async sendEmail(subject: string, text: string): Promise<void> {
    const host = await this.settings.get('ALERT_SMTP_HOST');
    const portRaw = await this.settings.get('ALERT_SMTP_PORT');
    const from = await this.settings.get('ALERT_EMAIL_FROM');
    const to = await this.settings.get('ALERT_EMAIL_TO');

    if (!host || !from || !to) {
      throw new Error('SMTP host / from / to missing');
    }

    const port = Number.parseInt(portRaw ?? '587', 10);
    const secure = await this.isTruthy('ALERT_SMTP_SECURE');
    const user = await this.settings.get('ALERT_SMTP_USER');
    const password = await this.settings.get('ALERT_SMTP_PASSWORD');

    await this.email.send({
      host,
      port: Number.isFinite(port) ? port : 587,
      secure,
      user: user ?? undefined,
      password: password ?? undefined,
      from,
      to,
      subject,
      text,
    });
  }

  private async isTruthy(key: string): Promise<boolean> {
    const value = await this.settings.get(key);

    if (!value) {
      return false;
    }

    return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase());
  }
}
