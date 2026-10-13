import { NextFunction, Request, Response } from 'express';
import type { UserRole } from '@prisma/client';
import { env } from '../config/env';
import { loadSessionAccount, publicUser } from '../services/auth/accounts';
import { SESSION_TTL_SECONDS } from '../services/auth/tokens';
import { HttpError } from '../utils/httpError';

/**
 * Session cookie and route protection (Project_plan.md §15.2, §15.3). The JWT lives only in an
 * HttpOnly, SameSite=Lax cookie (Secure in production). Every authenticated request reloads the
 * user from the database: role, professor link, active state and password fingerprint are current.
 */

export const SESSION_COOKIE = 'cse_session';
export const RECOVERY_PATH = '/api/auth/password-recovery';
export const RESET_COOKIE = 'cse_password_reset';

export function cookieOptions(path: string) {
  return { httpOnly: true, sameSite: 'lax' as const, secure: env.nodeEnv === 'production', path };
}

export function setSessionCookie(res: Response, token: string): void {
  res.cookie(SESSION_COOKIE, token, { ...cookieOptions('/'), maxAge: SESSION_TTL_SECONDS * 1000 });
}

export function clearSessionCookie(res: Response): void {
  res.clearCookie(SESSION_COOKIE, cookieOptions('/'));
}

/** Requires a valid session; sets req.auth. An invalid session cookie is cleared. */
export async function requireAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  const token: unknown = req.cookies?.[SESSION_COOKIE];
  const user = typeof token === 'string' && token ? await loadSessionAccount(token) : null;
  if (!user) {
    if (token !== undefined) clearSessionCookie(res);
    throw new HttpError(401, 'UNAUTHENTICATED', 'Authentication required');
  }
  req.auth = { user: publicUser(user) };
  next();
}

/** While a temporary password is in use, only /api/auth/me, change-password and logout are allowed. */
export function requirePasswordChanged(req: Request, res: Response, next: NextFunction): void {
  if (req.auth?.user.mustChangePassword) {
    throw new HttpError(403, 'PASSWORD_CHANGE_REQUIRED', 'Change your temporary password first');
  }
  next();
}

export function requireRole(role: UserRole) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (req.auth?.user.role !== role) throw new HttpError(403, 'FORBIDDEN', 'You do not have access to this resource');
    next();
  };
}
