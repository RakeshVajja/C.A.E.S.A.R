import cookieParser from 'cookie-parser';
import cors from 'cors';
import express, { Express } from 'express';
import { env } from './config/env';
import { errorHandler, notFoundHandler } from './middleware/errorHandler';
import { requireAllowedOrigin } from './middleware/origin';
import { AuthRateLimits, DEFAULT_AUTH_RATE_LIMITS, RateLimiter } from './middleware/rateLimit';
import { createAuthRouter } from './routes/auth';
import { healthRouter } from './routes/health';
import { createAdminRouter, createMeRouter } from './routes/protected';
import { createSmtpMailer, Mailer } from './services/email/mailer';

export interface AppOptions {
  /** Defaults to SMTP from the environment (null when unconfigured); tests inject a fake. */
  mailer?: Mailer | null;
  now?: () => Date;
  rateLimits?: Partial<AuthRateLimits>;
  /** Express "trust proxy"; defaults to TRUST_PROXY. */
  trustProxy?: boolean | number | string;
}

export function createApp(options: AppOptions = {}): Express {
  const app = express();

  app.disable('x-powered-by');
  app.set('trust proxy', options.trustProxy ?? env.trustProxy);
  app.use(cors({ origin: env.corsOrigin, credentials: true }));
  // State-changing requests from another browser origin are refused before anything else runs.
  app.use('/api', requireAllowedOrigin(env.corsOrigin));
  app.use(express.json());
  app.use(cookieParser());

  const now = options.now ?? (() => new Date());
  app.use('/api/health', healthRouter);
  app.use(
    '/api/auth',
    createAuthRouter({
      mailer: options.mailer !== undefined ? options.mailer : env.smtp ? createSmtpMailer(env.smtp) : null,
      now,
      limiter: new RateLimiter(() => now().getTime()),
      limits: { ...DEFAULT_AUTH_RATE_LIMITS, ...options.rateLimits },
    }),
  );
  app.use('/api/me', createMeRouter());
  app.use('/api/admin', createAdminRouter());

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
