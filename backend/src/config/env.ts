import dotenv from 'dotenv';
import path from 'path';
import cron from 'node-cron';
import { z } from 'zod';

// Values already present in process.env (e.g. set by the test runner) take precedence over .env.
dotenv.config({ path: path.resolve(__dirname, '../../.env') });

/** 02:00 on the 1st of every month (decision #81; the exact time was deferred to Phase 12). */
export const DEFAULT_SYNC_CRON = '0 2 1 * *';
export const DEFAULT_SYNC_TIMEZONE = 'Asia/Kolkata';
/**
 * Journal Citation Reports refresh (stage 15.6, decision #123: its own schedule): 03:00 on the 15th
 * of every month, away from the discovery run on the 1st. Same time zone as SYNC_TIMEZONE.
 */
export const DEFAULT_JCR_SYNC_CRON = '0 3 15 * *';

function isTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat('en', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

/** Unset and empty values are treated alike. */
const optionalText = z
  .string()
  .trim()
  .optional()
  .transform((value) => (value ? value : null));

const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().min(1).max(65535).default(5001),
    DATABASE_URL: z
      .string({ error: 'DATABASE_URL is required' })
      .regex(/^postgres(ql)?:\/\/.+/, 'DATABASE_URL must be a PostgreSQL connection URL'),
    CORS_ORIGIN: z.url().default('http://localhost:3000'),
    // Optional (decision #32): sent to OpenAlex when set; requests are keyless otherwise.
    OPENALEX_API_KEY: optionalText,
    // Signs session and password-reset tokens; the recovery-code HMAC key is derived from it (§15).
    JWT_SECRET: z
      .string({ error: 'JWT_SECRET is required' })
      .min(32, 'JWT_SECRET must be at least 32 characters'),
    // Express "trust proxy" (needed behind a reverse proxy so per-IP rate limits see client IPs).
    TRUST_PROXY: optionalText,
    // SMTP for professor password-recovery emails (§15.4). All unset → recovery is disabled.
    SMTP_HOST: optionalText,
    SMTP_PORT: optionalText,
    SMTP_SECURE: optionalText,
    SMTP_USER: optionalText,
    SMTP_PASSWORD: optionalText,
    MAIL_FROM: optionalText,
    // Licensed providers (Project_plan.md §13.6–§13.9, Phase 15). Unset → that provider is
    // NOT_CONFIGURED; there are no enable/disable switches. Never logged or returned.
    SCOPUS_API_KEY: optionalText,
    // Elsevier institutional token, needed outside the institution's IP range.
    SCOPUS_INST_TOKEN: optionalText,
    WOS_STARTER_API_KEY: optionalText,
    // Web of Science Journals API (Journal Citation Reports).
    WOS_JOURNALS_API_KEY: optionalText,
    // Monthly synchronization (§14, decision #81): node-cron expression and IANA time zone.
    SYNC_CRON: optionalText
      .transform((value) => value ?? DEFAULT_SYNC_CRON)
      .refine((value) => cron.validate(value), 'SYNC_CRON must be a valid cron expression'),
    SYNC_TIMEZONE: optionalText
      .transform((value) => value ?? DEFAULT_SYNC_TIMEZONE)
      .refine(isTimeZone, 'SYNC_TIMEZONE must be an IANA time zone such as Asia/Kolkata'),
    JCR_SYNC_CRON: optionalText
      .transform((value) => value ?? DEFAULT_JCR_SYNC_CRON)
      .refine((value) => cron.validate(value), 'JCR_SYNC_CRON must be a valid cron expression'),
  })
  .superRefine((value, ctx) => {
    const smtpKeys = ['SMTP_HOST', 'SMTP_PORT', 'SMTP_SECURE', 'SMTP_USER', 'SMTP_PASSWORD', 'MAIL_FROM'] as const;
    if (smtpKeys.every((key) => value[key] === null)) return;
    for (const key of ['SMTP_HOST', 'SMTP_PORT', 'MAIL_FROM'] as const) {
      if (value[key] === null) ctx.addIssue({ code: 'custom', path: [key], message: `${key} is required when SMTP is configured` });
    }
    if (value.SMTP_PORT !== null && !/^\d{1,5}$/.test(value.SMTP_PORT)) {
      ctx.addIssue({ code: 'custom', path: ['SMTP_PORT'], message: 'SMTP_PORT must be a port number' });
    }
    if (value.SMTP_SECURE !== null && !['true', 'false'].includes(value.SMTP_SECURE)) {
      ctx.addIssue({ code: 'custom', path: ['SMTP_SECURE'], message: 'SMTP_SECURE must be "true" or "false"' });
    }
    if ((value.SMTP_USER === null) !== (value.SMTP_PASSWORD === null)) {
      ctx.addIssue({ code: 'custom', path: ['SMTP_USER'], message: 'SMTP_USER and SMTP_PASSWORD must be set together' });
    }
  });

