import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { type ConfigService } from '@nestjs/config';

/**
 * Resolve RS256 key material from env (with `\n` unescaped) or local PEM files.
 */
export function resolveJwtKey(
  configService: ConfigService,
  envKey: 'JWT_PRIVATE_KEY' | 'JWT_PUBLIC_KEY',
  pemFilename: 'jwt_private.pem' | 'jwt_public.pem',
): string {
  const fromEnv = (configService.get<string>(envKey) ?? '')
    .replaceAll('\\n', '\n')
    .trim();

  if (fromEnv) {
    return fromEnv;
  }

  const pemPath = join(process.cwd(), pemFilename);
  if (existsSync(pemPath)) {
    return readFileSync(pemPath, 'utf8').trim();
  }

  return '';
}
