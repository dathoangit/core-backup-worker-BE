/* eslint-disable unicorn/prefer-top-level-await */
/* eslint-disable no-console */
/* eslint-disable n/no-process-exit */
/* eslint-disable unicorn/no-process-exit */
import { join } from 'node:path';

import {
  UnprocessableEntityException,
  ValidationPipe,
} from '@nestjs/common';
import { type ValidationError } from 'class-validator';
import { NestFactory } from '@nestjs/core';
import {
  ExpressAdapter,
  type NestExpressApplication,
} from '@nestjs/platform-express';
import { type Request, type Response } from 'express';

import { AppModule } from './app.module';
import { setupSwagger } from './setup-swagger';

export async function bootstrap(): Promise<NestExpressApplication> {
  console.log('Starting application...');
  console.log('PORT:', process.env.PORT);
  console.log('NODE_ENV:', process.env.NODE_ENV);

  const app = await NestFactory.create<NestExpressApplication>(
    AppModule,
    new ExpressAdapter(),
    { cors: true },
  );

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      forbidNonWhitelisted: true,
      exceptionFactory: (errors: ValidationError[]) =>
        new UnprocessableEntityException(errors),
    }),
  );

  setupSwagger(app);

  // Serve static files from public/uploads folder
  app.useStaticAssets(join(process.cwd(), 'public', 'uploads'), {
    prefix: '/uploads/',
  });

  // Add root route for testing
  app.getHttpAdapter().getInstance().get('/', (_req: Request, res: Response) => {
    res.json({
      status: 'ok',
      service: 'base-project',
      timestamp: new Date().toISOString(),
      endpoints: {
        health: '/health',
        documentation: '/documentation',
        auth: '/auth',
      },
    });
  });
  const port = Number(process.env.PORT) || 8081;
  console.log(`Attempting to listen on 0.0.0.0:${port}...`);

  // Bind to 0.0.0.0 to accept connections from all network interfaces
  await app.listen(port, '0.0.0.0');

  const url = await app.getUrl();
  console.info(`✅ Server successfully started and listening on ${url}`);
  console.info(`📡 Server accessible at: http://0.0.0.0:${port}`);

  return app;
}

bootstrap().catch((error) => {
  console.error('Failed to start application:', error);
  process.exit(1);
});
