import {
  EmailField,
  EnumField,
  StringFieldOptional,
} from '../../../decorators';
import { EmailVerificationMethod } from '../entities/email-verification.entity';

export class VerifyEmailDto {
  @EmailField()
  email!: string;

  @EnumField(() => EmailVerificationMethod)
  method!: EmailVerificationMethod;

  @StringFieldOptional({ minLength: 6, maxLength: 255 })
  otp?: string;

  @StringFieldOptional({ minLength: 16, maxLength: 255 })
  token?: string;
}
