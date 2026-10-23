import { type CookieOptions, type Response } from 'express';

export const AUTH_ACCESS_COOKIE_NAME = 'access_token';

export function resolveFrontendOrigins(): string[] {
  const raw = process.env.FRONTEND_ORIGINS?.trim();

  if (!raw) {
    return ['http://localhost:3000'];
  }

  return raw
    .split(',')
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);
}

export function isAuthCookieSecure(): boolean {
  if (process.env.AUTH_COOKIE_SECURE === 'true') {
    return true;
  }

  if (process.env.AUTH_COOKIE_SECURE === 'false') {
    return false;
  }

  return process.env.NODE_ENV === 'production';
}

export function buildAuthCookieOptions(maxAgeSeconds: number): CookieOptions {
  return {
    httpOnly: true,
    sameSite: 'lax',
    secure: isAuthCookieSecure(),
    path: '/',
    maxAge: Math.max(0, Math.floor(maxAgeSeconds)) * 1000,
  };
}

export function setAccessTokenCookie(
  response: Response,
  accessToken: string,
  expiresInSeconds: number,
): void {
  response.cookie(
    AUTH_ACCESS_COOKIE_NAME,
    accessToken,
    buildAuthCookieOptions(expiresInSeconds),
  );
}

export function clearAccessTokenCookie(response: Response): void {
  response.clearCookie(AUTH_ACCESS_COOKIE_NAME, {
    httpOnly: true,
    sameSite: 'lax',
    secure: isAuthCookieSecure(),
    path: '/',
  });
}
