import { Column, Entity, Index } from 'typeorm';

import { AbstractEntity } from '../../../common/abstract.entity';

export enum EmailVerificationMethod {
  OTP = 'otp',
  LINK = 'link',
}

@Entity({ name: 'email_verifications' })
export class EmailVerificationEntity extends AbstractEntity {
  @Column({ type: 'varchar', length: 255 })
  email!: string;

  @Column({
    type: 'enum',
    enum: EmailVerificationMethod,
  })
  method!: EmailVerificationMethod;

  @Index('IDX_email_verification_token_hash')
  @Column({ name: 'token_hash', type: 'varchar', length: 255, nullable: true })
  tokenHash!: string | null;

  @Index('IDX_email_verification_otp_hash')
  @Column({ name: 'otp_hash', type: 'varchar', length: 255, nullable: true })
  otpHash!: string | null;

  @Column({ name: 'expires_at', type: 'timestamp' })
  expiresAt!: Date;

  @Column({ name: 'consumed_at', type: 'timestamp', nullable: true })
  consumedAt!: Date | null;

  @Index('IDX_email_verification_user_id')
  @Column({ name: 'user_id', type: 'uuid', nullable: true })
  userId!: Uuid | null;
}
