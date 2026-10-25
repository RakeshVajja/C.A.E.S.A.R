import { PrismaClient } from '@prisma/client';
import { createHmac, randomInt, timingSafeEqual } from 'crypto';
import { prisma as defaultClient } from '../../config/database';
import { HttpError } from '../../utils/httpError';
import { describeMailError, Mailer } from '../email/mailer';
import { AccountUser, CLEARED_RECOVERY_CODE, findAccountByEmail } from './accounts';
import { assertNewPassword, hashPassword } from './password';
import { derivedKey, recoveryCodeBinding, signResetToken, verifyResetToken } from './tokens';

/**
 * Professor password recovery by emailed one-time code (Project_plan.md §15.4, decisions #53–#55).
 *
 *   request → a 6-digit code is emailed (same public response for every email address)
 *   verify  → a correct code yields a short-lived reset token bound to that code's issuance
 *   reset   → the token is consumed atomically and the password replaced; every session ends
 *
 * Only a keyed HMAC of the code is stored. Limits are enforced by single conditional UPDATEs, so
 * concurrent requests cannot exceed them. Administrators are never eligible (admin CLI only).
 *
 * Recovery window (decision #61): it lasts until an hour has passed since the last code was sent.
 * Within it, at most RECOVERY_MAX_SENDS_PER_HOUR codes are sent and RECOVERY_MAX_ATTEMPTS
 * verifications are allowed in total — a replacement code does not restore the attempt budget,
 * and no code is sent while the budget is used up (decision #64).
 */

export const RECOVERY_CODE_TTL_MS = 10 * 60 * 1000;
export const RECOVERY_MAX_ATTEMPTS = 5;
export const RECOVERY_RESEND_COOLDOWN_MS = 60 * 1000;
export const RECOVERY_MAX_SENDS_PER_HOUR = 5;
export const RESET_TOKEN_TTL_MS = 10 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

export interface RecoveryDeps {
  /** null when SMTP is not configured: recovery is then unavailable for everyone. */
  mailer: Mailer | null;
  now: () => Date;
  client?: PrismaClient;
}

const codeKey = derivedKey('recovery-code');

const unavailable = () => new HttpError(503, 'RECOVERY_UNAVAILABLE', 'Password recovery is currently unavailable');
const invalidCode = () => new HttpError(400, 'INVALID_OR_EXPIRED_CODE', 'The code is invalid or has expired');
const invalidReset = () =>
  new HttpError(400, 'INVALID_OR_EXPIRED_RESET', 'The password reset has expired or was already used; request a new code');

export function generateRecoveryCode(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, '0');
}

/** Keyed HMAC of the code, bound to the user; a database copy does not allow guessing codes offline. */
export function recoveryCodeHash(userId: string, code: string): string {
  return createHmac('sha256', codeKey).update(`${userId}:${code}`).digest('hex');
}

export function isRecoveryEligible(user: AccountUser | null): user is AccountUser {
  return user !== null && user.role === 'PROFESSOR' && user.professor !== null && user.professor.isActive;
}

export function composeRecoveryEmail(code: string): { subject: string; text: string } {
  return {
    subject: 'CSE Research Hub password recovery code',
    text:
      `Your password recovery code is ${code}.\n\n` +
      `It expires in ${RECOVERY_CODE_TTL_MS / 60_000} minutes and can be used once. ` +
      'If you did not request it, ignore this email; your password stays unchanged.\n',
  };
}

/**
 * Issues and emails a code when the account is eligible and within its limits; otherwise does
 * nothing. Callers always give the same public response. `delivery` settles when sending ends
 * (failures are logged without the code); it is not awaited before responding.
 */
