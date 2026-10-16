import { applyDecorators } from '@nestjs/common';
import { Matches } from 'class-validator';

import { StaffRole } from '../../../constants';
import {
  BooleanFieldOptional,
  EmailFieldOptional,
  EnumField,
  StringField,
} from '../../../decorators';

export class CreateAdminUserDto {
  @applyDecorators(
    StringField({ minLength: 3, maxLength: 64, toLowerCase: true }),
    Matches(/^[\d_a-z]+$/, {
      message:
        'Username may only contain lowercase letters, digits, and underscores',
    }),
  )
  username!: string;

  @EmailFieldOptional()
  email?: string;

  @StringField({ minLength: 8, maxLength: 128 })
  password!: string;

  @EnumField(() => StaffRole)
  role!: StaffRole;

  @BooleanFieldOptional()
  isActive?: boolean;
}
