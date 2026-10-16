import { EmailField } from '../../../decorators';

export class ForgotPasswordDto {
  @EmailField()
  email!: string;
}
