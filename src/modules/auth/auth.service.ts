import { createHash, randomBytes, randomUUID } from 'node:crypto';

import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Repository } from 'typeorm';

import { generateHash, validateHash } from '../../common/utils';
import { StaffRole, TokenType } from '../../constants';
import { RedisCacheService } from '../cache/redis-cache.service';
import { type UserDto } from '../user/dtos/user.dto';
import { type UserEntity } from '../user/user.entity';
import { UserService } from '../user/user.service';
import {
  AUTH_SESSION_KEY_PREFIX,
  AUTH_USER_CACHE_KEY_PREFIX,
} from './auth-redis.constants';
import { type AuthTokenDto } from './dtos/auth-token.dto';
import { type ForgotPasswordDto } from './dtos/forgot-password.dto';
import { type ForgotPasswordResponseDto } from './dtos/forgot-password-response.dto';
import { type LoginDto } from './dtos/login.dto';
import { type RegisterDto } from './dtos/register.dto';
import { type RequestEmailVerificationDto } from './dtos/request-email-verification.dto';
import { type ResetPasswordDto } from './dtos/reset-password.dto';
import { type UpdateEmailDto } from './dtos/update-email.dto';
import { type VerifyEmailDto } from './dtos/verify-email.dto';
import {
  EmailVerificationEntity,
  EmailVerificationMethod,
} from './entities/email-verification.entity';
import { PasswordResetTokenEntity } from './entities/password-reset-token.entity';
import { UserOauthIdentityEntity } from './entities/user-oauth-identity.entity';
import { getJwtExpirationSeconds } from './jwt-expiration.util';
import { type IJwtAccessPayload } from './types/jwt-access-payload.type';

