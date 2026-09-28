import dotenv from 'dotenv';
import fs from 'node:fs';
import path from 'node:path';
import { defineConfig } from 'vitest/config';

/**
 * Tests use their own database: TEST_DATABASE_URL if set, otherwise the development
 * DATABASE_URL (backend/.env) with "_test" appended to the database name.
 * Test helpers refuse to touch any database whose name does not end in "_test".
 */
function resolveTestDatabaseUrl(): string {
  if (process.env.TEST_DATABASE_URL) return process.env.TEST_DATABASE_URL;

  const envFile = path.resolve(import.meta.dirname, '.env');
  const fileValues = fs.existsSync(envFile) ? dotenv.parse(fs.readFileSync(envFile)) : {};
  const devUrl = fileValues.DATABASE_URL ?? process.env.DATABASE_URL;
  if (!devUrl) {
    throw new Error('Cannot derive the test database URL: set TEST_DATABASE_URL or DATABASE_URL in backend/.env');
  }

  const url = new URL(devUrl);
  const dbName = url.pathname.replace(/^\//, '');
  url.pathname = `/${dbName.endsWith('_test') ? dbName : `${dbName}_test`}`;
  return url.toString();
}

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    globalSetup: ['tests/setup/globalSetup.ts'],
    setupFiles: ['tests/setup/noNetwork.ts'],
    // Database test files share one database; run files one at a time.
    fileParallelism: false,
    // dotenv never overrides these, so tests cannot reach the development database.
    env: {
      NODE_ENV: 'test',
      DATABASE_URL: resolveTestDatabaseUrl(),
      CORS_ORIGIN: 'http://localhost:3000',
    },
  },
});
