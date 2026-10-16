import { EmailField } from '../../../decorators';

export class UpdateEmailDto {
  @EmailField()
  email!: string;
}
