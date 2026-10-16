import { Column, Entity, Index, OneToMany } from 'typeorm';

import { AbstractEntity } from '../../common/abstract.entity';
import { StaffRole } from '../../constants';
import { UseDto } from '../../decorators';
import { UserOauthIdentityEntity } from '../auth/entities/user-oauth-identity.entity';
import { UserDto } from './dtos/user.dto';

@Entity({ name: 'users' })
@UseDto(UserDto)
export class UserEntity extends AbstractEntity<UserDto> {
  @Index({ unique: true })
  @Column({ type: 'varchar', length: 64 })
  username!: string;

  @Index({ unique: true })
  @Column({ type: 'varchar', length: 255, nullable: true })
  email!: string | null;

  @Column({ name: 'email_verified_at', type: 'timestamp', nullable: true })
  emailVerifiedAt!: Date | null;

  @Column({
    name: 'password_hash',
    type: 'varchar',
    length: 255,
    select: false,
  })
  passwordHash!: string;

  @Column({ type: 'enum', enum: StaffRole, default: StaffRole.NURSE })
  role!: StaffRole;

  @Column({ name: 'is_active', type: 'boolean', default: true })
  isActive!: boolean;

  @OneToMany(() => UserOauthIdentityEntity, (identity) => identity.user)
  oauthIdentities!: UserOauthIdentityEntity[];
}
