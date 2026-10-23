import {
  Column,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  type Relation,
} from 'typeorm';

import { AbstractEntity } from '../../../common/abstract.entity';
import { type BackupProfile, type SourceGroup } from '../types';
import { BackupRunEntity } from './backup-run.entity';

@Entity({ name: 'backup_database_runs' })
@Index(['runId', 'database'], { unique: true })
export class BackupDatabaseRunEntity extends AbstractEntity {
  @Column({ name: 'run_id', type: 'varchar', length: 64 })
  runId!: string;

  @Column({ name: 'source_group', type: 'varchar', length: 16 })
  sourceGroup!: SourceGroup;

  @Column({ type: 'varchar', length: 128 })
  database!: string;

  @Column({ type: 'varchar', length: 32 })
  profile!: BackupProfile;

  @Column({ type: 'varchar', length: 16 })
  status!: 'ok' | 'error' | 'skipped';

  @Column({
    name: 'watermark_before',
    type: 'varchar',
    length: 64,
    nullable: true,
  })
  watermarkBefore!: string | null;

  @Column({ type: 'varchar', length: 64, nullable: true })
  captured!: string | null;

  @Column({
    name: 'watermark_after',
    type: 'varchar',
    length: 64,
    nullable: true,
  })
  watermarkAfter!: string | null;

  @Column({ name: 'chunk_count', type: 'int', default: 0 })
  chunkCount!: number;

  @Column({ name: 'bytes_total', type: 'bigint', default: 0 })
  bytesTotal!: string;

  @Column({ name: 'row_count_total', type: 'bigint', default: 0 })
  rowCountTotal!: string;

  @Column({ name: 'skipped_table_count', type: 'int', default: 0 })
  skippedTableCount!: number;

  @Column({ type: 'text', nullable: true })
  error!: string | null;

  @ManyToOne(() => BackupRunEntity, (run) => run.databases, {
    onDelete: 'CASCADE',
  })
  @JoinColumn({ name: 'backup_run_id' })
  backupRun!: Relation<BackupRunEntity>;

  @Column({ name: 'backup_run_id', type: 'uuid' })
  backupRunId!: string;
}
