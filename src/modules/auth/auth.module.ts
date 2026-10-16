import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { TypeOrmModule } from '@nestjs/typeorm';

import { CacheModule } from '../cache/cache.module';
import { UserModule } from '../user/user.module';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { EmailVerificationEntity } from './entities/email-verification.entity';
import { PasswordResetTokenEntity } from './entities/password-reset-token.entity';
import { UserOauthIdentityEntity } from './entities/user-oauth-identity.entity';
import { getJwtExpirationSeconds } from './jwt-expiration.util';
import { resolveJwtKey } from './jwt-keys.util';
import { GoogleStrategy } from './strategies/google.strategy';
import { JwtStrategy } from './strategies/jwt.strategy';
import { PublicStrategy } from './strategies/public.strategy';

@Module({
  imports: [
    PassportModule.register({ defaultStrategy: 'jwt' }),
    CacheModule,
    ConfigModule,
    UserModule,
    TypeOrmModule.forFeature([
      PasswordResetTokenEntity,
      UserOauthIdentityEntity,
      EmailVerificationEntity,
    ]),
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => {
        const privateKey = resolveJwtKey(
          configService,
          'JWT_PRIVATE_KEY',
          'jwt_private.pem',
        );
        const publicKey = resolveJwtKey(
          configService,
          'JWT_PUBLIC_KEY',
          'jwt_public.pem',
        );

        if (!privateKey || !publicKey) {
          throw new Error(
            'JWT_PRIVATE_KEY and JWT_PUBLIC_KEY are required for RS256 auth (set env or provide jwt_private.pem / jwt_public.pem)',
          );
        }

        return {
          privateKey,
          publicKey,
          signOptions: {
            algorithm: 'RS256' as const,
            expiresIn: getJwtExpirationSeconds(configService),
          },
        };
      },
    }),
  ],
  controllers: [AuthController],
  providers: [AuthService, JwtStrategy, PublicStrategy, GoogleStrategy],
  exports: [AuthService],
})
export class AuthModule {}
