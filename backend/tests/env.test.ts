import { describe, expect, it } from 'vitest';
import { loadEnv } from '../src/config/env';

const validSource = {
  NODE_ENV: 'development',
  PORT: '5001',
  DATABASE_URL: 'postgresql://localhost:5432/cse_research_hub?schema=public',
  CORS_ORIGIN: 'http://localhost:3000',
};

describe('loadEnv', () => {
  it('parses a valid configuration', () => {
    expect(loadEnv(validSource)).toEqual({
      nodeEnv: 'development',
      port: 5001,
      databaseUrl: 'postgresql://localhost:5432/cse_research_hub?schema=public',
      corsOrigin: 'http://localhost:3000',
    });
  });

  it('applies defaults for optional values', () => {
    const env = loadEnv({ DATABASE_URL: validSource.DATABASE_URL });
    expect(env.nodeEnv).toBe('development');
    expect(env.port).toBe(5001);
    expect(env.corsOrigin).toBe('http://localhost:3000');
  });

  it('fails fast when DATABASE_URL is missing', () => {
    expect(() => loadEnv({ ...validSource, DATABASE_URL: undefined })).toThrow(/DATABASE_URL/);
  });

  it('rejects a non-PostgreSQL DATABASE_URL', () => {
    expect(() => loadEnv({ ...validSource, DATABASE_URL: 'mysql://localhost/db' })).toThrow(/PostgreSQL/);
  });

  it('rejects an invalid PORT', () => {
    expect(() => loadEnv({ ...validSource, PORT: 'abc' })).toThrow(/PORT/);
  });

  it('rejects an unknown NODE_ENV', () => {
    expect(() => loadEnv({ ...validSource, NODE_ENV: 'staging' })).toThrow(/NODE_ENV/);
  });
});
