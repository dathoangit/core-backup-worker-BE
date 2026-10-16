import { EmailField, EnumField } from '../../../decorators';
import { EmailVerificationMethod } from '../entities/email-verification.entity';

export class RequestEmailVerificationDto {
  @EmailField()
  email!: string;

  @EnumField(() => EmailVerificationMethod)
  method!: EmailVerificationMethod;
}
