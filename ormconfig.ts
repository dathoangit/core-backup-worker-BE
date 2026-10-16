/* eslint-disable canonical/filename-match-exported */
import './src/boilerplate.polyfill';

import dotenv from 'dotenv';
import { DataSource } from 'typeorm';

import { SnakeNamingStrategy } from './src/snake-naming.strategy';

dotenv.config();

const dbType = (process.env.DB_TYPE || 'postgres').toLowerCase();
const normalizedDbType = dbType === 'mysql' ? 'mysql' : 'postgres';

const dataSource = new DataSource({
  type: normalizedDbType,
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT),
  username: process.env.DB_USERNAME,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_DATABASE,
  ...(normalizedDbType === 'mysql' ? { charset: 'utf8mb4_unicode_ci' } : {}),
  namingStrategy: new SnakeNamingStrategy(),
  entities: [
    'src/modules/**/*.entity{.ts,.js}',
    'src/modules/**/*.view-entity{.ts,.js}',
  ],
  migrations: ['src/database/migrations/*{.ts,.js}'],
});

export default dataSource;
