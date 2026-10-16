import { Column, Entity, Index, JoinColumn, ManyToOne } from 'typeorm';

import { AbstractEntity } from '../../../common/abstract.entity';
import { UserEntity } from '../../user/user.entity';

@Entity({ name: 'password_reset_tokens' })
export class PasswordResetTokenEntity extends AbstractEntity {
  @Index()
  @Column({ name: 'token_hash', type: 'varchar', length: 255 })
  tokenHash!: string;

  @Column({ name: 'expires_at', type: 'timestamp' })
  expiresAt!: Date;

  @Column({ name: 'used_at', type: 'timestamp', nullable: true })
  usedAt!: Date | null;

  @ManyToOne(() => UserEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'user_id' })
  user!: UserEntity;

  @Column({ name: 'user_id', type: 'uuid' })
  userId!: Uuid;
}
