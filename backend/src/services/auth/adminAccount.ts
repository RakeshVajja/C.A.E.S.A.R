import { Prisma, PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { HttpError } from '../../utils/httpError';
import { CLEARED_RECOVERY_CODE, normalizeEmail } from './accounts';
import { assertNewPassword, assertPasswordPolicy, hashPassword } from './password';

/**
 * The administrator account (Project_plan.md §15.2, §15.4, decision #56): created and recovered
 * only through the backend command-line utility (scripts/admin-account.ts), never over HTTP. Uses
 * the same password policy and hashing as the API. There is exactly one administrator.
 */

export class AdminAccountError extends Error {
  /** Exit code for the command line: 1 = refused/failed, 2 = cancelled. */
  constructor(
    message: string,
    public readonly exitCode = 1,
  ) {
    super(message);
    this.name = 'AdminAccountError';
  }
}

export interface AdminSummary {
  id: string;
  email: string;
}

const emailSchema = z.string().trim().toLowerCase().max(254).pipe(z.email());

export function parseAdminEmail(value: string): string {
  const result = emailSchema.safeParse(value);
  if (!result.success) throw new AdminAccountError('The admin email address is not valid');
  return result.data;
}

/** The one administrator; refuses when there is none or more than one. */
export async function findSingleAdmin(client: PrismaClient): Promise<AdminSummary> {
  const admins = await client.user.findMany({ where: { role: 'ADMIN' }, select: { id: true, email: true } });
  if (admins.length === 0) throw new AdminAccountError('No admin account exists; create one with the "create" command');
  if (admins.length > 1) {
    throw new AdminAccountError(`${admins.length} admin accounts exist, but exactly one is expected; refusing to change any`);
  }
  return admins[0];
}

/** Rejects a password that violates the policy, with the policy message. */
export function checkPasswordPolicy(password: string): void {
  try {
    assertPasswordPolicy(password);
  } catch (error) {
    if (error instanceof HttpError) throw new AdminAccountError(error.message);
    throw error;
  }
}

/**
 * Creates the administrator. Idempotent: if this email already is the administrator, nothing
 * changes ('exists'). Refuses a second administrator or an email used by another account.
 */
export async function createAdmin(client: PrismaClient, emailInput: string, password: string): Promise<'created' | 'exists'> {
  const email = parseAdminEmail(emailInput);
  checkPasswordPolicy(password);
  const passwordHash = await hashPassword(password);

  try {
    // Serializable: two concurrent creations cannot both see "no administrator yet".
    return await client.$transaction(
      async (tx) => {
        const admins = await tx.user.findMany({ where: { role: 'ADMIN' }, select: { email: true } });
        if (admins.length > 0) {
          if (admins.length === 1 && admins[0].email === email) return 'exists' as const;
          throw new AdminAccountError('An admin account already exists; use the "reset-password" command instead');
        }
        if (await tx.user.findUnique({ where: { email }, select: { id: true } })) {
          throw new AdminAccountError('This email address already belongs to a non-admin account');
        }
        await tx.user.create({ data: { email, passwordHash, role: 'ADMIN', mustChangePassword: false } });
        return 'created' as const;
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && (error.code === 'P2034' || error.code === 'P2002')) {
      throw new AdminAccountError('Another change to the admin account happened at the same time; run the command again');
    }
    throw error;
  }
}

/**
 * Sets a new administrator password (policy and "not the current password" apply). The new hash
 * ends every existing admin session (session tokens carry a password fingerprint).
 */
export async function resetAdminPassword(client: PrismaClient, admin: AdminSummary, password: string): Promise<void> {
  checkPasswordPolicy(password);
  const current = await client.user.findUnique({ where: { id: admin.id }, select: { passwordHash: true, role: true } });
  if (!current || current.role !== 'ADMIN') throw new AdminAccountError('The admin account changed; run the command again');
  try {
    await assertNewPassword(password, current.passwordHash);
  } catch (error) {
    if (error instanceof HttpError) throw new AdminAccountError(error.message);
    throw error;
  }

  const { count } = await client.user.updateMany({
    where: { id: admin.id, role: 'ADMIN', passwordHash: current.passwordHash },
    // Any recovery state on the row is cleared too (administrators cannot use email recovery).
    data: { passwordHash: await hashPassword(password), mustChangePassword: false, ...CLEARED_RECOVERY_CODE },
  });
  if (count !== 1) throw new AdminAccountError('The admin account changed; run the command again');
}

/** Sanity check used by the confirmation step. */
export function emailsMatch(expected: string, typed: string): boolean {
  return normalizeEmail(expected) === normalizeEmail(typed);
}
