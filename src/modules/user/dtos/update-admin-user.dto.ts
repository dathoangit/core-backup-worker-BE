import { applyDecorators } from '@nestjs/common';
import { Matches } from 'class-validator';

import { StaffRole } from '../../../constants';
import {
  BooleanFieldOptional,
  EmailFieldOptional,
  EnumFieldOptional,
  StringFieldOptional,
} from '../../../decorators';

export class UpdateAdminUserDto {
  @applyDecorators(
    StringFieldOptional({ minLength: 3, maxLength: 64, toLowerCase: true }),
    Matches(/^[\d_a-z]+$/, {
      message:
        'Username may only contain lowercase letters, digits, and underscores',
    }),
  )
  username?: string;

  @EmailFieldOptional()
  email?: string;

  @StringFieldOptional({ minLength: 8, maxLength: 128 })
  password?: string;

  @EnumFieldOptional(() => StaffRole)
  role?: StaffRole;

  @BooleanFieldOptional()
  isActive?: boolean;
}
