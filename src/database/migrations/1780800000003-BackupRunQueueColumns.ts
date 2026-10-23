import { type MigrationInterface, type QueryRunner } from 'typeorm';

export class BackupRunQueueColumns1780800000003 implements MigrationInterface {
  name = 'BackupRunQueueColumns1780800000003';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "backup_runs"
        ADD COLUMN IF NOT EXISTS "source_groups" character varying(128),
        ADD COLUMN IF NOT EXISTS "databases" text,
        ADD COLUMN IF NOT EXISTS "queued_at" TIMESTAMP
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "backup_runs"
        DROP COLUMN IF EXISTS "queued_at",
        DROP COLUMN IF EXISTS "databases",
        DROP COLUMN IF EXISTS "source_groups"
    `);
  }
}
