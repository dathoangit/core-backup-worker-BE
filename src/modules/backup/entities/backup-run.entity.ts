import { Column, Entity, Index, OneToMany, type Relation } from 'typeorm';

import { AbstractEntity } from '../../../common/abstract.entity';
import {
  type BackupMode,
  type BackupRunStatus,
  type BackupTrigger,
} from '../types';
import { BackupDatabaseRunEntity } from './backup-database-run.entity';

@Entity({ name: 'backup_runs' })
export class BackupRunEntity extends AbstractEntity {
  @Index({ unique: true })
  @Column({ name: 'run_id', type: 'varchar', length: 64 })
  runId!: string;

  @Column({ name: 'started_at', type: 'timestamp' })
  startedAt!: Date;

  @Column({ name: 'finished_at', type: 'timestamp', nullable: true })
  finishedAt!: Date | null;

  @Column({ type: 'varchar', length: 16 })
  status!: BackupRunStatus;

  @Column({ type: 'varchar', length: 16 })
  trigger!: BackupTrigger;

  @Column({ type: 'varchar', length: 16, default: 'incremental' })
  mode!: BackupMode;

  @Column({ name: 'backup_dir', type: 'varchar', length: 512 })
  backupDir!: string;

  @Column({ type: 'text', nullable: true })
  error!: string | null;

  @Column({
    name: 'archive_status',
    type: 'varchar',
    length: 32,
    nullable: true,
  })
  archiveStatus!: string | null;

  /** CSV of source groups requested for this run (queue metadata). */
  @Column({
    name: 'source_groups',
    type: 'varchar',
    length: 128,
    nullable: true,
  })
  sourceGroups!: string | null;

  /** CSV of database names requested for this run (queue metadata). */
  @Column({ name: 'databases', type: 'text', nullable: true })
  databasesFilter!: string | null;

  @Column({ name: 'queued_at', type: 'timestamp', nullable: true })
  queuedAt!: Date | null;

  @OneToMany(() => BackupDatabaseRunEntity, (dbRun) => dbRun.backupRun, {
    cascade: true,
  })
  databases!: Array<Relation<BackupDatabaseRunEntity>>;
}
