import { Injectable } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { Strategy } from 'passport-custom';

/**
 * Fallback when JWT is not used or not provided. Used only with AuthGuard + `{ public: true }`.
 * Returns a marker object so passport-custom treats authentication as success; AuthGuard
 * normalizes this to `request.user === null` for anonymous access.
 */
@Injectable()
export class PublicStrategy extends PassportStrategy(Strategy, 'public') {
  validate(): { anonymous: true } {
    return { anonymous: true };
  }
}