export interface SmtpConfig {
  host: string;
  port: number;
  /** true: TLS from the start (usually port 465); false: STARTTLS is required (usually port 587). */
  secure: boolean;
  auth: { user: string; pass: string } | null;
  from: string;
}

export interface Env {
  nodeEnv: 'development' | 'test' | 'production';
  port: number;
  databaseUrl: string;
  corsOrigin: string;
  openAlexApiKey: string | null;
  jwtSecret: string;
  trustProxy: boolean | number | string;
  /** null when SMTP is not configured: password recovery is then unavailable. */
  smtp: SmtpConfig | null;
  syncCron: string;
  syncTimezone: string;
  /** Journal Citation Reports refresh schedule (in syncTimezone). */
  jcrSyncCron: string;
  /** Licensed provider credentials; null = that provider is NOT_CONFIGURED (§13.9). */
  providerCredentials: ProviderCredentials;
}

export interface ProviderCredentials {
  scopus: { apiKey: string; instToken: string | null } | null;
  wosStarter: { apiKey: string } | null;
  wosJournals: { apiKey: string } | null;
  /**
   * Incomplete provider configuration (e.g. a Scopus institutional token without an API key). It
   * never stops startup: the provider is reported as incompletely configured and not used, and the
   * other providers are unaffected (§13.9). Messages name variables only, never values.
   */
  issues: ProviderConfigurationIssue[];
}

export interface ProviderConfigurationIssue {
  provider: 'SCOPUS' | 'WOS' | 'JCR';
  message: string;
}

export function loadEnv(source: NodeJS.ProcessEnv): Env {
  const result = envSchema.safeParse(source);

  if (!result.success) {
    // Only names and rules are reported, never values (they may be secrets).
    const problems = result.error.issues
      .map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${problems}`);
  }

  const data = result.data;
  return {
    nodeEnv: data.NODE_ENV,
    port: data.PORT,
    databaseUrl: data.DATABASE_URL,
    corsOrigin: data.CORS_ORIGIN,
    openAlexApiKey: data.OPENALEX_API_KEY,
    jwtSecret: data.JWT_SECRET,
    trustProxy: parseTrustProxy(data.TRUST_PROXY),
    smtp:
      data.SMTP_HOST && data.SMTP_PORT && data.MAIL_FROM
        ? {
            host: data.SMTP_HOST,
            port: Number(data.SMTP_PORT),
            secure: data.SMTP_SECURE === 'true',
            auth: data.SMTP_USER && data.SMTP_PASSWORD ? { user: data.SMTP_USER, pass: data.SMTP_PASSWORD } : null,
            from: data.MAIL_FROM,
          }
        : null,
    syncCron: data.SYNC_CRON,
    syncTimezone: data.SYNC_TIMEZONE,
    jcrSyncCron: data.JCR_SYNC_CRON,
    providerCredentials: {
      scopus: data.SCOPUS_API_KEY ? { apiKey: data.SCOPUS_API_KEY, instToken: data.SCOPUS_INST_TOKEN } : null,
      wosStarter: data.WOS_STARTER_API_KEY ? { apiKey: data.WOS_STARTER_API_KEY } : null,
      wosJournals: data.WOS_JOURNALS_API_KEY ? { apiKey: data.WOS_JOURNALS_API_KEY } : null,
      issues:
        data.SCOPUS_INST_TOKEN && !data.SCOPUS_API_KEY
          ? [{ provider: 'SCOPUS', message: 'SCOPUS_INST_TOKEN is set but SCOPUS_API_KEY is not' }]
          : [],
    },
  };
}

/** "true"/"false", a hop count, or Express's address/subnet list; unset → false (no proxy). */
function parseTrustProxy(value: string | null): boolean | number | string {
  if (value === null || value === 'false') return false;
  if (value === 'true') return true;
  return /^\d+$/.test(value) ? Number(value) : value;
}

export const env = loadEnv(process.env);
