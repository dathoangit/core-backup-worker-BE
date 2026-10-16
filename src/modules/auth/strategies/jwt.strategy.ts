import { Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';

import { StaffRole, TokenType } from '../../../constants';
import { RedisCacheService } from '../../cache/redis-cache.service';
import { UserEntity } from '../../user/user.entity';
import { UserService } from '../../user/user.service';
import {
  AUTH_SESSION_KEY_PREFIX,
  AUTH_USER_CACHE_KEY_PREFIX,
  AUTH_USER_CACHE_TTL_SECONDS,
} from '../auth-redis.constants';
import { resolveJwtKey } from '../jwt-keys.util';
import { type IJwtAccessPayload } from '../types/jwt-access-payload.type';

interface ICachedAuthUser {
  id: Uuid;
  createdAt: string;
  updatedAt: string;
  username: string;
  email: string | null;
  emailVerifiedAt: string | null;
  role: StaffRole;
  isActive: boolean;
}

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy, 'jwt') {
  private readonly logger = new Logger(JwtStrategy.name);

  constructor(
    configService: ConfigService,
    private readonly userService: UserService,
    private readonly redisCacheService: RedisCacheService,
  ) {
    const publicKey = resolveJwtKey(
      configService,
      'JWT_PUBLIC_KEY',
      'jwt_public.pem',
    );

    if (!publicKey) {
      throw new Error(
        'JWT_PUBLIC_KEY is required for RS256 verification (set env or provide jwt_public.pem)',
      );
    }

    super({
      jwtFromRequest: (request) => {
        const authorization = request?.headers?.authorization;

        if (!authorization) {
          this.logger.warn('Missing Authorization header');
        } else if (!authorization.startsWith('Bearer ')) {
          this.logger.warn('Authorization header is not Bearer format');
        }

        return ExtractJwt.fromAuthHeaderAsBearerToken()(request);
      },
      ignoreExpiration: false,
      secretOrKey: publicKey,
      algorithms: ['RS256'],
    });
  }

  async validate(payload: IJwtAccessPayload): Promise<UserEntity> {
    if (payload.type !== TokenType.ACCESS_TOKEN) {
      this.logger.warn(`Invalid token type: ${payload.type}`);

      throw new UnauthorizedException('Invalid token type');
    }

    if (payload.sessionId.length === 0) {
      this.logger.warn(`Missing sessionId for token sub=${payload.sub}`);

      throw new UnauthorizedException('Invalid session');
    }

    const activeSessionId = await this.redisCacheService.getString(
      this.buildAuthSessionKey(payload.sub),
      `auth-session validate userId=${payload.sub}`,
    );

    if (!activeSessionId || activeSessionId !== payload.sessionId) {
      this.logger.warn(`Inactive auth session for token sub=${payload.sub}`);

      throw new UnauthorizedException('Session expired');
    }

    const user = await this.getUserForAuth(payload.sub);

    if (!user || !user.isActive) {
      this.logger.warn(
        `User not found or inactive for token sub=${payload.sub}`,
      );

      throw new UnauthorizedException('User not found');
    }

    this.logger.debug(`Authenticated user=${user.id} role=${user.role}`);

    return user;
  }

  private async getUserForAuth(userId: Uuid): Promise<UserEntity | null> {
    const cacheKey = this.buildAuthUserCacheKey(userId);
    const cached = await this.redisCacheService.getJson<ICachedAuthUser>(
      cacheKey,
      `auth-user validate userId=${userId}`,
    );

    if (cached) {
      this.logger.log(`Auth user cache hit userId=${userId}`);

      return this.toUserEntity(cached);
    }

    const user = await this.userService.findById(userId);

    if (!user) {
      return null;
    }

    await this.redisCacheService.setJson(
      cacheKey,
      this.toCachedAuthUser(user),
      AUTH_USER_CACHE_TTL_SECONDS,
      `auth-user validate userId=${userId}`,
    );

    return user;
  }

  private toCachedAuthUser(user: UserEntity): ICachedAuthUser {
    return {
      id: user.id,
      createdAt: user.createdAt.toISOString(),
      updatedAt: user.updatedAt.toISOString(),
      username: user.username,
      email: user.email,
      emailVerifiedAt: user.emailVerifiedAt
        ? user.emailVerifiedAt.toISOString()
        : null,
      role: user.role,
      isActive: user.isActive,
    };
  }

  private toUserEntity(cached: ICachedAuthUser): UserEntity {
    const user = new UserEntity();
    user.id = cached.id;
    user.createdAt = new Date(cached.createdAt);
    user.updatedAt = new Date(cached.updatedAt);
    user.username = cached.username;
    user.email = cached.email;
    user.emailVerifiedAt = cached.emailVerifiedAt
      ? new Date(cached.emailVerifiedAt)
      : null;
    user.role = cached.role;
    user.isActive = cached.isActive;

    return user;
  }

  private buildAuthSessionKey(userId: Uuid): string {
    return `${AUTH_SESSION_KEY_PREFIX}:${userId}`;
  }

  private buildAuthUserCacheKey(userId: Uuid): string {
    return `${AUTH_USER_CACHE_KEY_PREFIX}:${userId}`;
  }
}
