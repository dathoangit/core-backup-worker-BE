import {
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';

import { BackupCancelRegistry } from './backup-cancel.registry';
import { BackupRedisService } from './backup-redis.service';

@Injectable()
export class BackupCancelListener implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(BackupCancelListener.name);

  private unsubscribe: (() => void) | null = null;

  constructor(
    private readonly backupRedis: BackupRedisService,
    private readonly cancelRegistry: BackupCancelRegistry,
  ) {}

  onModuleInit(): void {
    this.unsubscribe = this.backupRedis.onCancel((runId) => {
      this.logger.log(`Cancel signal received for run ${runId}`);
      void this.cancelRegistry.requestCancel(runId);
    });
  }

  onModuleDestroy(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
  }
}
