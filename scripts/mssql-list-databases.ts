/* eslint-disable no-console, unicorn/prefer-top-level-await */
import { config as loadEnv } from 'dotenv';
import sql from 'mssql';

loadEnv();

const REQUIRED_ENV = ['MSSQL_HOST', 'MSSQL_USER', 'MSSQL_PASSWORD'] as const;

function readPort(): number | undefined {
  if (!process.env.MSSQL_PORT) {
    return undefined;
  }

  const port = Number(process.env.MSSQL_PORT);

  if (!Number.isInteger(port) || port <= 0) {
    throw new Error(`Invalid MSSQL_PORT: ${process.env.MSSQL_PORT}`);
  }

  return port;
}

function readConfig(): sql.config {
  const missing = REQUIRED_ENV.filter((key) => !process.env[key]);

  if (missing.length > 0) {
    throw new Error(`Missing required env: ${missing.join(', ')}`);
  }

  const port = readPort() ?? 1433;

  return {
    server: process.env.MSSQL_HOST!,
    port,
    user: process.env.MSSQL_USER,
    password: process.env.MSSQL_PASSWORD,
    database: process.env.MSSQL_DATABASE || 'master',
    connectionTimeout: 15_000,
    options: {
      encrypt: false,
      trustServerCertificate: true,
    },
  };
}

function errorCode(error: unknown): string {
  if (error && typeof error === 'object' && 'code' in error) {
    return String((error as { code: unknown }).code);
  }

  return 'UNKNOWN';
}

async function main(): Promise<void> {
  const pool = new sql.ConnectionPool(readConfig());

  try {
    await pool.connect();

    const result = await pool.request().query(`
      SELECT name, state_desc, recovery_model_desc,
             HAS_DBACCESS(name) AS has_access
      FROM sys.databases
      WHERE database_id > 4
      ORDER BY name
    `);

    console.table(result.recordset);
    console.log(`Total databases: ${result.recordset.length}`);
  } finally {
    await pool.close();
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);

  console.error(`MSSQL connection failed (${errorCode(error)}): ${message}`);
  process.exitCode = 1;
});
