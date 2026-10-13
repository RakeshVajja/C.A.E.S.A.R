import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { describe, expect, it, vi } from 'vitest';
import { env } from '../../src/config/env';
import { RateLimiter } from '../../src/middleware/rateLimit';
import { generateRecoveryCode, recoveryCodeHash } from '../../src/services/auth/passwordRecovery';
import { generateTemporaryPassword, hashPassword, passwordHashCost, passwordPolicyProblem, verifyPassword } from '../../src/services/auth/password';
import {
  passwordFingerprint,
  signIdentityPreviewToken,
  verifyIdentityPreviewToken,
  recoveryCodeBinding,
  signResetToken,
  signSessionToken,
  verifyResetToken,
  verifySessionToken,
} from '../../src/services/auth/tokens';

describe('password policy and hashing', () => {
  it('requires at least 10 characters (counted as characters, not bytes)', () => {
    expect(passwordPolicyProblem('a'.repeat(9))).toMatch(/at least 10 characters/);
    expect(passwordPolicyProblem('a'.repeat(10))).toBeNull();
    expect(passwordPolicyProblem('😀'.repeat(9))).toMatch(/at least 10 characters/); // 36 bytes, 9 characters
  });

  it('allows at most 72 UTF-8 bytes (bcrypt would silently truncate longer passwords)', () => {
    expect(passwordPolicyProblem('a'.repeat(72))).toBeNull();
    expect(passwordPolicyProblem('a'.repeat(73))).toMatch(/at most 72 bytes/);
    expect(passwordPolicyProblem('é'.repeat(36))).toBeNull(); // 72 bytes
    expect(passwordPolicyProblem('é'.repeat(37))).toMatch(/at most 72 bytes/); // 37 characters, 74 bytes
    expect(passwordPolicyProblem('😀'.repeat(19))).toMatch(/at most 72 bytes/); // 19 characters, 76 bytes
  });

  it('hashes with bcrypt and never trims passwords', async () => {
    const hash = await hashPassword(' padded password ');
    expect(hash).toMatch(/^\$2[aby]\$/);
    expect(await verifyPassword(' padded password ', hash)).toBe(true);
    expect(await verifyPassword('padded password', hash)).toBe(false);
  });

  it('never accepts a password longer than 72 bytes, even if its first 72 bytes match', async () => {
    const base = 'b'.repeat(72);
    const hash = await hashPassword(base);
    expect(await verifyPassword(`${base}extra`, hash)).toBe(false);
  });

  it('still runs exactly one bcrypt comparison for an over-long password (no early return, F1)', async () => {
    const hash = await hashPassword('a known password');
    const compare = vi.spyOn(bcrypt, 'compare');
    try {
      expect(await verifyPassword('x'.repeat(80), hash)).toBe(false);
      expect(compare).toHaveBeenCalledTimes(1);
      expect(compare).toHaveBeenCalledWith('x'.repeat(80), hash);
    } finally {
      compare.mockRestore();
    }
  });
});

describe('bcrypt cost guard (decision #65)', () => {
  const TEST_DB = 'postgresql://user@localhost:5432/cse_research_hub_test?schema=public';
  const DEV_DB = 'postgresql://user@localhost:5432/cse_research_hub?schema=public';

  it('uses the low test cost only for NODE_ENV=test with a verified *_test database', () => {
    expect(passwordHashCost('test', TEST_DB)).toBe(4);
    expect(passwordHashCost('test', 'postgres://localhost/a%5Ftest')).toBe(4); // percent-encoded name a_test
  });

  it('NODE_ENV=test alone is not enough: any other database gets cost 12', () => {
    for (const url of [
      DEV_DB,
      'postgresql://user@localhost:5432/cse_research_hub?schema=cse_research_hub_test', // "_test" only in a parameter
      'postgresql://cse_test:pw_test@db_test.example:5432/cse_research_hub', // "_test" only in user, password, host
      'postgresql://localhost:5432/cse_research_hub_test_backup',
      'postgresql://localhost:5432/', // no database name
      'mysql://localhost:3306/cse_research_hub_test', // not PostgreSQL
      'not a url _test',
      '',
    ]) {
      expect(passwordHashCost('test', url), url).toBe(12);
    }
  });

  it('development and production always use cost 12, whatever the database', () => {
    for (const nodeEnv of ['development', 'production']) {
      expect(passwordHashCost(nodeEnv, TEST_DB)).toBe(12);
      expect(passwordHashCost(nodeEnv, DEV_DB)).toBe(12);
    }
  });

  it('this test run (NODE_ENV=test on the *_test database) hashes with cost 4', async () => {
    expect(await hashPassword('a password for cost check')).toMatch(/^\$2[aby]\$04\$/);
  });
});