@Injectable()
export class AuthService {
  private static readonly forgotPasswordGenericMessage =
    'If the account exists, a password reset instruction has been sent.';

  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly userService: UserService,
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
    private readonly redisCacheService: RedisCacheService,
    @InjectRepository(PasswordResetTokenEntity)
    private readonly passwordResetTokenRepository: Repository<PasswordResetTokenEntity>,
    @InjectRepository(UserOauthIdentityEntity)
    private readonly userOauthIdentityRepository: Repository<UserOauthIdentityEntity>,
    @InjectRepository(EmailVerificationEntity)
    private readonly emailVerificationRepository: Repository<EmailVerificationEntity>,
  ) {}

  async register(dto: RegisterDto): Promise<UserDto> {
    const existingUsername = await this.userService.findByUsername(
      dto.username,
    );

    if (existingUsername) {
      throw new ConflictException('Username already exists');
    }

    const rawEmail = dto.email?.trim() ?? '';
    const emailNormalized = rawEmail.length > 0 ? rawEmail.toLowerCase() : null;

    if (emailNormalized) {
      const existingEmail = await this.userService.findByEmail(emailNormalized);

      if (existingEmail) {
        throw new ConflictException('Email already exists');
      }
    }

    const user = await this.userService.createUser({
      username: dto.username,
      email: emailNormalized,
      passwordHash: generateHash(dto.password),
      role: StaffRole.NURSE,
    });

    if (emailNormalized) {
      await this.createEmailVerification({
        email: emailNormalized,
        method: EmailVerificationMethod.LINK,
        userId: user.id,
      });
    }

    return user.toDto();
  }

  async login(dto: LoginDto): Promise<AuthTokenDto> {
    const user = await this.userService.findByIdentifierWithPassword(
      dto.username,
    );

    if (!user || !user.isActive) {
      throw new UnauthorizedException('Invalid credentials');
    }

    const isMatched = await validateHash(dto.password, user.passwordHash);

    if (!isMatched) {
      throw new UnauthorizedException('Invalid credentials');
    }

    const sessionId = randomUUID();
    const expiresIn = this.getAccessTokenExpiresIn();
    const hasStoredSession = await this.redisCacheService.setString(
      this.buildAuthSessionKey(user.id),
      sessionId,
      Number(expiresIn),
      `auth-session login userId=${user.id}`,
    );

    if (!hasStoredSession) {
      throw new ServiceUnavailableException('Auth session store unavailable');
    }

    await this.redisCacheService.delete(
      `${AUTH_USER_CACHE_KEY_PREFIX}:${user.id}`,
      `auth-user login userId=${user.id}`,
    );

    const token = await this.issueAccessToken(user, sessionId);

    return {
      user: user.toDto(),
      token: {
        expiresIn,
        accessToken: token,
      },
    };
  }

  me(user: UserEntity): UserDto {
    return user.toDto();
  }

  async logout(user: UserEntity): Promise<void> {
    await this.redisCacheService.delete(
      this.buildAuthSessionKey(user.id),
      `auth-session logout userId=${user.id}`,
    );
    await this.redisCacheService.delete(
      `${AUTH_USER_CACHE_KEY_PREFIX}:${user.id}`,
      `auth-user logout userId=${user.id}`,
    );
  }

  async updateEmail(user: UserEntity, dto: UpdateEmailDto): Promise<void> {
    const normalizedEmail = dto.email.trim().toLowerCase();
    const existing = await this.userService.findByEmail(normalizedEmail);

    if (existing && existing.id !== user.id) {
      throw new ConflictException('Email already exists');
    }

    await this.createEmailVerification({
      email: normalizedEmail,
      method: EmailVerificationMethod.LINK,
      userId: user.id,
    });
  }

  async requestEmailVerification(
    user: UserEntity,
    dto: RequestEmailVerificationDto,
  ): Promise<void> {
    const normalizedEmail = dto.email.trim().toLowerCase();
    const existing = await this.userService.findByEmail(normalizedEmail);

    if (existing && existing.id !== user.id) {
      throw new ConflictException('Email already exists');
    }

    await this.createEmailVerification({
      email: normalizedEmail,
      method: dto.method,
      userId: user.id,
    });
  }

  async verifyEmail(user: UserEntity, dto: VerifyEmailDto): Promise<UserDto> {
    const normalizedEmail = dto.email.trim().toLowerCase();
    const verification = await this.emailVerificationRepository.findOne({
      where: {
        email: normalizedEmail,
        method: dto.method,
        userId: user.id,
        consumedAt: IsNull(),
      },
      order: { createdAt: 'DESC' },
    });

    if (!verification) {
      throw new NotFoundException('Email verification not found');
    }

    if (verification.expiresAt.getTime() < Date.now()) {
      throw new BadRequestException('Verification has expired');
    }

    const providedSecret =
      dto.method === EmailVerificationMethod.OTP ? dto.otp : dto.token;
    const expectedHash =
      dto.method === EmailVerificationMethod.OTP
        ? verification.otpHash
        : verification.tokenHash;

    if (!providedSecret || !expectedHash) {
      throw new BadRequestException('Verification secret is required');
    }

    const secretHash = this.hashResetToken(providedSecret);

    if (secretHash !== expectedHash) {
      throw new BadRequestException('Invalid verification secret');
    }

    verification.consumedAt = new Date();
    await this.emailVerificationRepository.save(verification);
    const updatedUser = await this.userService.markEmailVerified(
      user.id,
      normalizedEmail,
    );

    if (!updatedUser) {
      throw new NotFoundException('User not found');
    }

    return updatedUser.toDto();
  }

  async loginWithGoogleProfile(payload: {
    providerUserId: string;
    email: string | null;
    fullName: string | null;
    profile: Record<string, unknown>;
  }): Promise<AuthTokenDto> {
    const existingIdentity = await this.userOauthIdentityRepository.findOne({
      where: {
        provider: 'google',
        providerUserId: payload.providerUserId,
      },
      relations: ['user'],
    });

    let user = existingIdentity?.user ?? null;
    const normalizedEmail = payload.email?.trim().toLowerCase() ?? null;

    if (!user && normalizedEmail) {
      user = await this.userService.findByEmail(normalizedEmail);
    }

    if (!user) {
      const generatedUsername =
        await this.generateUniqueUsernameFromEmail(normalizedEmail);
      user = await this.userService.createUser({
        username: generatedUsername,
        email: normalizedEmail,
        passwordHash: generateHash(randomBytes(24).toString('hex')),
        role: StaffRole.NURSE,
      });

      if (normalizedEmail) {
        await this.userService.markEmailVerified(user.id, normalizedEmail);
      }
    }

    if (!existingIdentity) {
      const identity = this.userOauthIdentityRepository.create({
        provider: 'google',
        providerUserId: payload.providerUserId,
        email: normalizedEmail,
        profileJson: payload.profile,
        userId: user.id,
      });
      await this.userOauthIdentityRepository.save(identity);
    }

    return this.loginByUserEntity(user);
  }

  async forgotPassword(
    dto: ForgotPasswordDto,
  ): Promise<ForgotPasswordResponseDto> {
    const user = await this.userService.findByEmail(dto.email);

    if (!user) {
      return { message: AuthService.forgotPasswordGenericMessage };
    }

    const plainToken = randomBytes(32).toString('hex');
    const tokenHash = this.hashResetToken(plainToken);
    const ttlMinutes =
      this.configService.get<number>('RESET_TOKEN_TTL_MINUTES') ?? 30;
    const expiresAt = new Date(Date.now() + ttlMinutes * 60 * 1000);

    const entity = this.passwordResetTokenRepository.create({
      tokenHash,
      expiresAt,
      userId: user.id,
      usedAt: null,
    });

    const saved = await this.passwordResetTokenRepository.save(entity);

    // Do not log the raw token or email; integrate email delivery here in production.
    this.logger.log(
      `Password reset token issued userId=${user.id} rowId=${
        saved.id
      } expiresAt=${saved.expiresAt.toISOString()}`,
    );

    return { message: AuthService.forgotPasswordGenericMessage };
  }

  async resetPassword(dto: ResetPasswordDto): Promise<void> {
    const tokenHash = this.hashResetToken(dto.token);
    const token = await this.passwordResetTokenRepository.findOne({
      where: { tokenHash },
    });

    if (!token) {
      throw new BadRequestException('Invalid reset token');
    }

    if (token.usedAt) {
      throw new BadRequestException('Reset token already used');
    }

    if (token.expiresAt.getTime() < Date.now()) {
      throw new BadRequestException('Reset token has expired');
    }

    await this.userService.updatePassword(
      token.userId,
      generateHash(dto.newPassword),
    );
    await this.redisCacheService.delete(
      this.buildAuthSessionKey(token.userId),
      `auth-session reset-password userId=${token.userId}`,
    );
    token.usedAt = new Date();
    await this.passwordResetTokenRepository.save(token);
    this.logger.log(`Password reset completed userId=${token.userId}`);
  }

  private async issueAccessToken(
    user: UserEntity,
    sessionId: string,
  ): Promise<string> {
    const payload: IJwtAccessPayload = {
      sub: user.id,
      type: TokenType.ACCESS_TOKEN,
      role: user.role,
      sessionId,
      ...(user.email ? { email: user.email } : {}),
    };

    return this.jwtService.signAsync(payload);
  }

  private hashResetToken(rawToken: string): string {
    return createHash('sha256').update(rawToken).digest('hex');
  }

  private getAccessTokenExpiresIn(): number {
    return getJwtExpirationSeconds(this.configService);
  }

  private async loginByUserEntity(user: UserEntity): Promise<AuthTokenDto> {
    const freshUser = await this.userService.findById(user.id);

    if (!freshUser || !freshUser.isActive) {
      throw new UnauthorizedException('Invalid credentials');
    }

    const sessionId = randomUUID();
    const expiresIn = this.getAccessTokenExpiresIn();
    const hasStoredSession = await this.redisCacheService.setString(
      this.buildAuthSessionKey(freshUser.id),
      sessionId,
      Number(expiresIn),
      `auth-session login userId=${freshUser.id}`,
    );

    if (!hasStoredSession) {
      throw new ServiceUnavailableException('Auth session store unavailable');
    }

    await this.redisCacheService.delete(
      `${AUTH_USER_CACHE_KEY_PREFIX}:${freshUser.id}`,
      `auth-user login userId=${freshUser.id}`,
    );

    const token = await this.issueAccessToken(freshUser, sessionId);

    return {
      user: freshUser.toDto(),
      token: {
        expiresIn,
        accessToken: token,
      },
    };
  }

  private async createEmailVerification(payload: {
    email: string;
    method: EmailVerificationMethod;
    userId: Uuid;
  }): Promise<void> {
    const token = randomBytes(24).toString('hex');
    const otp = String(Math.floor(100_000 + Math.random() * 900_000));
    const ttlMinutes =
      this.configService.get<number>('EMAIL_VERIFY_TTL_MINUTES') ?? 15;
    const expiresAt = new Date(Date.now() + ttlMinutes * 60 * 1000);
    const entity = this.emailVerificationRepository.create({
      email: payload.email,
      method: payload.method,
      tokenHash:
        payload.method === EmailVerificationMethod.LINK
          ? this.hashResetToken(token)
          : null,
      otpHash:
        payload.method === EmailVerificationMethod.OTP
          ? this.hashResetToken(otp)
          : null,
      expiresAt,
      consumedAt: null,
      userId: payload.userId,
    });

    await this.emailVerificationRepository.save(entity);
    this.logger.log(
      `Email verification issued userId=${payload.userId} email=${payload.email} method=${payload.method}`,
    );
  }

  private async generateUniqueUsernameFromEmail(
    email: string | null,
  ): Promise<string> {
    const base =
      email
        ?.split('@')[0]
        ?.replace(/[^\d_a-z]/g, '')
        .slice(0, 24) || 'google_user';
    let username = base.length >= 3 ? base : `user_${base}`;
    let counter = 0;

    while (await this.userService.findByUsername(username)) {
      counter += 1;
      username = `${base}_${counter}`.slice(0, 64);
    }

    return username;
  }

  private buildAuthSessionKey(userId: Uuid): string {
    return `${AUTH_SESSION_KEY_PREFIX}:${userId}`;
  }
}