export async function requestPasswordRecovery(email: string, deps: RecoveryDeps): Promise<{ delivery: Promise<void> | null }> {
  if (!deps.mailer) throw unavailable();
  const client = deps.client ?? defaultClient;

  const user = await findAccountByEmail(email, client);
  if (!isRecoveryEligible(user)) return { delivery: null };

  const now = deps.now();
  const code = generateRecoveryCode();
  const cooldownCutoff = new Date(now.getTime() - RECOVERY_RESEND_COOLDOWN_MS);
  const hourCutoff = new Date(now.getTime() - HOUR_MS);

  // One statement: the cooldown and hourly checks and the new code are applied atomically, so
  // concurrent requests can never both issue (and send) a code. A new code replaces the old one,
  // which also invalidates reset tokens bound to it. The send counter and the attempt budget
  // restart only when the window has ended (an hour without sends); otherwise the attempts already
  // used carry over to the new code. No rolling hour contains more than RECOVERY_MAX_SENDS_PER_HOUR
  // sends. While the window is active and its attempt budget is used up, nothing is issued or
  // sent and nothing changes, so unusable codes are never sent and cannot extend the window.
  // (All SET expressions read the row's previous values.)
  const issued = await client.$executeRaw`
    UPDATE "users" SET
      "password_reset_code_hash" = ${recoveryCodeHash(user.id, code)},
      "password_reset_expires_at" = ${new Date(now.getTime() + RECOVERY_CODE_TTL_MS)},
      "password_reset_attempts" = CASE
        WHEN "password_reset_last_sent_at" IS NULL OR "password_reset_last_sent_at" <= ${hourCutoff} THEN 0
        ELSE "password_reset_attempts"
      END,
      "password_reset_send_count" = CASE
        WHEN "password_reset_last_sent_at" IS NULL OR "password_reset_last_sent_at" <= ${hourCutoff} THEN 1
        ELSE "password_reset_send_count" + 1
      END,
      "password_reset_last_sent_at" = ${now},
      "updated_at" = ${now}
    WHERE "id" = ${user.id}::uuid
      AND ("password_reset_last_sent_at" IS NULL OR "password_reset_last_sent_at" <= ${cooldownCutoff})
      AND ("password_reset_last_sent_at" IS NULL OR "password_reset_last_sent_at" <= ${hourCutoff}
           OR "password_reset_send_count" < ${RECOVERY_MAX_SENDS_PER_HOUR})
      AND ("password_reset_last_sent_at" IS NULL OR "password_reset_last_sent_at" <= ${hourCutoff}
           OR "password_reset_attempts" < ${RECOVERY_MAX_ATTEMPTS})`;
  if (issued !== 1) return { delivery: null };

  // Promise.resolve().then(): even a mailer that throws synchronously cannot change the response.
  const mailer = deps.mailer;
  const delivery = Promise.resolve()
    .then(() => mailer.send({ to: user.email, ...composeRecoveryEmail(code) }))
    .catch((error: unknown) => {
      console.error(`Password recovery email could not be sent for user ${user.id} (${describeMailError(error)})`);
    });
  return { delivery };
}

/**
 * Checks a code. Each check first reserves one attempt of the window's budget atomically, so at
 * most RECOVERY_MAX_ATTEMPTS comparisons can ever happen per window — across replacement codes and
 * concurrent requests. Every failure gives the same error.
 */
export async function verifyRecoveryCode(
  email: string,
  code: string,
  deps: RecoveryDeps,
): Promise<{ token: string; expiresAt: Date }> {
  if (!deps.mailer) throw unavailable();
  const client = deps.client ?? defaultClient;

  const user = await findAccountByEmail(email, client);
  if (!isRecoveryEligible(user)) throw invalidCode();

  const now = deps.now();
  const reserved = await client.user.updateMany({
    where: {
      id: user.id,
      passwordResetCodeHash: { not: null },
      passwordResetExpiresAt: { gt: now },
      passwordResetAttempts: { lt: RECOVERY_MAX_ATTEMPTS },
    },
    data: { passwordResetAttempts: { increment: 1 } },
  });
  if (reserved.count !== 1) throw invalidCode();

  const current = await client.user.findUnique({
    where: { id: user.id },
    select: { passwordResetCodeHash: true, passwordResetExpiresAt: true, passwordResetLastSentAt: true },
  });
  if (!current?.passwordResetCodeHash || !current.passwordResetExpiresAt || !current.passwordResetLastSentAt) throw invalidCode();
  if (!hexEqual(current.passwordResetCodeHash, recoveryCodeHash(user.id, code))) throw invalidCode();

  const expiresAt = new Date(Math.min(now.getTime() + RESET_TOKEN_TTL_MS, current.passwordResetExpiresAt.getTime()));
  const binding = recoveryCodeBinding(current.passwordResetCodeHash, current.passwordResetLastSentAt);
  return { token: signResetToken(user.id, binding, expiresAt), expiresAt };
}

/**
 * Sets the new password with a reset token. The code issuance it is bound to is consumed by a
 * single conditional UPDATE, so only one reset can succeed. The send limits are kept, the code
 * state cleared; the new password hash ends every existing session. The user is not signed in.
 */
export async function resetPasswordWithRecovery(token: string, newPassword: string, deps: RecoveryDeps): Promise<void> {
  if (!deps.mailer) throw unavailable();
  const client = deps.client ?? defaultClient;

  const claims = verifyResetToken(token, deps.now());
  if (!claims) throw invalidReset();
  const user = await client.user.findUnique({
    where: { id: claims.userId },
    include: { professor: { select: { id: true, name: true, isActive: true } } },
  });
  if (
    !isRecoveryEligible(user) ||
    !user.passwordResetCodeHash ||
    !user.passwordResetLastSentAt ||
    recoveryCodeBinding(user.passwordResetCodeHash, user.passwordResetLastSentAt) !== claims.codeBinding
  ) {
    throw invalidReset();
  }

  await assertNewPassword(newPassword, user.passwordHash);
  const { count } = await client.user.updateMany({
    where: { id: user.id, passwordResetCodeHash: user.passwordResetCodeHash, passwordResetLastSentAt: user.passwordResetLastSentAt },
    data: { passwordHash: await hashPassword(newPassword), mustChangePassword: false, temporaryPasswordExpiresAt: null, ...CLEARED_RECOVERY_CODE },
  });
  if (count !== 1) throw invalidReset();
}

function hexEqual(a: string, b: string): boolean {
  const x = Buffer.from(a, 'hex');
  const y = Buffer.from(b, 'hex');
  return x.length === y.length && x.length > 0 && timingSafeEqual(x, y);
}
