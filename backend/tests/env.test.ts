import { describe, expect, it } from 'vitest';
import { loadEnv } from '../src/config/env';

const validSource = {
  NODE_ENV: 'development',
  PORT: '5001',
  DATABASE_URL: 'postgresql://localhost:5432/cse_research_hub?schema=public',
  CORS_ORIGIN: 'http://localhost:3000',
  JWT_SECRET: 'x'.repeat(32),
};

describe('loadEnv', () => {
  it('parses a valid configuration', () => {
    expect(loadEnv(validSource)).toEqual({
      nodeEnv: 'development',
      port: 5001,
      databaseUrl: 'postgresql://localhost:5432/cse_research_hub?schema=public',
      corsOrigin: 'http://localhost:3000',
      openAlexApiKey: null,
      jwtSecret: 'x'.repeat(32),
      trustProxy: false,
      smtp: null,
      syncCron: '0 2 1 * *',
      syncTimezone: 'Asia/Kolkata',
    });
  });

  it('reads an optional OpenAlex API key, treating an empty value as absent', () => {
    expect(loadEnv({ ...validSource, OPENALEX_API_KEY: ' key-123 ' }).openAlexApiKey).toBe('key-123');
    expect(loadEnv({ ...validSource, OPENALEX_API_KEY: '' }).openAlexApiKey).toBeNull();
  });

  it('applies defaults for optional values', () => {
    const env = loadEnv({ DATABASE_URL: validSource.DATABASE_URL, JWT_SECRET: validSource.JWT_SECRET });
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

  it('requires JWT_SECRET with at least 32 characters, without echoing the value', () => {
    expect(() => loadEnv({ ...validSource, JWT_SECRET: undefined })).toThrow(/JWT_SECRET is required/);
    const short = 'short-secret-value';
    let message = '';
    try {
      loadEnv({ ...validSource, JWT_SECRET: short });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toMatch(/JWT_SECRET must be at least 32 characters/);
    expect(message).not.toContain(short);
  });

  it('disables recovery when no SMTP setting is present', () => {
    expect(loadEnv({ ...validSource, SMTP_HOST: '', MAIL_FROM: ' ' }).smtp).toBeNull();
  });

  it('reads generic SMTP settings (any provider)', () => {
    const smtp = {
      SMTP_HOST: 'smtp.example.org',
      SMTP_PORT: '587',
      SMTP_SECURE: 'false',
      SMTP_USER: 'mailer@example.org',
      SMTP_PASSWORD: 'app-password-value',
      MAIL_FROM: 'CSE Research Hub <mailer@example.org>',
    };
    expect(loadEnv({ ...validSource, ...smtp }).smtp).toEqual({
      host: 'smtp.example.org',
      port: 587,
      secure: false,
      auth: { user: 'mailer@example.org', pass: 'app-password-value' },
      from: 'CSE Research Hub <mailer@example.org>',
    });
    // A relay without authentication (e.g. an institute-internal server).
    expect(loadEnv({ ...validSource, SMTP_HOST: 'relay.example.org', SMTP_PORT: '25', MAIL_FROM: 'noreply@example.org' }).smtp).toMatchObject({
      auth: null,
      secure: false,
    });
  });

  it('rejects incomplete or malformed SMTP settings without echoing values', () => {
    let message = '';
    try {
      loadEnv({ ...validSource, SMTP_HOST: 'smtp.example.org', SMTP_USER: 'u', SMTP_PASSWORD: 'super-secret-pw', SMTP_SECURE: 'yes' });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toMatch(/SMTP_PORT is required/);
    expect(message).toMatch(/MAIL_FROM is required/);
    expect(message).toMatch(/SMTP_SECURE must be "true" or "false"/);
    expect(message).not.toContain('super-secret-pw');
    expect(() => loadEnv({ ...validSource, SMTP_HOST: 'h', SMTP_PORT: '587', MAIL_FROM: 'a@b.c', SMTP_USER: 'u' })).toThrow(
      /SMTP_USER and SMTP_PASSWORD must be set together/,
    );
  });

  it('parses TRUST_PROXY', () => {
    expect(loadEnv({ ...validSource, TRUST_PROXY: 'true' }).trustProxy).toBe(true);
    expect(loadEnv({ ...validSource, TRUST_PROXY: '1' }).trustProxy).toBe(1);
    expect(loadEnv({ ...validSource, TRUST_PROXY: 'loopback' }).trustProxy).toBe('loopback');
    expect(loadEnv({ ...validSource, TRUST_PROXY: '' }).trustProxy).toBe(false);
  });

  it('validates the synchronization schedule (defaults: 02:00 on the 1st, Asia/Kolkata)', () => {
    expect(loadEnv({ ...validSource, SYNC_CRON: '30 3 15 * *', SYNC_TIMEZONE: 'UTC' })).toMatchObject({ syncCron: '30 3 15 * *', syncTimezone: 'UTC' });
    expect(() => loadEnv({ ...validSource, SYNC_CRON: 'every month' })).toThrow(/SYNC_CRON must be a valid cron expression/);
    expect(() => loadEnv({ ...validSource, SYNC_TIMEZONE: 'Mars/Olympus' })).toThrow(/SYNC_TIMEZONE must be an IANA time zone/);
  });
});
