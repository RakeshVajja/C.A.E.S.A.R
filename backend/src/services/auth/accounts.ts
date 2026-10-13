import { Prisma, PrismaClient, UserRole } from '@prisma/client';
import { prisma as defaultClient } from '../../config/database';
import { HttpError } from '../../utils/httpError';
import { assertNewPassword, hashPassword, verifyAgainstDummy, verifyPassword } from './password';
import { passwordFingerprint, verifySessionToken } from './tokens';

/**
 * Account rules shared by login, sessions and recovery (Project_plan.md §15). The role and the
 * professor link always come from the database, never from the client or the token.
 */

const userWithProfessor = { professor: { select: { id: true, name: true, isActive: true } } } as const;
export type AccountUser = Prisma.UserGetPayload<{ include: typeof userWithProfessor }>;

/** What the API returns about the signed-in user (never the password hash or recovery state). */
export interface PublicUser {
  id: string;
  email: string;
  role: UserRole;
  mustChangePassword: boolean;
  professor: { id: string; name: string } | null;
}

/**
 * Clears a pending recovery code and its attempt state. Applied with every password change, so a
 * reset capability obtained earlier can no longer be used. Send limits (last sent, count) stay.
 */
export const CLEARED_RECOVERY_CODE = {
  passwordResetCodeHash: null,
  passwordResetExpiresAt: null,
  passwordResetAttempts: 0,
} as const;

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/** A professor account whose linked professor is deactivated cannot sign in or keep a session. */
export function isAccountActive(user: AccountUser): boolean {
  return !(user.role === 'PROFESSOR' && user.professor !== null && !user.professor.isActive);
}

export function publicUser(user: AccountUser): PublicUser {
  return {
    id: user.id,
    email: user.email,
    role: user.role,
    mustChangePassword: user.mustChangePassword,
    professor: user.professor ? { id: user.professor.id, name: user.professor.name } : null,
  };
}

export function findAccountByEmail(email: string, client: PrismaClient = defaultClient): Promise<AccountUser | null> {
  return client.user.findUnique({ where: { email: normalizeEmail(email) }, include: userWithProfessor });
}

/** The account for these credentials, or null (unknown email, wrong password or inactive account). */
export async function authenticate(
  email: string,
  password: string,
  client: PrismaClient = defaultClient,
): Promise<AccountUser | null> {
  const user = await findAccountByEmail(email, client);
  if (!user) return verifyAgainstDummy(password).then(() => null);
  if (!(await verifyPassword(password, user.passwordHash))) return null;
  return isAccountActive(user) ? user : null;
}

/** The account of a session token, or null when the token or the account is no longer valid. */
export async function loadSessionAccount(token: string, client: PrismaClient = defaultClient): Promise<AccountUser | null> {
  const claims = verifySessionToken(token);
  if (!claims) return null;
  const user = await client.user.findUnique({ where: { id: claims.userId }, include: userWithProfessor });
  if (!user || passwordFingerprint(user.passwordHash) !== claims.fingerprint) return null;
  return isAccountActive(user) ? user : null;
}

/** Changes the password of a signed-in user after checking the current one; clears the forced-change flag. */
export async function changePassword(
  userId: string,
  currentPassword: string,
  newPassword: string,
  client: PrismaClient = defaultClient,
): Promise<AccountUser> {
  const user = await client.user.findUniqueOrThrow({ where: { id: userId } });
  if (!(await verifyPassword(currentPassword, user.passwordHash))) {
    throw new HttpError(400, 'INVALID_CURRENT_PASSWORD', 'The current password is incorrect');
  }
  await assertNewPassword(newPassword, user.passwordHash);

  // Compare-and-set on the old hash: two concurrent changes cannot both succeed. A pending
  // recovery code (and any reset capability bound to it) ends with the change; send limits stay.
  const { count } = await client.user.updateMany({
    where: { id: userId, passwordHash: user.passwordHash },
    data: { passwordHash: await hashPassword(newPassword), mustChangePassword: false, ...CLEARED_RECOVERY_CODE },
  });
  if (count !== 1) throw new HttpError(400, 'INVALID_CURRENT_PASSWORD', 'The current password is incorrect');
  return client.user.findUniqueOrThrow({ where: { id: userId }, include: userWithProfessor });
}
