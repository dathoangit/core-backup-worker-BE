import { StringField } from '../../../decorators';

export class ResetPasswordDto {
  @StringField({ minLength: 32, maxLength: 128 })
  token!: string;

  @StringField({ minLength: 8, maxLength: 128 })
  newPassword!: string;
}
