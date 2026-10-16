import { type ConfigService } from '@nestjs/config';

/** Default access token lifetime: 1 day (seconds). */
export const DEFAULT_JWT_EXPIRATION_SECONDS = 86_400;

/**
 * Reads JWT_EXPIRATION_TIME from env as seconds (integer).
 * Env must be numeric seconds — do not rely on string forms like "3600" for jsonwebtoken (ms() parses them wrong).
 */
export function getJwtExpirationSeconds(configService: ConfigService): number {
  const raw = configService.get<string>('JWT_EXPIRATION_TIME');

  if (raw === undefined || raw === '') {
    return DEFAULT_JWT_EXPIRATION_SECONDS;
  }

  const n = Number.parseInt(raw, 10);

  if (!Number.isFinite(n) || n <= 0) {
    return DEFAULT_JWT_EXPIRATION_SECONDS;
  }

  return n;
}
