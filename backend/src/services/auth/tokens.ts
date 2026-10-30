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
const IDENTITY_PREVIEW_AUDIENCE = 'identity-preview';
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

/** How long an identity preview stays valid for saving (decision #68). */
export const IDENTITY_PREVIEW_TTL_SECONDS = 15 * 60;

export interface IdentityPreviewClaims {
  professorId: string;
  source: 'OPENALEX' | 'DBLP' | 'ORCID' | 'SCOPUS';
  /** The normalized identifier the administrator submitted (what is stored). */
  externalId: string;
  previewedAt: Date;
}

/**
 * Proof that an identity was previewed successfully, bound to the professor, source and normalized
 * identifier. Saving accepts only this token and makes no further external request.
 */
export function signIdentityPreviewToken(claims: Omit<IdentityPreviewClaims, 'previewedAt'>, now = new Date()): string {
  return jwt.sign(
    { pid: claims.professorId, src: claims.source, xid: claims.externalId, iat: Math.floor(now.getTime() / 1000) },
    env.jwtSecret,
    { algorithm: ALGORITHM, issuer: ISSUER, audience: IDENTITY_PREVIEW_AUDIENCE, expiresIn: IDENTITY_PREVIEW_TTL_SECONDS },
  );
}

export function verifyIdentityPreviewToken(token: string, now = new Date()): IdentityPreviewClaims | null {
  try {
    const claims = jwt.verify(token, env.jwtSecret, {
      algorithms: [ALGORITHM],
      issuer: ISSUER,
      audience: IDENTITY_PREVIEW_AUDIENCE,
      clockTimestamp: Math.floor(now.getTime() / 1000),
    });
    if (typeof claims === 'string' || typeof claims.exp !== 'number' || typeof claims.iat !== 'number') return null;
    const { pid, src, xid } = claims as Record<string, unknown>;
    if (typeof pid !== 'string' || typeof xid !== 'string' || (src !== 'OPENALEX' && src !== 'DBLP' && src !== 'ORCID' && src !== 'SCOPUS')) return null;
    return { professorId: pid, source: src, externalId: xid, previewedAt: new Date(claims.iat * 1000) };
  } catch {
    return null;
  }
}
