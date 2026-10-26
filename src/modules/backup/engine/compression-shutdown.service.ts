import { Injectable, Logger, type OnApplicationShutdown } from '@nestjs/common';

import { killActiveCompressionChildren } from './compressed-writer';

@Injectable()
export class CompressionShutdownService implements OnApplicationShutdown {
  private readonly logger = new Logger(CompressionShutdownService.name);

  onApplicationShutdown(signal?: string): void {
    this.logger.warn(
      `Shutdown signal [${
        signal ?? 'unknown'
      }]: stopping compression children and cleaning .partial files`,
    );
    killActiveCompressionChildren();
  }
}
