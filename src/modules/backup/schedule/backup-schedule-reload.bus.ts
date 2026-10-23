import { Injectable } from '@nestjs/common';

/**
 * Breaks the Settings ↔ BackupScheduler cycle: Settings requests a reload;
 * BackupScheduler registers the handler on api boot.
 */
@Injectable()
export class BackupScheduleReloadBus {
  private handler: (() => Promise<void>) | null = null;

  register(handler: () => Promise<void>): void {
    this.handler = handler;
  }

  unregister(): void {
    this.handler = null;
  }

  async requestReload(): Promise<void> {
    if (!this.handler) {
      return;
    }

    await this.handler();
  }
}
