import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { type Request, type Response } from 'express';

import { Auth, AuthUser, PublicRoute } from '../../decorators';
import { UserDto } from '../user/dtos/user.dto';
import { UserEntity } from '../user/user.entity';
import { AuthService } from './auth.service';
import {
  clearAccessTokenCookie,
  setAccessTokenCookie,
} from './auth-cookie.util';
import { AuthTokenDto } from './dtos/auth-token.dto';
import { ForgotPasswordDto } from './dtos/forgot-password.dto';
import { ForgotPasswordResponseDto } from './dtos/forgot-password-response.dto';
import { LoginDto } from './dtos/login.dto';
import { RegisterDto } from './dtos/register.dto';
import { RequestEmailVerificationDto } from './dtos/request-email-verification.dto';
import { ResetPasswordDto } from './dtos/reset-password.dto';
import { UpdateEmailDto } from './dtos/update-email.dto';
import { VerifyEmailDto } from './dtos/verify-email.dto';

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Post('register')
  @PublicRoute(true)
  @Throttle({ default: { ttl: 60_000, limit: 10 } })
  @ApiOkResponse({ type: UserDto })
  register(@Body() dto: RegisterDto): Promise<UserDto> {
    return this.authService.register(dto);
  }

  @Post('login')
  @HttpCode(HttpStatus.OK)
  @PublicRoute(true)
  @Throttle({ default: { ttl: 60_000, limit: 10 } })
  @ApiOkResponse({ type: AuthTokenDto })
  async login(
    @Body() dto: LoginDto,
    @Res({ passthrough: true }) response: Response,
  ): Promise<AuthTokenDto> {
    const result = await this.authService.login(dto);
    setAccessTokenCookie(
      response,
      result.token.accessToken,
      result.token.expiresIn,
    );

    return result;
  }

  @Post('logout')
  @Auth()
  @HttpCode(HttpStatus.NO_CONTENT)
  async logout(
    @AuthUser() user: UserEntity,
    @Res({ passthrough: true }) response: Response,
  ): Promise<void> {
    await this.authService.logout(user);
    clearAccessTokenCookie(response);
  }

  @Post('forgot-password')
  @PublicRoute(true)
  @Throttle({ default: { ttl: 60_000, limit: 5 } })
  @ApiOkResponse({ type: ForgotPasswordResponseDto })
  forgotPassword(
    @Body() dto: ForgotPasswordDto,
  ): Promise<ForgotPasswordResponseDto> {
    return this.authService.forgotPassword(dto);
  }

  @Post('reset-password')
  @PublicRoute(true)
  @Throttle({ default: { ttl: 60_000, limit: 5 } })
  @HttpCode(HttpStatus.NO_CONTENT)
  async resetPassword(@Body() dto: ResetPasswordDto): Promise<void> {
    await this.authService.resetPassword(dto);
  }

  @Get('me')
  @Auth()
  @ApiOkResponse({ type: UserDto })
  me(@AuthUser() user: UserEntity): UserDto {
    return this.authService.me(user);
  }

  @Post('update-email')
  @Auth()
  @HttpCode(HttpStatus.NO_CONTENT)
  async updateEmail(
    @AuthUser() user: UserEntity,
    @Body() dto: UpdateEmailDto,
  ): Promise<void> {
    await this.authService.updateEmail(user, dto);
  }

  @Post('request-email-verification')
  @Auth()
  @HttpCode(HttpStatus.NO_CONTENT)
  async requestEmailVerification(
    @AuthUser() user: UserEntity,
    @Body() dto: RequestEmailVerificationDto,
  ): Promise<void> {
    await this.authService.requestEmailVerification(user, dto);
  }

  @Post('verify-email')
  @Auth()
  @ApiOkResponse({ type: UserDto })
  verifyEmail(
    @AuthUser() user: UserEntity,
    @Body() dto: VerifyEmailDto,
  ): Promise<UserDto> {
    return this.authService.verifyEmail(user, dto);
  }

  @Get('google')
  @PublicRoute(true)
  @UseGuards(AuthGuard('google'))
  // eslint-disable-next-line @typescript-eslint/require-await
  async googleAuth(): Promise<void> {}

  @Get('google/callback')
  @PublicRoute(true)
  @UseGuards(AuthGuard('google'))
  @ApiOkResponse({ type: AuthTokenDto })
  async googleCallback(
    @Req()
    request: Request & {
      user: {
        providerUserId: string;
        email: string | null;
        fullName: string | null;
        profile: Record<string, unknown>;
      };
    },
    @Res({ passthrough: true }) response: Response,
  ): Promise<AuthTokenDto> {
    const result = await this.authService.loginWithGoogleProfile(request.user);
    setAccessTokenCookie(
      response,
      result.token.accessToken,
      result.token.expiresIn,
    );

    return result;
  }
}
