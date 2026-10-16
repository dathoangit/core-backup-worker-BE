import { Column, Entity, Index } from 'typeorm';

import { AbstractEntity } from '../../../common/abstract.entity';
import type { SettingCategory } from '../settings.constants';

@Entity({ name: 'app_settings' })
export class AppSettingEntity extends AbstractEntity {
  @Index({ unique: true })
  @Column({ type: 'varchar', length: 128 })
  key!: string;

  @Column({ type: 'text', nullable: true })
  value!: string | null;

  @Column({ name: 'is_secret', type: 'boolean', default: false })
  isSecret!: boolean;

  @Column({ type: 'varchar', length: 32 })
  category!: SettingCategory;
}
