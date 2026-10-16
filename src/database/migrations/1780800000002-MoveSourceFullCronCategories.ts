import { type MigrationInterface, type QueryRunner } from 'typeorm';

/**
 * Move source-specific full-backup cron keys out of the general ("backup")
 * category into their source tabs (his / emr).
 */
export class MoveSourceFullCronCategories1780800000002
  implements MigrationInterface
{
  name = 'MoveSourceFullCronCategories1780800000002';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `UPDATE "app_settings" SET "category" = 'his', "updated_at" = CURRENT_TIMESTAMP
       WHERE "key" = 'BACKUP_HIS_FULL_CRON'`,
    );
    await queryRunner.query(
      `UPDATE "app_settings" SET "category" = 'emr', "updated_at" = CURRENT_TIMESTAMP
       WHERE "key" = 'BACKUP_EMR_FULL_CRON'`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `UPDATE "app_settings" SET "category" = 'backup', "updated_at" = CURRENT_TIMESTAMP
       WHERE "key" IN ('BACKUP_HIS_FULL_CRON', 'BACKUP_EMR_FULL_CRON')`,
    );
  }
}
