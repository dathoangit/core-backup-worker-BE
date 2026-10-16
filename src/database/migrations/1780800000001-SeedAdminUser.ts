import { type MigrationInterface, type QueryRunner } from 'typeorm';

// bcrypt hash for password: 0123456789 (cost factor 10)
const ADMIN_PASSWORD_HASH =
  '$2b$10$JDWFAr7VaVJq1EryeWsC1eIojxbR4MSZDsY2i.c0qTw4pUGFulQeS';

export class SeedAdminUser1780800000001 implements MigrationInterface {
  name = 'SeedAdminUser1780800000001';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `INSERT INTO "users" ("username", "email", "password_hash", "role", "is_active")
       SELECT 'admin', 'admin@example.com', '${ADMIN_PASSWORD_HASH}', 'admin', true
       WHERE NOT EXISTS (
         SELECT 1 FROM "users" WHERE "username" = 'admin'
       )`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DELETE FROM "users" WHERE "username" = 'admin'`);
  }
}
