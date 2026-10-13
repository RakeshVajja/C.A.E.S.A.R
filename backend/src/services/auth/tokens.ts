import { createHash, createHmac, hkdfSync } from 'crypto';
import jwt from 'jsonwebtoken';
import { env } from '../../config/env';

/**
 * Signed tokens (Project_plan.md §15.2, §15.4): HS256 JWTs signed with JWT_SECRET.
 *
 * - Session token: 8 hours, carries a fingerprint of the user's password hash. Any password change
 *   (change, recovery, admin CLI reset) changes the fingerprint and so ends every existing session.
 * - Password-reset token: issued after a verified recovery code, bound to that code, short-lived,
 *   and limited to the recovery flow. Different audiences keep the two token kinds apart.
 */

const ISSUER = 'cse-research-hub';
const SESSION_AUDIENCE = 'session';
const RESET_AUDIENCE = 'password-reset';
const ALGORITHM = 'HS256';

export const SESSION_TTL_SECONDS = 8 * 60 * 60;

/** A separate key per purpose, derived from JWT_SECRET (HKDF-SHA256). */
export function derivedKey(purpose: string): Buffer {
  return Buffer.from(hkdfSync('sha256', env.jwtSecret, Buffer.alloc(0), `cse-research-hub:${purpose}`, 32));
}

const fingerprintKey = derivedKey('password-fingerprint');

export function passwordFingerprint(passwordHash: string): string {
  return createHmac('sha256', fingerprintKey).update(passwordHash).digest('base64url').slice(0, 22);
}

export function signSessionToken(userId: string, passwordHash: string): string {
  return jwt.sign({ pwf: passwordFingerprint(passwordHash) }, env.jwtSecret, {
    algorithm: ALGORITHM,
    expiresIn: SESSION_TTL_SECONDS,
    issuer: ISSUER,
    audience: SESSION_AUDIENCE,
    subject: userId,
  });
}

export function verifySessionToken(token: string, now = new Date()): { userId: string; fingerprint: string } | null {
  const claims = verify(token, SESSION_AUDIENCE, now);
  if (!claims || typeof claims.pwf !== 'string') return null;
  return { userId: claims.sub!, fingerprint: claims.pwf };
}

/**
 * Binds a reset token to one issuance of a recovery code (its hash and the time it was issued),
 * so a later code — even one with the same six digits — or consuming this one invalidates it.
 */
export function recoveryCodeBinding(codeHash: string, issuedAt: Date): string {
  return createHash('sha256').update(`${codeHash}|${issuedAt.toISOString()}`).digest('base64url');
}

export function signResetToken(userId: string, codeBinding: string, expiresAt: Date): string {
  return jwt.sign({ rcb: codeBinding, exp: Math.floor(expiresAt.getTime() / 1000) }, env.jwtSecret, {
    algorithm: ALGORITHM,
    issuer: ISSUER,
    audience: RESET_AUDIENCE,
    subject: userId,
  });
}

export function verifyResetToken(token: string, now = new Date()): { userId: string; codeBinding: string } | null {
  const claims = verify(token, RESET_AUDIENCE, now);
  if (!claims || typeof claims.rcb !== 'string') return null;
  return { userId: claims.sub!, codeBinding: claims.rcb };
}

function verify(token: string, audience: string, now: Date): jwt.JwtPayload | null {
  try {
    const claims = jwt.verify(token, env.jwtSecret, {
      algorithms: [ALGORITHM], // never "none" or an algorithm chosen by the token
      issuer: ISSUER,
      audience,
      clockTimestamp: Math.floor(now.getTime() / 1000),
    });
    if (typeof claims === 'string' || typeof claims.sub !== 'string' || typeof claims.exp !== 'number') return null;
    return claims;
  } catch {
    return null;
  }
}
