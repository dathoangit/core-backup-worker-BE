import { Column, Entity, Index, JoinColumn, ManyToOne } from 'typeorm';

import { AbstractEntity } from '../../../common/abstract.entity';
import { UserEntity } from '../../user/user.entity';

@Entity({ name: 'user_oauth_identities' })
@Index('IDX_user_oauth_provider_subject', ['provider', 'providerUserId'], {
  unique: true,
})
export class UserOauthIdentityEntity extends AbstractEntity {
  @Column({ type: 'varchar', length: 40 })
  provider!: string;

  @Column({ name: 'provider_user_id', type: 'varchar', length: 191 })
  providerUserId!: string;

  @Column({ type: 'varchar', length: 255, nullable: true })
  email!: string | null;

  @Column({ name: 'profile_json', type: 'json', nullable: true })
  profileJson!: Record<string, unknown> | null;

  @Column({ name: 'user_id', type: 'uuid' })
  userId!: Uuid;

  @ManyToOne(() => UserEntity, (user) => user.oauthIdentities, {
    onDelete: 'CASCADE',
  })
  @JoinColumn({ name: 'user_id' })
  user!: UserEntity;
}
