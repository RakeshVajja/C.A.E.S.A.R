import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app';
import { prisma } from '../../src/config/database';
import { resetDatabase } from '../helpers/database';
import { codeOf, cookiePair, createUser, fakeMailer, PASSWORD, setCookie } from './helpers';

/*
 * F4: state-changing requests from another browser origin, and bodies in the content types a
 * cross-site form or simple request can send, never change accounts (decision #62).
 */

beforeEach(async () => {
  await resetDatabase();
});

afterAll(async () => {
  await resetDatabase();
  await prisma.$disconnect();
});

const PROF = 'prof@example.org';
const FRONTEND = 'http://localhost:3000';
const EVIL = 'https://evil.example';

/** A professor with a session and a verified recovery code (reset cookie). */
async function prepared() {
  await createUser({ email: PROF, professor: 'active' });
  const { mailer, sent } = fakeMailer();
  const server = createApp({ mailer });
  const session = cookiePair(await request(server).post('/api/auth/login').send({ email: PROF, password: PASSWORD }), 'cse_session');
  await request(server).post('/api/auth/password-recovery/request').send({ email: PROF });
  const code = codeOf(sent[0]);
  const verified = await request(server).post('/api/auth/password-recovery/verify').send({ email: PROF, code });
  const resetCookie = cookiePair(verified, 'cse_password_reset');
  const state = async () => prisma.user.findUniqueOrThrow({ where: { email: PROF } });
  return { server, sent, session, code, resetCookie, state, before: await state() };
}

const routes = (p: { session: string; resetCookie: string; code: string }) => [
  { path: '/api/auth/login', cookie: null, body: { email: PROF, password: PASSWORD } },
  { path: '/api/auth/logout', cookie: p.session, body: null },
  { path: '/api/auth/change-password', cookie: p.session, body: { currentPassword: PASSWORD, newPassword: 'attacker chosen pw' } },
  { path: '/api/auth/password-recovery/request', cookie: null, body: { email: PROF } },
  { path: '/api/auth/password-recovery/verify', cookie: null, body: { email: PROF, code: p.code } },
  { path: '/api/auth/password-recovery/reset', cookie: p.resetCookie, body: { newPassword: 'attacker chosen pw' } },
];

describe('cross-origin state-changing requests', () => {
  it('are refused on every authentication and recovery mutation, including logout, with no effect', async () => {
    const p = await prepared();
    for (const origin of [EVIL, 'null', 'http://localhost:3001']) {
      for (const route of routes(p)) {
        let req = request(p.server).post(route.path).set('Origin', origin);
        if (route.cookie) req = req.set('Cookie', route.cookie);
        const res = await (route.body ? req.send(route.body) : req);
        expect(res.status, `${origin} ${route.path}`).toBe(403);
        expect(res.body).toEqual({ error: { code: 'ORIGIN_NOT_ALLOWED', message: 'Requests from this origin are not allowed' } });
        expect(setCookie(res, 'cse_session'), route.path).toBeUndefined(); // neither issued nor cleared
      }
    }
    const after = await p.state();
    expect(after.passwordHash).toBe(p.before.passwordHash);
    expect(after.passwordResetCodeHash).toBe(p.before.passwordResetCodeHash);
    expect(after.passwordResetAttempts).toBe(p.before.passwordResetAttempts);
    expect(p.sent).toHaveLength(1); // no further recovery email
    expect((await request(p.server).get('/api/auth/me').set('Cookie', p.session)).status).toBe(200);
  });

  it('are accepted from the configured frontend origin and from clients that send no Origin', async () => {
    await createUser({ email: PROF });
    const server = createApp({ mailer: null });
    const fromFrontend = await request(server).post('/api/auth/login').set('Origin', FRONTEND).send({ email: PROF, password: PASSWORD });
    expect(fromFrontend.status).toBe(200);
    const noOrigin = await request(server).post('/api/auth/login').send({ email: PROF, password: PASSWORD });
    expect(noOrigin.status).toBe(200);
    // Reads are not affected by the check.
    const read = await request(server).get('/api/auth/me').set('Origin', EVIL).set('Cookie', cookiePair(noOrigin, 'cse_session'));
    expect(read.status).toBe(200);
  });
});

describe('simple (non-JSON) content types', () => {
  it('cannot drive any mutation that takes a body, even from the allowed origin', async () => {
    const p = await prepared();
    for (const route of routes(p).filter((r) => r.body)) {
      for (const type of ['text/plain', 'application/x-www-form-urlencoded', 'multipart/form-data']) {
        let req = request(p.server).post(route.path).set('Origin', FRONTEND);
        if (route.cookie) req = req.set('Cookie', route.cookie);
        let res;
        if (type === 'text/plain') res = await req.set('Content-Type', 'text/plain').send(JSON.stringify(route.body));
        else if (type === 'application/x-www-form-urlencoded') res = await req.type('form').send(route.body!);
        else res = await Object.entries(route.body!).reduce((r, [k, v]) => r.field(k, v), req);
        expect(res.status, `${type} ${route.path}`).toBe(400);
        expect(res.body.error.code).toBe('VALIDATION_ERROR');
        expect(setCookie(res, 'cse_session')).toBeUndefined();
      }
    }
    const after = await p.state();
    expect(after.passwordHash).toBe(p.before.passwordHash);
    expect(after.passwordResetCodeHash).toBe(p.before.passwordResetCodeHash);
    expect(after.passwordResetAttempts).toBe(p.before.passwordResetAttempts);
    expect(p.sent).toHaveLength(1);
  });
});
