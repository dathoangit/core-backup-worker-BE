import { StringField } from '../../../decorators';

export class LoginDto {
  @StringField({ minLength: 3, maxLength: 64, toLowerCase: true })
  username!: string;

  @StringField({ minLength: 8, maxLength: 128 })
  password!: string;
}
