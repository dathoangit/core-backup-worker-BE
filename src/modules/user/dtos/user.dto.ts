import { AbstractDto } from '../../../common/dto/abstract.dto';
import { StaffRole } from '../../../constants';
import {
  BooleanField,
  DateFieldOptional,
  EmailFieldOptional,
  EnumField,
  StringField,
} from '../../../decorators';
import { type UserEntity } from '../user.entity';

export class UserDto extends AbstractDto {
  @StringField()
  username!: string;

  @EmailFieldOptional()
  email?: string | null;

  @DateFieldOptional()
  emailVerifiedAt?: Date | null;

  @EnumField(() => StaffRole)
  role!: StaffRole;

  @BooleanField()
  isActive!: boolean;

  constructor(entity: UserEntity) {
    super(entity);
    this.username = entity.username;
    this.email = entity.email ?? undefined;
    this.emailVerifiedAt = entity.emailVerifiedAt ?? undefined;
    this.role = entity.role;
    this.isActive = entity.isActive;
  }
}
