import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../../src/app';
import { prisma } from '../../src/config/database';
import { env } from '../../src/config/env';
import { passwordFingerprint, signResetToken } from '../../src/services/auth/tokens';
import { resetDatabase } from '../helpers/database';
import { cookiePair, createUser, PASSWORD, setCookie } from './helpers';

/* Login, logout, current user, change password and route protection (Project_plan.md §15). */

beforeEach(async () => {
  await resetDatabase();
});

afterAll(async () => {
  await resetDatabase();
  await prisma.$disconnect();
});

const app = () => createApp({ mailer: null });
const login = (email: string, password = PASSWORD, server = app()) =>
  request(server).post('/api/auth/login').send({ email, password });

describe('POST /api/auth/login', () => {
  it('signs in with an HttpOnly, SameSite=Lax session cookie and returns only public fields', async () => {
    const user = await createUser({ email: 'prof@example.org', professor: 'active' });
    const res = await login('prof@example.org');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      user: {
        id: user.id,
        email: 'prof@example.org',
        role: 'PROFESSOR',
        mustChangePassword: false,
        professor: { id: expect.any(String), name: 'Prof prof@example.org' },
      },
    });
    const cookie = setCookie(res, 'cse_session')!;
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/SameSite=Lax/);
    expect(cookie).toMatch(/Path=\//);
    expect(cookie).toMatch(/Max-Age=28800/);
    expect(cookie).not.toMatch(/Secure/); // only in production
    expect(JSON.stringify(res.body)).not.toMatch(/passwordHash|\$2[aby]\$|eyJ/); // no hash, no token
  });

  it('sets the Secure attribute in production', async () => {
    await createUser({ email: 'prof@example.org' });
    const original = env.nodeEnv;
    env.nodeEnv = 'production';
    try {
      expect(setCookie(await login('prof@example.org'), 'cse_session')).toMatch(/Secure/);
    } finally {
      env.nodeEnv = original;
    }
  });

  it('normalizes the email (trim, lowercase) but never the password', async () => {
    await createUser({ email: 'prof@example.org', password: ' spaced password ' });
    expect((await login('  PROF@Example.ORG ', ' spaced password ')).status).toBe(200);
    expect((await login('prof@example.org', 'spaced password')).status).toBe(401);
  });

  it('gives the same answer for an unknown email and a wrong password', async () => {
    await createUser({ email: 'prof@example.org' });
    const unknown = await login('nobody@example.org');
    const wrong = await login('prof@example.org', 'wrong password!');
    for (const res of [unknown, wrong]) {
      expect(res.status).toBe(401);
      expect(res.body).toEqual({ error: { code: 'INVALID_CREDENTIALS', message: 'Invalid email or password' } });
      expect(setCookie(res, 'cse_session')).toBeUndefined();
    }
  });

  it('does the same bcrypt work for an over-long password whether or not the account exists (F1)', async () => {
    await createUser({ email: 'prof@example.org' });
    const server = app();
    await login('warm-up@example.org', 'warm-up password', server); // prepares the dummy hash
    const compare = vi.spyOn(bcrypt, 'compare');
    try {
      const overlong = 'x'.repeat(80);
      const existing = await login('prof@example.org', overlong, server);
      expect(compare).toHaveBeenCalledTimes(1);
      const unknown = await login('nobody@example.org', overlong, server);
      expect(compare).toHaveBeenCalledTimes(2);
      for (const res of [existing, unknown]) {
        expect(res.status).toBe(401);
        expect(res.body.error.code).toBe('INVALID_CREDENTIALS');
      }
    } finally {
      compare.mockRestore();
    }
  });

  it('refuses an inactive linked professor with the generic answer; allows an unlinked professor account', async () => {
    await createUser({ email: 'inactive@example.org', professor: 'inactive' });
    await createUser({ email: 'unlinked@example.org' });
    expect((await login('inactive@example.org')).body.error.code).toBe('INVALID_CREDENTIALS');
    const unlinked = await login('unlinked@example.org');
    expect(unlinked.status).toBe(200);
    expect(unlinked.body.user.professor).toBeNull();
  });

  it('validates the body without echoing values; form posts are not accepted', async () => {
    const bad = await request(app()).post('/api/auth/login').send({ email: 'not-an-email', password: 'secret-value-123' });
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe('VALIDATION_ERROR');
    expect(JSON.stringify(bad.body)).not.toContain('secret-value-123');

    const form = await request(app()).post('/api/auth/login').type('form').send({ email: 'prof@example.org', password: PASSWORD });
    expect(form.status).toBe(400);
  });
});

