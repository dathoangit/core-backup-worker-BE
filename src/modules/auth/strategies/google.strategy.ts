import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { type Profile, Strategy } from 'passport-google-oauth20';

interface IGoogleDonePayload {
  providerUserId: string;
  email: string | null;
  fullName: string | null;
  profile: Record<string, unknown>;
}

@Injectable()
export class GoogleStrategy extends PassportStrategy(Strategy, 'google') {
  constructor(configService: ConfigService) {
    const clientID = configService.get<string>('GOOGLE_CLIENT_ID') ?? '';
    const clientSecret =
      configService.get<string>('GOOGLE_CLIENT_SECRET') ?? '';
    const callbackURL =
      configService.get<string>('GOOGLE_CALLBACK_URL') ??
      'http://127.0.0.1:8081/auth/google/callback';

    super({
      clientID: clientID || 'disabled-google-client-id',
      clientSecret: clientSecret || 'disabled-google-client-secret',
      callbackURL,
      scope: ['email', 'profile'],
    });
  }

  validate(
    _accessToken: string,
    _refreshToken: string,
    profile: Profile,
    done: (error: Error | null, payload?: IGoogleDonePayload) => void,
  ): void {
    const email = profile.emails?.[0]?.value?.toLowerCase() ?? null;
    const payload: IGoogleDonePayload = {
      providerUserId: profile.id,
      email,
      fullName: profile.displayName ?? null,
      profile: profile as unknown as Record<string, unknown>,
    };

    done(null, payload);
  }
}
