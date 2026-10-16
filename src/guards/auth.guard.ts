import {
  type ExecutionContext,
  Injectable,
  Logger,
  mixin,
  UnauthorizedException,
} from '@nestjs/common';
import { type Type } from '@nestjs/common/interfaces';
import {
  AuthGuard as PassportAuthGuard,
  type IAuthGuard,
} from '@nestjs/passport';

interface IHttpLikeRequest {
  method?: string;
  originalUrl?: string;
  headers?: { authorization?: string };
}

function isAnonymousMarker(user: unknown): boolean {
  if (typeof user !== 'object' || user === null) {
    return false;
  }

  return (
    'anonymous' in user && (user as { anonymous?: boolean }).anonymous === true
  );
}

function hasBearerTokenAttempt(authorization: string | undefined): boolean {
  return (
    typeof authorization === 'string' &&
    authorization.startsWith('Bearer ') &&
    authorization.slice('Bearer '.length).trim().length > 0
  );
}

function resolveUnauthorizedMessage(info: unknown): string {
  if (
    info &&
    typeof info === 'object' &&
    'message' in info &&
    typeof (info as { message?: string }).message === 'string'
  ) {
    return String((info as { message: string }).message);
  }

  return 'Unauthorized';
}

function logAuthFailure(
  logger: Logger,
  request: IHttpLikeRequest,
  authorization: string | undefined,
  info: unknown,
  err: unknown,
): void {
  const tokenPreview = authorization?.startsWith('Bearer ')
    ? `${authorization.slice(0, 24)}...`
    : authorization ?? 'missing';
  const infoMessage =
    info && typeof info === 'object' && 'message' in info
      ? String((info as { message?: string }).message)
      : String(info ?? 'n/a');
  const errMessage =
    err && typeof err === 'object' && 'message' in err
      ? String((err as { message?: string }).message)
      : String(err ?? 'n/a');

  logger.warn(
    [
      `Auth failed ${request.method ?? 'UNKNOWN'} ${
        request.originalUrl ?? ''
      }`.trim(),
      `token=${tokenPreview}`,
      `info=${infoMessage}`,
      `error=${errMessage}`,
    ].join(' | '),
  );
}

function handleOptionalAuth<TUser>(
  err: unknown,
  user: TUser,
  info: unknown,
  request: IHttpLikeRequest,
  logger: Logger,
): TUser {
  if (user && !isAnonymousMarker(user)) {
    return user;
  }

  const authorization = request.headers?.authorization;

  if (hasBearerTokenAttempt(authorization)) {
    logAuthFailure(logger, request, authorization, info, err);

    throw err instanceof Error
      ? err
      : new UnauthorizedException(resolveUnauthorizedMessage(info));
  }

  return null as TUser;
}

function handleRequiredAuth<TUser>(
  err: unknown,
  user: TUser,
  info: unknown,
  request: IHttpLikeRequest,
  logger: Logger,
): TUser {
  if (err || !user) {
    logAuthFailure(logger, request, request.headers?.authorization, info, err);

    throw err instanceof Error
      ? err
      : new UnauthorizedException(resolveUnauthorizedMessage(info));
  }

  return user;
}

export function AuthGuard(
  options?: Partial<{ public: boolean }>,
): Type<IAuthGuard> {
  const isOptionalAuthRoute = options?.public === true;
  const strategies: string[] = isOptionalAuthRoute
    ? ['jwt', 'public']
    : ['jwt'];

  @Injectable()
  class JwtLoggingAuthGuard extends PassportAuthGuard(strategies) {
    private readonly logger = new Logger('AuthGuard');

    handleRequest<TUser = unknown>(
      err: unknown,
      user: TUser,
      info: unknown,
      context: ExecutionContext,
    ): TUser {
      const request = context.switchToHttp().getRequest<IHttpLikeRequest>();

      if (isOptionalAuthRoute) {
        return handleOptionalAuth(err, user, info, request, this.logger);
      }

      return handleRequiredAuth(err, user, info, request, this.logger);
    }
  }

  return mixin(JwtLoggingAuthGuard);
}
