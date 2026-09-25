import { execSync } from 'child_process';
import path from 'path';
import type { TestProject } from 'vitest/node';

// Brings the test database schema up to date before any test file runs.
// `migrate deploy` only applies pending migrations; it never resets data.
export default function globalSetup(project: TestProject): void {
  const databaseUrl = project.config.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL is not set in the Vitest test environment');
  const dbName = new URL(databaseUrl).pathname.replace(/^\//, '');
  if (!dbName.endsWith('_test')) {
    throw new Error(`Refusing to run tests against "${dbName}": the test database name must end with "_test"`);
  }

  execSync('npx prisma migrate deploy', {
    cwd: path.resolve(__dirname, '../..'),
    env: { ...process.env, DATABASE_URL: databaseUrl },
    stdio: 'pipe',
  });
}