describe('session and reset tokens', () => {
  const userId = '00000000-0000-4000-8000-000000000001';

  it('round-trips a session token bound to the password fingerprint', () => {
    const token = signSessionToken(userId, '$2b$04$hash-one');
    expect(verifySessionToken(token)).toEqual({ userId, fingerprint: passwordFingerprint('$2b$04$hash-one') });
    expect(passwordFingerprint('$2b$04$hash-one')).not.toBe(passwordFingerprint('$2b$04$hash-two'));
    expect(token).not.toContain('hash-one');
  });

  it('expires sessions after 8 hours', () => {
    const issued = new Date();
    const token = signSessionToken(userId, 'h');
    expect(verifySessionToken(token, new Date(issued.getTime() + 8 * 3600_000 - 60_000))).not.toBeNull();
    expect(verifySessionToken(token, new Date(issued.getTime() + 8 * 3600_000 + 60_000))).toBeNull();
  });

  it('rejects unsigned ("none"), wrongly signed, tampered or differently scoped tokens', () => {
    const claims = { pwf: passwordFingerprint('h'), sub: userId, iss: 'cse-research-hub', aud: 'session' };
    const none = jwt.sign(claims, '', { algorithm: 'none', expiresIn: 60 });
    const wrongSecret = jwt.sign(claims, 'another-secret-that-is-long-enough-123', { algorithm: 'HS256', expiresIn: 60 });
    const hs512 = jwt.sign(claims, env.jwtSecret, { algorithm: 'HS512', expiresIn: 60 });
    const valid = signSessionToken(userId, 'h');
    const [head, , sig] = valid.split('.');
    const tampered = `${head}.${Buffer.from(JSON.stringify({ ...claims, sub: 'someone-else', exp: 9999999999 })).toString('base64url')}.${sig}`;

    for (const token of [none, wrongSecret, hs512, tampered, 'not-a-jwt', '']) expect(verifySessionToken(token)).toBeNull();
  });

  it('keeps session and reset tokens apart (audience)', () => {
    const reset = signResetToken(userId, 'binding', new Date(Date.now() + 60_000));
    const session = signSessionToken(userId, 'h');
    expect(verifyResetToken(reset)).toEqual({ userId, codeBinding: 'binding' });
    expect(verifySessionToken(reset)).toBeNull();
    expect(verifyResetToken(session)).toBeNull();
  });
});

describe('recovery codes', () => {
  it('are 6 digits from the secure generator, and only a keyed HMAC is derived for storage', () => {
    const codes = Array.from({ length: 200 }, generateRecoveryCode);
    expect(codes.every((c) => /^\d{6}$/.test(c))).toBe(true);
    expect(new Set(codes).size).toBeGreaterThan(190);

    const hash = recoveryCodeHash('user-1', '123456');
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).not.toContain('123456');
    expect(recoveryCodeHash('user-2', '123456')).not.toBe(hash); // bound to the user
    // The binding covers the issuance, not only the code: the same code issued later binds differently.
    const first = recoveryCodeBinding(hash, new Date('2026-10-13T10:00:00.000Z'));
    expect(first).not.toBe(hash);
    expect(recoveryCodeBinding(hash, new Date('2026-10-13T10:01:01.000Z'))).not.toBe(first);
    expect(recoveryCodeBinding(hash, new Date('2026-10-13T10:00:00.000Z'))).toBe(first);
  });
});

describe('temporary passwords (decision #66)', () => {
  it('are 4 groups of 5 unambiguous characters from the secure generator and satisfy the policy', () => {
    const values = Array.from({ length: 100 }, generateTemporaryPassword);
    for (const value of values) {
      expect(value).toMatch(/^[A-HJ-NP-Z2-9]{5}(-[A-HJ-NP-Z2-9]{5}){3}$/);
      expect(passwordPolicyProblem(value)).toBeNull();
    }
    expect(new Set(values).size).toBe(100);
  });
});

describe('identity preview tokens (decision #68)', () => {
  const claims = { professorId: '00000000-0000-4000-8000-000000000001', source: 'DBLP' as const, externalId: 'v/MosheYVardi' };

  it('round-trip the professor, source, normalized identifier and preview time; expire after 15 minutes', () => {
    const at = new Date('2026-10-14T10:00:00.000Z');
    const token = signIdentityPreviewToken(claims, at);
    expect(verifyIdentityPreviewToken(token, new Date(at.getTime() + 14 * 60_000))).toEqual({ ...claims, previewedAt: at });
    expect(verifyIdentityPreviewToken(token, new Date(at.getTime() + 15 * 60_000 + 1_000))).toBeNull();
  });

  it('are not interchangeable with session or reset tokens', () => {
    const token = signIdentityPreviewToken(claims);
    expect(verifySessionToken(token)).toBeNull();
    expect(verifyResetToken(token)).toBeNull();
    expect(verifyIdentityPreviewToken(signSessionToken(claims.professorId, 'h'))).toBeNull();
    expect(verifyIdentityPreviewToken(jwt.sign({ pid: claims.professorId, src: 'DBLP', xid: 'x' }, 'another-secret-that-is-long-enough-123', { algorithm: 'HS256', audience: 'identity-preview', issuer: 'cse-research-hub', expiresIn: 60 }))).toBeNull();
  });
});

describe('RateLimiter', () => {
  it('allows up to max requests per key and window, then reports the wait', () => {
    let now = 0;
    const limiter = new RateLimiter(() => now);
    const rule = { windowMs: 60_000, max: 3 };
    expect([1, 2, 3].map(() => limiter.hit('login:1.1.1.1', rule).allowed)).toEqual([true, true, true]);
    now = 15_000;
    expect(limiter.hit('login:1.1.1.1', rule)).toEqual({ allowed: false, retryAfterMs: 45_000 });
  });

  it('keeps independent counters per key and restarts after the window', () => {
    let now = 0;
    const limiter = new RateLimiter(() => now);
    const rule = { windowMs: 60_000, max: 1 };
    expect(limiter.hit('login:1.1.1.1', rule).allowed).toBe(true);
    expect(limiter.hit('login:1.1.1.1', rule).allowed).toBe(false);
    expect(limiter.hit('login:2.2.2.2', rule).allowed).toBe(true);
    expect(limiter.hit('verify:1.1.1.1', rule).allowed).toBe(true);
    now = 60_000;
    expect(limiter.hit('login:1.1.1.1', rule).allowed).toBe(true);
  });
});
