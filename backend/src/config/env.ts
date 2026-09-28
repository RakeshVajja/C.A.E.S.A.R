import dotenv from 'dotenv';
import path from 'path';
import { z } from 'zod';

// Values already present in process.env (e.g. set by the test runner) take precedence over .env.
dotenv.config({ path: path.resolve(__dirname, '../../.env') });

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(5001),
  DATABASE_URL: z
    .string({ error: 'DATABASE_URL is required' })
    .regex(/^postgres(ql)?:\/\/.+/, 'DATABASE_URL must be a PostgreSQL connection URL'),
  CORS_ORIGIN: z.url().default('http://localhost:3000'),
  // Optional (decision #32): sent to OpenAlex when set; requests are keyless otherwise.
  OPENALEX_API_KEY: z
    .string()
    .trim()
    .optional()
    .transform((value) => (value ? value : null)),
});

export interface Env {
  nodeEnv: 'development' | 'test' | 'production';
  port: number;
  databaseUrl: string;
  corsOrigin: string;
  openAlexApiKey: string | null;
}

export function loadEnv(source: NodeJS.ProcessEnv): Env {
  const result = envSchema.safeParse(source);

  if (!result.success) {
    const problems = result.error.issues
      .map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${problems}`);
  }

  return {
    nodeEnv: result.data.NODE_ENV,
    port: result.data.PORT,
    databaseUrl: result.data.DATABASE_URL,
    corsOrigin: result.data.CORS_ORIGIN,
    openAlexApiKey: result.data.OPENALEX_API_KEY,
  };
}

export const env = loadEnv(process.env);
