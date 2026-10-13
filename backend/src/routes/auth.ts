import { Router } from 'express';
import { z } from 'zod';
import {
  clearSessionCookie,
  cookieOptions,
  RECOVERY_PATH,
  requireAuth,
  RESET_COOKIE,
  setSessionCookie,
} from '../middleware/auth';
import { AuthRateLimits, rateLimit, RateLimiter } from '../middleware/rateLimit';
import { authenticate, changePassword, publicUser } from '../services/auth/accounts';
import { RecoveryDeps, requestPasswordRecovery, resetPasswordWithRecovery, verifyRecoveryCode } from '../services/auth/passwordRecovery';
import { signSessionToken } from '../services/auth/tokens';
import { HttpError } from '../utils/httpError';
import { parseBody } from '../utils/validation';

/**
 * /api/auth (Project_plan.md §15.3, §15.4): login, logout, current user, change password and
 * professor password recovery. Tokens never appear in response bodies.
 */

const email = z.string().trim().toLowerCase().max(254).pipe(z.email());
// Passwords are taken exactly as typed (never trimmed); the bound only protects the server.
const password = z.string().min(1).max(1024);

const loginBody = z.object({ email, password });
const changePasswordBody = z.object({ currentPassword: password, newPassword: password });
const recoveryRequestBody = z.object({ email });
const recoveryVerifyBody = z.object({ email, code: z.string().regex(/^\d{6}$/, 'The code has 6 digits') });
const recoveryResetBody = z.object({ newPassword: password });

const RECOVERY_REQUESTED = 'If an eligible account exists for this email address, a recovery code has been sent.';

export interface AuthRouterOptions extends RecoveryDeps {
  limiter: RateLimiter;
  limits: AuthRateLimits;
}

export function createAuthRouter(options: AuthRouterOptions): Router {
  const router = Router();
  const limit = (name: keyof AuthRateLimits) => rateLimit(options.limiter, name, options.limits[name]);

  router.post('/login', limit('login'), async (req, res) => {
    const body = parseBody(loginBody, req.body);
    const user = await authenticate(body.email, body.password);
    if (!user) throw new HttpError(401, 'INVALID_CREDENTIALS', 'Invalid email or password');
    setSessionCookie(res, signSessionToken(user.id, user.passwordHash));
    res.json({ user: publicUser(user) });
  });

  router.post('/logout', (req, res) => {
    clearSessionCookie(res);
    res.status(204).end();
  });

  router.get('/me', requireAuth, (req, res) => {
    res.json({ user: req.auth!.user });
  });

  router.post('/change-password', limit('changePassword'), requireAuth, async (req, res) => {
    const body = parseBody(changePasswordBody, req.body);
    const user = await changePassword(req.auth!.user.id, body.currentPassword, body.newPassword);
    // The new password ends every other session; this one continues with a fresh token.
    setSessionCookie(res, signSessionToken(user.id, user.passwordHash));
    res.json({ user: publicUser(user) });
  });

  router.post('/password-recovery/request', limit('recoveryRequest'), async (req, res) => {
    const body = parseBody(recoveryRequestBody, req.body);
    // Not awaited: the response must not depend on whether an email is being sent.
    await requestPasswordRecovery(body.email, options);
    res.status(202).json({ message: RECOVERY_REQUESTED });
  });

  router.post('/password-recovery/verify', limit('recoveryVerify'), async (req, res) => {
    const body = parseBody(recoveryVerifyBody, req.body);
    const { token, expiresAt } = await verifyRecoveryCode(body.email, body.code, options);
    res.cookie(RESET_COOKIE, token, { ...cookieOptions(RECOVERY_PATH), maxAge: expiresAt.getTime() - options.now().getTime() });
    res.json({ message: 'Code verified. Set a new password before it expires.', expiresAt: expiresAt.toISOString() });
  });

  router.post('/password-recovery/reset', limit('recoveryReset'), async (req, res) => {
    const body = parseBody(recoveryResetBody, req.body);
    const token: unknown = req.cookies?.[RESET_COOKIE];
    // A missing cookie is handled like an invalid token (and 503 first when recovery is unavailable).
    await resetPasswordWithRecovery(typeof token === 'string' ? token : '', body.newPassword, options);
    res.clearCookie(RESET_COOKIE, cookieOptions(RECOVERY_PATH));
    clearSessionCookie(res);
    res.json({ message: 'Password updated. Sign in with your new password.' });
  });

  return router;
}
