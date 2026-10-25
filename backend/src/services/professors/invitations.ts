import { PrismaClient } from '@prisma/client';
import { env } from '../../config/env';
import { prisma as defaultClient } from '../../config/database';
import { describeMailError, Mailer } from '../email/mailer';
import { generateTemporaryPassword, hashPassword } from '../auth/password';

/**
 * Emailed sign-in details for professor accounts (Project_plan.md §15.2; decision #102, superseding
 * the hand-over part of #66). A temporary password is generated (CSPRNG), only its bcrypt hash is
 * stored together with its expiry, and the password itself is sent to the professor through the
 * configured SMTP mailer. It exists in memory only for the request that sends it: it is never
 * returned by the API, logged or stored, so the administrator can neither see nor retrieve it.
 *
 * The administrator sees only the delivery status:
 *   SENT            the email was accepted by the mail server and its password is still the current one
 *   FAILED          sending failed, or the password was superseded (another issue, or the professor
 *                   already chose a password) before the attempt finished — never reported as sent
 *   NOT_CONFIGURED  no SMTP configuration; the account is kept and can be sent later with a resend
 *
 * Issuance is serialized per professor within the process (single-instance assumption, like the
 * synchronization guard), and every hash/expiry change is one conditional UPDATE, so concurrent
 * resends cannot interleave and a superseded password is never reported as sent.
 */

export type InvitationStatus = 'SENT' | 'FAILED' | 'NOT_CONFIGURED';

/** How long an emailed temporary password is accepted (decision #102). */
export const TEMPORARY_PASSWORD_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export interface InvitationDeps {
  /** null when SMTP is not configured. */
  mailer: Mailer | null;
  now: () => Date;
  client?: PrismaClient;
}

export interface IssuedPassword {
  /** The plain password: only for the email of this request. */
  password: string;
  passwordHash: string;
  expiresAt: Date;
}

export async function issueTemporaryPassword(now: Date): Promise<IssuedPassword> {
  const password = generateTemporaryPassword();
  return { password, passwordHash: await hashPassword(password), expiresAt: new Date(now.getTime() + TEMPORARY_PASSWORD_TTL_MS) };
}

const expiryFormat = new Intl.DateTimeFormat('en-IN', {
  day: 'numeric',
  month: 'long',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
  timeZone: 'Asia/Kolkata',
});

export function composeInvitationEmail(email: string, password: string, expiresAt: Date): { subject: string; text: string } {
  return {
    subject: 'Your CSE Research Hub sign-in details',
    text:
      'An account has been created for you on CSE Research Hub, the publication register of the Department of ' +
      'Computer Science and Engineering, IIT (ISM) Dhanbad.\n\n' +
      `Sign in at: ${env.corsOrigin}/login\n` +
      `Email: ${email}\n` +
      `Temporary password: ${password}\n\n` +
      `The temporary password works until ${expiryFormat.format(expiresAt)} IST and must be changed when you first sign in. ` +
      'If it has expired, ask the department administrator to send new sign-in details.\n\n' +
      'If you did not expect this email, you can ignore it.\n',
  };
}

const queues = new Map<string, Promise<unknown>>();

/** Runs `operation` after any earlier invitation operation for the same professor (in this process). */
export async function serializeInvitation<T>(professorId: string, operation: () => Promise<T>): Promise<T> {
  const previous = queues.get(professorId) ?? Promise.resolve();
  const current = previous.then(operation, operation);
  const settled = current.then(
    () => undefined,
    () => undefined,
  );
  queues.set(professorId, settled);
  try {
    return await current;
  } finally {
    if (queues.get(professorId) === settled) queues.delete(professorId);
  }
}

/**
 * Emails an issued password and reports the status. SENT only when the mail server accepted it and
 * the stored hash is still this password's (not superseded meanwhile). Failures log the user and an
 * SMTP error code — never the password, the message or the server's text.
 */
export async function deliverTemporaryPassword(
  user: { id: string; email: string },
  issued: IssuedPassword,
  deps: InvitationDeps,
): Promise<InvitationStatus> {
  if (!deps.mailer) return 'NOT_CONFIGURED';
  try {
    await deps.mailer.send({ to: user.email, ...composeInvitationEmail(user.email, issued.password, issued.expiresAt) });
  } catch (error) {
    console.error(`Sign-in email could not be sent for user ${user.id} (${describeMailError(error)})`);
    return 'FAILED';
  }
  const client = deps.client ?? defaultClient;
  const current = await client.user.findUnique({ where: { id: user.id }, select: { passwordHash: true } });
  if (current?.passwordHash !== issued.passwordHash) {
    console.warn(`Sign-in email for user ${user.id} was superseded before it finished; reported as not sent`);
    return 'FAILED';
  }
  return 'SENT';
}
