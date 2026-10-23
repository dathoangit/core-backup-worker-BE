/* eslint-disable unicorn/prefer-top-level-await */
/* eslint-disable no-console */
/* eslint-disable n/no-process-exit */
/* eslint-disable unicorn/no-process-exit */
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';

import { WorkerAppModule } from './worker-app.module';

async function bootstrap(): Promise<void> {
  const logger = new Logger('BackupWorker');
  logger.log('Starting backup worker process...');

  const app = await NestFactory.createApplicationContext(WorkerAppModule, {
    logger: ['error', 'warn', 'log'],
  });

  app.enableShutdownHooks();

  logger.log('Backup worker ready (BullMQ consumers active)');
}

bootstrap().catch((error) => {
  console.error('Failed to start backup worker:', error);
  process.exit(1);
});
