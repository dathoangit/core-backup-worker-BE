import { type MigrationInterface, type QueryRunner } from 'typeorm';

export class InitSchema1780800000000 implements MigrationInterface {
  name = 'InitSchema1780800000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE EXTENSION IF NOT EXISTS "uuid-ossp"`);

    await queryRunner.query(
      `CREATE TYPE "public"."users_role_enum" AS ENUM('nurse', 'doctor', 'admin')`,
    );
    await queryRunner.query(`
      CREATE TABLE "users" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "created_at" TIMESTAMP NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP NOT NULL DEFAULT now(),
        "username" character varying(64) NOT NULL,
        "email" character varying(255),
        "email_verified_at" TIMESTAMP,
        "password_hash" character varying(255) NOT NULL,
        "role" "public"."users_role_enum" NOT NULL DEFAULT 'nurse',
        "is_active" boolean NOT NULL DEFAULT true,
        CONSTRAINT "PK_users" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(
      `CREATE UNIQUE INDEX "IDX_users_username" ON "users" ("username")`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "IDX_users_email" ON "users" ("email")`,
    );

    await queryRunner.query(`
      CREATE TABLE "user_oauth_identities" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "created_at" TIMESTAMP NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP NOT NULL DEFAULT now(),
        "provider" character varying(40) NOT NULL,
        "provider_user_id" character varying(191) NOT NULL,
        "email" character varying(255),
        "profile_json" json,
        "user_id" uuid NOT NULL,
        CONSTRAINT "PK_user_oauth_identities" PRIMARY KEY ("id"),
        CONSTRAINT "FK_user_oauth_identities_user"
          FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE
      )
    `);
    await queryRunner.query(
      `CREATE UNIQUE INDEX "IDX_user_oauth_provider_subject" ON "user_oauth_identities" ("provider", "provider_user_id")`,
    );

    await queryRunner.query(`
      CREATE TABLE "password_reset_tokens" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "created_at" TIMESTAMP NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP NOT NULL DEFAULT now(),
        "token_hash" character varying(255) NOT NULL,
        "expires_at" TIMESTAMP NOT NULL,
        "used_at" TIMESTAMP,
        "user_id" uuid NOT NULL,
        CONSTRAINT "PK_password_reset_tokens" PRIMARY KEY ("id"),
        CONSTRAINT "FK_password_reset_tokens_user"
          FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "IDX_password_reset_tokens_token_hash" ON "password_reset_tokens" ("token_hash")`,
    );

    await queryRunner.query(
      `CREATE TYPE "public"."email_verifications_method_enum" AS ENUM('otp', 'link')`,
    );
    await queryRunner.query(`
      CREATE TABLE "email_verifications" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "created_at" TIMESTAMP NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP NOT NULL DEFAULT now(),
        "email" character varying(255) NOT NULL,
        "method" "public"."email_verifications_method_enum" NOT NULL,
        "token_hash" character varying(255),
        "otp_hash" character varying(255),
        "expires_at" TIMESTAMP NOT NULL,
        "consumed_at" TIMESTAMP,
        "user_id" uuid,
        CONSTRAINT "PK_email_verifications" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "IDX_email_verification_token_hash" ON "email_verifications" ("token_hash")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_email_verification_otp_hash" ON "email_verifications" ("otp_hash")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_email_verification_user_id" ON "email_verifications" ("user_id")`,
    );

    await queryRunner.query(`
      CREATE TABLE "backup_runs" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "created_at" TIMESTAMP NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP NOT NULL DEFAULT now(),
        "run_id" character varying(64) NOT NULL,
        "started_at" TIMESTAMP NOT NULL,
        "finished_at" TIMESTAMP,
        "status" character varying(16) NOT NULL,
        "trigger" character varying(16) NOT NULL,
        "mode" character varying(16) NOT NULL DEFAULT 'incremental',
        "backup_dir" character varying(512) NOT NULL,
        "error" text,
        "archive_status" character varying(32),
        CONSTRAINT "PK_backup_runs" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(
      `CREATE UNIQUE INDEX "IDX_backup_runs_run_id" ON "backup_runs" ("run_id")`,
    );

    await queryRunner.query(`
      CREATE TABLE "backup_database_runs" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "created_at" TIMESTAMP NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP NOT NULL DEFAULT now(),
        "run_id" character varying(64) NOT NULL,
        "source_group" character varying(16) NOT NULL,
        "database" character varying(128) NOT NULL,
        "profile" character varying(32) NOT NULL,
        "status" character varying(16) NOT NULL,
        "watermark_before" character varying(64),
        "captured" character varying(64),
        "watermark_after" character varying(64),
        "chunk_count" integer NOT NULL DEFAULT 0,
        "bytes_total" bigint NOT NULL DEFAULT 0,
        "row_count_total" bigint NOT NULL DEFAULT 0,
        "skipped_table_count" integer NOT NULL DEFAULT 0,
        "error" text,
        "backup_run_id" uuid NOT NULL,
        CONSTRAINT "PK_backup_database_runs" PRIMARY KEY ("id"),
        CONSTRAINT "FK_backup_database_runs_backup_run"
          FOREIGN KEY ("backup_run_id") REFERENCES "backup_runs"("id") ON DELETE CASCADE
      )
    `);
    await queryRunner.query(
      `CREATE UNIQUE INDEX "IDX_backup_database_runs_run_db" ON "backup_database_runs" ("run_id", "database")`,
    );

    await queryRunner.query(`
      CREATE TABLE "app_settings" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "created_at" TIMESTAMP NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP NOT NULL DEFAULT now(),
        "key" character varying(128) NOT NULL,
        "value" text,
        "is_secret" boolean NOT NULL DEFAULT false,
        "category" character varying(32) NOT NULL,
        CONSTRAINT "PK_app_settings" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(
      `CREATE UNIQUE INDEX "IDX_app_settings_key" ON "app_settings" ("key")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "app_settings"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "backup_database_runs"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "backup_runs"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "email_verifications"`);
    await queryRunner.query(
      `DROP TYPE IF EXISTS "public"."email_verifications_method_enum"`,
    );
    await queryRunner.query(`DROP TABLE IF EXISTS "password_reset_tokens"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "user_oauth_identities"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "users"`);
    await queryRunner.query(`DROP TYPE IF EXISTS "public"."users_role_enum"`);
  }
}