describe('sessions: GET /api/auth/me and logout', () => {
  it('returns the current user for a valid session and 401 without one', async () => {
    await createUser({ email: 'admin@example.org', role: 'ADMIN' });
    const server = app();
    const cookie = cookiePair(await login('admin@example.org', PASSWORD, server), 'cse_session');

    const me = await request(server).get('/api/auth/me').set('Cookie', cookie);
    expect(me.status).toBe(200);
    expect(me.body.user).toMatchObject({ email: 'admin@example.org', role: 'ADMIN', professor: null });

    const anonymous = await request(server).get('/api/auth/me');
    expect(anonymous.status).toBe(401);
    expect(anonymous.body.error.code).toBe('UNAUTHENTICATED');
  });

  it('rejects invalid, expired, foreign-key and reset tokens, and clears the bad cookie', async () => {
    const user = await createUser({ email: 'admin@example.org', role: 'ADMIN' });
    const claims = { pwf: passwordFingerprint(user.passwordHash), iss: 'cse-research-hub', aud: 'session', sub: user.id };
    const tokens = [
      'garbage',
      jwt.sign({ ...claims, exp: Math.floor(Date.now() / 1000) - 10 }, env.jwtSecret, { algorithm: 'HS256' }), // expired
      jwt.sign(claims, 'some-other-secret-that-is-long-enough', { algorithm: 'HS256', expiresIn: 60 }),
      jwt.sign(claims, '', { algorithm: 'none', expiresIn: 60 }),
      signResetToken(user.id, 'binding', new Date(Date.now() + 60_000)), // a reset capability is not a session
    ];
    for (const token of tokens) {
      const res = await request(app()).get('/api/auth/me').set('Cookie', `cse_session=${token}`);
      expect(res.status).toBe(401);
      expect(setCookie(res, 'cse_session')).toMatch(/Expires=Thu, 01 Jan 1970/);
    }
  });

  it('ends the session when the user is deleted or the professor is deactivated', async () => {
    const deleted = await createUser({ email: 'deleted@example.org' });
    const deactivated = await createUser({ email: 'prof@example.org', professor: 'active' });
    const server = app();
    const deletedCookie = cookiePair(await login('deleted@example.org', PASSWORD, server), 'cse_session');
    const profCookie = cookiePair(await login('prof@example.org', PASSWORD, server), 'cse_session');

    await prisma.user.delete({ where: { id: deleted.id } });
    await prisma.professor.updateMany({ where: { userId: deactivated.id }, data: { isActive: false } });

    expect((await request(server).get('/api/auth/me').set('Cookie', deletedCookie)).status).toBe(401);
    expect((await request(server).get('/api/auth/me').set('Cookie', profCookie)).status).toBe(401);
  });

  it('logout clears the cookie with matching attributes, with or without a session', async () => {
    await createUser({ email: 'prof@example.org' });
    const server = app();
    const cookie = cookiePair(await login('prof@example.org', PASSWORD, server), 'cse_session');
    for (const req of [request(server).post('/api/auth/logout').set('Cookie', cookie), request(server).post('/api/auth/logout')]) {
      const res = await req;
      expect(res.status).toBe(204);
      const cleared = setCookie(res, 'cse_session')!;
      expect(cleared).toMatch(/Expires=Thu, 01 Jan 1970/);
      expect(cleared).toMatch(/Path=\//);
      expect(cleared).toMatch(/HttpOnly/);
      expect(cleared).toMatch(/SameSite=Lax/);
    }
  });
});

describe('route protection', () => {
  it('requires a session for /api/me and /api/admin', async () => {
    for (const path of ['/api/me/anything', '/api/admin/anything']) {
      const res = await request(app()).get(path);
      expect(res.status).toBe(401);
    }
  });

  it('enforces the ADMIN role using the role currently stored in the database', async () => {
    const user = await createUser({ email: 'prof@example.org' });
    const server = app();
    const cookie = cookiePair(await login('prof@example.org', PASSWORD, server), 'cse_session');

    const forbidden = await request(server).get('/api/admin/anything').set('Cookie', cookie);
    expect(forbidden.status).toBe(403);
    expect(forbidden.body.error.code).toBe('FORBIDDEN');
    expect((await request(server).get('/api/me/anything').set('Cookie', cookie)).status).toBe(404); // passes the checks

    // The token carries no role: a role change in the database applies to the existing session.
    await prisma.user.update({ where: { id: user.id }, data: { role: 'ADMIN' } });
    expect((await request(server).get('/api/admin/anything').set('Cookie', cookie)).status).toBe(404);
  });

  it('limits a user with a temporary password to me, change-password and logout', async () => {
    await createUser({ email: 'admin@example.org', role: 'ADMIN', mustChangePassword: true });
    const server = app();
    const res = await login('admin@example.org', PASSWORD, server);
    expect(res.body.user.mustChangePassword).toBe(true);
    const cookie = cookiePair(res, 'cse_session');

    for (const path of ['/api/admin/anything', '/api/me/anything']) {
      const blocked = await request(server).get(path).set('Cookie', cookie);
      expect(blocked.status).toBe(403);
      expect(blocked.body.error.code).toBe('PASSWORD_CHANGE_REQUIRED');
    }
    expect((await request(server).get('/api/auth/me').set('Cookie', cookie)).status).toBe(200);

    const changed = await request(server)
      .post('/api/auth/change-password')
      .set('Cookie', cookie)
      .send({ currentPassword: PASSWORD, newPassword: 'a brand new password' });
    expect(changed.status).toBe(200);
    expect(changed.body.user.mustChangePassword).toBe(false);
    const newCookie = cookiePair(changed, 'cse_session');
    expect((await request(server).get('/api/admin/anything').set('Cookie', newCookie)).status).toBe(404);
  });
});

describe('POST /api/auth/change-password', () => {
  async function signedIn() {
    await createUser({ email: 'prof@example.org', professor: 'active' });
    const server = app();
    return { server, cookie: cookiePair(await login('prof@example.org', PASSWORD, server), 'cse_session') };
  }
  const change = (server: ReturnType<typeof app>, cookie: string, currentPassword: string, newPassword: string) =>
    request(server).post('/api/auth/change-password').set('Cookie', cookie).send({ currentPassword, newPassword });

  it('requires a session', async () => {
    const res = await request(app()).post('/api/auth/change-password').send({ currentPassword: PASSWORD, newPassword: 'x'.repeat(12) });
    expect(res.status).toBe(401);
  });

  it('checks the current password and the policy (length, UTF-8 bytes, reuse)', async () => {
    const { server, cookie } = await signedIn();
    expect((await change(server, cookie, 'wrong password', 'a valid new password')).body.error.code).toBe('INVALID_CURRENT_PASSWORD');
    expect((await change(server, cookie, PASSWORD, 'short')).body.error.code).toBe('INVALID_PASSWORD');
    expect((await change(server, cookie, PASSWORD, 'é'.repeat(37))).body.error).toMatchObject({
      code: 'INVALID_PASSWORD',
      message: expect.stringContaining('72 bytes'),
    });
    expect((await change(server, cookie, PASSWORD, PASSWORD)).body.error.code).toBe('PASSWORD_REUSED');
  });

  it('ends every other session and keeps this one with a new cookie', async () => {
    const { server, cookie } = await signedIn();
    const otherDevice = cookiePair(await login('prof@example.org', PASSWORD, server), 'cse_session');

    const res = await change(server, cookie, PASSWORD, 'a brand new password');
    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body)).not.toMatch(/\$2[aby]\$|eyJ/);
    const fresh = cookiePair(res, 'cse_session');

    expect((await request(server).get('/api/auth/me').set('Cookie', cookie)).status).toBe(401);
    expect((await request(server).get('/api/auth/me').set('Cookie', otherDevice)).status).toBe(401);
    expect((await request(server).get('/api/auth/me').set('Cookie', fresh)).status).toBe(200);
    expect((await login('prof@example.org', 'a brand new password', server)).status).toBe(200);
    expect((await login('prof@example.org', PASSWORD, server)).status).toBe(401);
  });
});

describe('CORS', () => {
  it('allows credentials only for the configured frontend origin', async () => {
    const allowed = await request(app()).get('/api/health').set('Origin', 'http://localhost:3000');
    expect(allowed.headers['access-control-allow-origin']).toBe('http://localhost:3000');
    expect(allowed.headers['access-control-allow-credentials']).toBe('true');

    // The configured origin is always the one named, never the requesting site, so browsers refuse
    // credentialed responses to any other origin.
    const other = await request(app()).get('/api/health').set('Origin', 'https://evil.example');
    expect(other.headers['access-control-allow-origin']).toBe('http://localhost:3000');
  });
});
