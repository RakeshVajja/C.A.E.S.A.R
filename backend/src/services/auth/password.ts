import bcrypt from 'bcryptjs';
import { env } from '../../config/env';
import { HttpError } from '../../utils/httpError';

/**
 * Password policy and hashing (Project_plan.md §15.2). The single implementation used by login,
 * password changes, professor recovery and the admin command-line utility. Passwords are never
 * trimmed or otherwise normalized.
 */

export const PASSWORD_MIN_CHARACTERS = 10;
/** bcrypt only uses the first 72 bytes, so longer passwords are refused rather than truncated. */
export const PASSWORD_MAX_BYTES = 72;

export const PASSWORD_HASH_COST = 12;
export const TEST_PASSWORD_HASH_COST = 4;

/**
 * The bcrypt cost (decision #65): 12, except 4 when NODE_ENV is "test" AND the database the
 * application connects to (DATABASE_URL, as passed to Prisma) is a *_test database — so a
 * mistaken NODE_ENV=test can never store weak hashes in a real database. Anything that cannot
 * be verified (unparsable URL, other scheme, no or unusual database name) gets cost 12.
 */
export function passwordHashCost(nodeEnv: string, databaseUrl: string): number {
  if (nodeEnv !== 'test') return PASSWORD_HASH_COST;
  const name = databaseNameFromUrl(databaseUrl);
  return name !== null && name.endsWith('_test') ? TEST_PASSWORD_HASH_COST : PASSWORD_HASH_COST;
}

/** The database name (URL path) of a PostgreSQL connection URL, or null if it cannot be determined. */
function databaseNameFromUrl(databaseUrl: string): string | null {
  try {
    const url = new URL(databaseUrl);
    if (url.protocol !== 'postgresql:' && url.protocol !== 'postgres:') return null;
    const name = decodeURIComponent(url.pathname.replace(/^\//, ''));
    return name.length > 0 && !name.includes('/') ? name : null;
  } catch {
    return null;
  }
}

const HASH_ROUNDS = passwordHashCost(env.nodeEnv, env.databaseUrl);

/** The policy violation for a new password, or null when it is acceptable. */
export function passwordPolicyProblem(password: string): string | null {
  if ([...password].length < PASSWORD_MIN_CHARACTERS) {
    return `Password must be at least ${PASSWORD_MIN_CHARACTERS} characters long`;
  }
  if (Buffer.byteLength(password, 'utf8') > PASSWORD_MAX_BYTES) {
    return `Password must be at most ${PASSWORD_MAX_BYTES} bytes long (UTF-8)`;
  }
  return null;
}

export function assertPasswordPolicy(password: string): void {
  const problem = passwordPolicyProblem(password);
  if (problem) throw new HttpError(400, 'INVALID_PASSWORD', problem);
}

/** Policy plus "not the current password" (checked against the stored hash). */
export async function assertNewPassword(password: string, currentHash: string): Promise<void> {
  assertPasswordPolicy(password);
  if (await verifyPassword(password, currentHash)) {
    throw new HttpError(400, 'PASSWORD_REUSED', 'The new password must differ from the current password');
  }
}

export function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, HASH_ROUNDS);
}

export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  // The comparison always runs, so an over-long password takes as long as any other attempt
  // (an early return would reveal that the account exists). Such a password is then rejected:
  // bcrypt truncates it, and the policy never allows it to be stored.
  const matches = await bcrypt.compare(password, hash);
  return matches && Buffer.byteLength(password, 'utf8') <= PASSWORD_MAX_BYTES;
}

let dummyHash: Promise<string> | null = null;

/** Spends the same bcrypt work as a real comparison, so unknown accounts take as long as known ones. */
export async function verifyAgainstDummy(password: string): Promise<false> {
  dummyHash ??= bcrypt.hash('dummy-password-for-equal-timing', HASH_ROUNDS);
  await bcrypt.compare(password, await dummyHash);
  return false;
}
