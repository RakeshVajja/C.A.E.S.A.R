import { NextFunction, Request, RequestHandler, Response } from 'express';
import { HttpError } from '../utils/httpError';

/**
 * Per-IP rate limiting for the authentication and recovery endpoints (Project_plan.md §15.2,
 * decision #59). Fixed windows counted in process memory: limits are not shared between several
 * backend instances and restart from zero when the process restarts. Behind a reverse proxy,
 * TRUST_PROXY must be set so that req.ip is the client address.
 *
 * Every request counts, whatever the account or outcome, so the limiter itself reveals nothing
 * about which email addresses exist. Per-account recovery limits are enforced in the database.
 */

export interface RateLimitRule {
  windowMs: number;
  max: number;
}

export type AuthRateLimits = Record<
  'login' | 'changePassword' | 'recoveryRequest' | 'recoveryVerify' | 'recoveryReset',
  RateLimitRule
>;

const MINUTE = 60 * 1000;

export const DEFAULT_AUTH_RATE_LIMITS: AuthRateLimits = {
  login: { windowMs: 15 * MINUTE, max: 20 },
  changePassword: { windowMs: 15 * MINUTE, max: 10 },
  recoveryRequest: { windowMs: 15 * MINUTE, max: 5 },
  recoveryVerify: { windowMs: 15 * MINUTE, max: 15 },
  recoveryReset: { windowMs: 15 * MINUTE, max: 10 },
};

export class RateLimiter {
  private readonly windows = new Map<string, { count: number; resetAt: number }>();
  private hitsSinceSweep = 0;

  constructor(private readonly now: () => number = Date.now) {}

  /** Counts one request for `key`; returns how long to wait when the limit is exceeded. */
  hit(key: string, rule: RateLimitRule): { allowed: boolean; retryAfterMs: number } {
    const now = this.now();
    this.sweep(now);
    let window = this.windows.get(key);
    if (!window || window.resetAt <= now) {
      window = { count: 0, resetAt: now + rule.windowMs };
      this.windows.set(key, window);
    }
    window.count++;
    return window.count <= rule.max ? { allowed: true, retryAfterMs: 0 } : { allowed: false, retryAfterMs: window.resetAt - now };
  }

  /** Drops expired windows now and then, so memory stays bounded by the active keys. */
  private sweep(now: number): void {
    if (++this.hitsSinceSweep < 1000) return;
    this.hitsSinceSweep = 0;
    for (const [key, window] of this.windows) if (window.resetAt <= now) this.windows.delete(key);
  }
}

export function rateLimit(limiter: RateLimiter, name: string, rule: RateLimitRule): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    const { allowed, retryAfterMs } = limiter.hit(`${name}:${req.ip ?? 'unknown'}`, rule);
    if (!allowed) {
      res.setHeader('Retry-After', String(Math.ceil(retryAfterMs / 1000)));
      throw new HttpError(429, 'RATE_LIMITED', 'Too many requests; try again later');
    }
    next();
  };
}
