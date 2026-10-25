import fs from 'fs';
import path from 'path';
import request from 'supertest';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../../src/app';
import { prisma } from '../../src/config/database';
import type { Mailer, MailMessage } from '../../src/services/email/mailer';
import { TEMPORARY_PASSWORD_TTL_MS } from '../../src/services/professors/invitations';
import { codeOf, cookiePair, createUser, fakeMailer, PASSWORD, testClock } from '../auth/helpers';
import { resetDatabase } from '../helpers/database';
import { adminCookie, login, replayIdentityClients, temporaryPasswordOf } from './helpers';

/* Emailed temporary passwords for professor accounts (Project_plan.md §15.2; decision #102). In-memory mailers only. */

beforeEach(async () => {
  await resetDatabase();
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await resetDatabase();
  await prisma.$disconnect();
});

const START = '2026-10-26T06:00:00.000Z';

/** An admin app with a controllable mailer and clock; every console line is captured. */
async function setup(mailer: Mailer | null = fakeMailer().mailer) {
  const clock = testClock(START);
  const logged: string[] = [];
  for (const m of ['log', 'info', 'warn', 'error'] as const) {
    vi.spyOn(console, m).mockImplementation((...a: unknown[]) => void logged.push(a.map(String).join(' ')));
  }
  const server = createApp({ mailer, identityClients: replayIdentityClients().clients, now: clock.now });
  const cookie = await adminCookie(server);
  const as = (method: 'get' | 'post' | 'patch', p: string) => request(server)[method](p).set('Cookie', cookie);
  return { server, clock, logged, as };
}

const createProf = (as: Awaited<ReturnType<typeof setup>>['as'], email = 'ada@example.org') =>
  as('post', '/api/admin/professors').send({ name: 'Ada Lovelace', email });

const passwordsIn = (sent: MailMessage[], to: string) => sent.filter((m) => m.to === to).map(temporaryPasswordOf);

describe('delivery status', () => {
  it('SENT: the email holds the sign-in address, login email, password and expiry; nothing secret is returned or logged', async () => {
    const mail = fakeMailer();
    const { as, logged } = await setup(mail.mailer);
    const res = await createProf(as);
    expect(res.status).toBe(201);
    expect(res.body.invitation).toEqual({ status: 'SENT' });
    const [message] = mail.sent;
    const password = temporaryPasswordOf(message);
    expect(message.subject).toBe('Your CSE Research Hub sign-in details');
    expect(message.text).toContain('/login');
    expect(message.text).toContain('Email: ada@example.org');
    expect(message.text).toMatch(/works until .* IST and must be changed/);
    expect(JSON.stringify(res.body)).not.toContain(password);
    expect(logged.join('\n')).not.toContain(password);
    const user = await prisma.user.findUniqueOrThrow({ where: { email: 'ada@example.org' } });
    expect(user.temporaryPasswordExpiresAt).toEqual(new Date(new Date(START).getTime() + TEMPORARY_PASSWORD_TTL_MS));
    expect(res.body.professor.account).toMatchObject({ activated: false, temporaryPasswordExpiresAt: user.temporaryPasswordExpiresAt!.toISOString() });
  });

  it('FAILED: the account is kept, only an SMTP error code is logged, and the unknown password cannot be used', async () => {
    const failing: Mailer = {
      async send() {
        throw Object.assign(new Error('550 mailbox unavailable for ada@example.org'), { code: 'EENVELOPE', responseCode: 550 });
      },
    };
    const { server, as, logged } = await setup(failing);
    const res = await createProf(as);
    expect(res.status).toBe(201);
    expect(res.body.invitation).toEqual({ status: 'FAILED' });
    expect(await prisma.user.count({ where: { email: 'ada@example.org' } })).toBe(1);
    const log = logged.join('\n');
    expect(log).toContain('Sign-in email could not be sent for user');
    expect(log).toContain('EENVELOPE, SMTP 550');
    expect(log).not.toContain('mailbox unavailable');
    expect(JSON.stringify(res.body)).not.toMatch(/[A-HJ-NP-Z2-9]{5}-[A-HJ-NP-Z2-9]{5}/);
    expect((await login(server, 'ada@example.org', PASSWORD)).status).toBe(401);
  });

  it('NOT_CONFIGURED: without SMTP the account is created; a resend reports NOT_CONFIGURED and changes nothing', async () => {
    const { as } = await setup(null);
    const res = await createProf(as);
    expect(res.status).toBe(201);
    expect(res.body.invitation).toEqual({ status: 'NOT_CONFIGURED' });
    const before = await prisma.user.findUniqueOrThrow({ where: { email: 'ada@example.org' } });
    const resend = await as('post', `/api/admin/professors/${res.body.professor.id}/account/invitation`);
    expect(resend.status).toBe(200);
    expect(resend.body.invitation).toEqual({ status: 'NOT_CONFIGURED' });
    expect(await prisma.user.findUniqueOrThrow({ where: { email: 'ada@example.org' } })).toEqual(before);
  });
});

describe('resending sign-in details', () => {
  it('a new password works, the previous one stops working, and its session ends', async () => {
    const mail = fakeMailer();
    const { server, as } = await setup(mail.mailer);
    const id = (await createProf(as)).body.professor.id;
    const [first] = passwordsIn(mail.sent, 'ada@example.org');
    const session = cookiePair(await login(server, 'ada@example.org', first), 'cse_session');

    const res = await as('post', `/api/admin/professors/${id}/account/invitation`);
    expect(res.status).toBe(200);
    expect(res.body.invitation).toEqual({ status: 'SENT' });
    expect(res.body).not.toHaveProperty('temporaryPassword');
    const [, second] = passwordsIn(mail.sent, 'ada@example.org');
    expect(second).not.toBe(first);
    expect((await login(server, 'ada@example.org', first)).status).toBe(401);
    expect((await login(server, 'ada@example.org', second)).status).toBe(200);
    expect((await request(server).get('/api/auth/me').set('Cookie', session)).status).toBe(401);
  });

  it('is refused once the professor has chosen a password, without an account, for an inactive professor, and for unknown IDs', async () => {
    const mail = fakeMailer();
    const { server, as } = await setup(mail.mailer);
    const id = (await createProf(as)).body.professor.id;
    const first = cookiePair(await login(server, 'ada@example.org', passwordsIn(mail.sent, 'ada@example.org')[0]), 'cse_session');
    await request(server)
      .post('/api/auth/change-password')
      .set('Cookie', first)
      .send({ currentPassword: passwordsIn(mail.sent, 'ada@example.org')[0], newPassword: 'my own password 1' })
      .expect(200);
    const hash = (await prisma.user.findUniqueOrThrow({ where: { email: 'ada@example.org' } })).passwordHash;
    const active = await as('post', `/api/admin/professors/${id}/account/invitation`);
    expect(active.status).toBe(409);
    expect(active.body.error.code).toBe('ACCOUNT_ALREADY_ACTIVE');
    expect((await prisma.user.findUniqueOrThrow({ where: { email: 'ada@example.org' } })).passwordHash).toBe(hash);
    expect(mail.sent).toHaveLength(1);

    const noAccount = await prisma.professor.create({ data: { name: 'No Account' } });
    expect((await as('post', `/api/admin/professors/${noAccount.id}/account/invitation`)).body.error.code).toBe('NO_ACCOUNT');
    const other = (await createProf(as, 'grace@example.org')).body.professor.id;
    await as('patch', `/api/admin/professors/${other}/status`).send({ isActive: false }).expect(200);
    expect((await as('post', `/api/admin/professors/${other}/account/invitation`)).body.error.code).toBe('PROFESSOR_INACTIVE');
    expect((await as('post', '/api/admin/professors/00000000-0000-4000-8000-000000000001/account/invitation')).status).toBe(404);
    expect((await as('post', '/api/admin/professors/not-a-uuid/account/invitation')).status).toBe(404);
  });

  it('is rate limited per professor', async () => {
    const mail = fakeMailer();
    const { as } = await setup(mail.mailer);
    const id = (await createProf(as)).body.professor.id;
    for (let i = 0; i < 3; i++) expect((await as('post', `/api/admin/professors/${id}/account/invitation`)).status).toBe(200);
    const limited = await as('post', `/api/admin/professors/${id}/account/invitation`);
    expect(limited.status).toBe(429);
    expect(limited.headers['retry-after']).toBeDefined();
    expect(mail.sent).toHaveLength(4); // creation + 3 resends
  });

  it('concurrent resends never interleave: each email is sent while its password is the stored one, and only the last works', async () => {
    const sent: MailMessage[] = [];
    const storedAtSend: boolean[] = [];
    const mailer: Mailer = {
      async send(message) {
        // While this email is being sent, its password must be the current one (no other resend ran in between).
        const user = await prisma.user.findUniqueOrThrow({ where: { email: message.to } });
        const { verifyPassword } = await import('../../src/services/auth/password');
        storedAtSend.push(await verifyPassword(temporaryPasswordOf(message), user.passwordHash));
        await new Promise((r) => setTimeout(r, 30));
        sent.push(message);
      },
    };
    const { server, as } = await setup(mailer);
    const id = (await createProf(as)).body.professor.id;
    const results = await Promise.all([0, 1, 2].map(() => as('post', `/api/admin/professors/${id}/account/invitation`)));
    expect(results.map((r) => r.body.invitation.status)).toEqual(['SENT', 'SENT', 'SENT']);
    expect(storedAtSend).toEqual([true, true, true, true]);
    const passwords = passwordsIn(sent, 'ada@example.org');
    expect(new Set(passwords).size).toBe(4);
    const statuses = await Promise.all(passwords.map(async (p) => (await login(server, 'ada@example.org', p)).status));
    expect(statuses).toEqual([401, 401, 401, 200]);
  });

  it('an email whose password is superseded before the delivery finishes is reported FAILED, never SENT', async () => {
    let supersede = false;
    const mail: MailMessage[] = [];
    const mailer: Mailer = {
      async send(message) {
        mail.push(message);
        // The professor recovers the account while this email is still being sent.
        if (supersede) await prisma.user.update({ where: { email: message.to }, data: { passwordHash: 'changed-elsewhere', mustChangePassword: false } });
      },
    };
    const { as, logged } = await setup(mailer);
    const id = (await createProf(as)).body.professor.id;
    supersede = true;
    const res = await as('post', `/api/admin/professors/${id}/account/invitation`);
    expect(res.body.invitation).toEqual({ status: 'FAILED' });
    expect(logged.join('\n')).toContain('was superseded before it finished');
    expect(logged.join('\n')).not.toContain(temporaryPasswordOf(mail[1]));
  });
});

describe('changing the email of a professor', () => {
  it('not yet activated: a new password goes to the new address in the same update, and the old one stops working', async () => {
    const mail = fakeMailer();
    const { server, as } = await setup(mail.mailer);
    const id = (await createProf(as)).body.professor.id;
    const [old] = passwordsIn(mail.sent, 'ada@example.org');
    const res = await as('patch', `/api/admin/professors/${id}`).send({ email: 'ada.king@example.org' });
    expect(res.status).toBe(200);
    expect(res.body.invitation).toEqual({ status: 'SENT' });
    expect(res.body.professor.account.email).toBe('ada.king@example.org');
    const [fresh] = passwordsIn(mail.sent, 'ada.king@example.org');
    expect(passwordsIn(mail.sent, 'ada@example.org')).toHaveLength(1);
    expect((await login(server, 'ada.king@example.org', old)).status).toBe(401);
    expect((await login(server, 'ada.king@example.org', fresh)).status).toBe(200);
    expect(JSON.stringify(res.body)).not.toContain(fresh);
  });

  it('activated: only the email changes; no email is sent and the password is kept', async () => {
    const mail = fakeMailer();
    const { server, as } = await setup(mail.mailer);
    const id = (await createProf(as)).body.professor.id;
    const temp = passwordsIn(mail.sent, 'ada@example.org')[0];
    const session = cookiePair(await login(server, 'ada@example.org', temp), 'cse_session');
    await request(server).post('/api/auth/change-password').set('Cookie', session).send({ currentPassword: temp, newPassword: 'my own password 1' }).expect(200);
    const res = await as('patch', `/api/admin/professors/${id}`).send({ email: 'ada.king@example.org' });
    expect(res.status).toBe(200);
    expect(res.body).not.toHaveProperty('invitation');
    expect(mail.sent).toHaveLength(1);
    expect((await login(server, 'ada.king@example.org', 'my own password 1')).status).toBe(200);
  });
});

describe('expiry (7 days)', () => {
  it('a correct expired temporary password is refused at sign-in with TEMPORARY_PASSWORD_EXPIRED; a wrong one stays generic; a resend restores access', async () => {
    const mail = fakeMailer();
    const { server, as, clock } = await setup(mail.mailer);
    const id = (await createProf(as)).body.professor.id;
    const [temp] = passwordsIn(mail.sent, 'ada@example.org');

    clock.advance(TEMPORARY_PASSWORD_TTL_MS - 1);
    expect((await login(server, 'ada@example.org', temp)).status).toBe(200);
    clock.advance(1);
    const expired = await login(server, 'ada@example.org', temp);
    expect(expired.status).toBe(403);
    expect(expired.body.error.code).toBe('TEMPORARY_PASSWORD_EXPIRED');
    expect(JSON.stringify(expired.body)).not.toContain(temp);
    const wrong = await login(server, 'ada@example.org', 'not the password 1');
    expect(wrong.status).toBe(401);
    expect(wrong.body.error.code).toBe('INVALID_CREDENTIALS');

    await as('post', `/api/admin/professors/${id}/account/invitation`).expect(200);
    expect((await login(server, 'ada@example.org', passwordsIn(mail.sent, 'ada@example.org')[1])).status).toBe(200);
  });

  it('a session opened before the expiry cannot change the expired temporary password', async () => {
    const mail = fakeMailer();
    const { server, as, clock } = await setup(mail.mailer);
    await createProf(as);
    const [temp] = passwordsIn(mail.sent, 'ada@example.org');
    const session = cookiePair(await login(server, 'ada@example.org', temp), 'cse_session');
    clock.advance(TEMPORARY_PASSWORD_TTL_MS + 1000);
    const res = await request(server).post('/api/auth/change-password').set('Cookie', session).send({ currentPassword: temp, newPassword: 'my own password 1' });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('TEMPORARY_PASSWORD_EXPIRED');
  });

  it('every password change clears the expiry: change-password and password recovery', async () => {
    const mail = fakeMailer();
    const { server, as } = await setup(mail.mailer);
    await createProf(as);
    const temp = passwordsIn(mail.sent, 'ada@example.org')[0];
    const session = cookiePair(await login(server, 'ada@example.org', temp), 'cse_session');
    await request(server).post('/api/auth/change-password').set('Cookie', session).send({ currentPassword: temp, newPassword: 'my own password 1' }).expect(200);
    expect(await prisma.user.findUniqueOrThrow({ where: { email: 'ada@example.org' } })).toMatchObject({ mustChangePassword: false, temporaryPasswordExpiresAt: null });

    // A professor who never activated can still choose a password through recovery (it activates the account).
    await createProf(as, 'grace@example.org');
    await request(server).post('/api/auth/password-recovery/request').send({ email: 'grace@example.org' }).expect(202);
    await new Promise((r) => setTimeout(r, 10));
    const code = codeOf(mail.sent.filter((m) => m.to === 'grace@example.org').at(-1));
    const verified = await request(server).post('/api/auth/password-recovery/verify').send({ email: 'grace@example.org', code });
    const reset = cookiePair(verified, 'cse_password_reset');
    await request(server).post('/api/auth/password-recovery/reset').set('Cookie', reset).send({ newPassword: 'grace own password 1' }).expect(200);
    expect(await prisma.user.findUniqueOrThrow({ where: { email: 'grace@example.org' } })).toMatchObject({ mustChangePassword: false, temporaryPasswordExpiresAt: null });
  });

  it('the migration backfill gives existing unactivated professor accounts 7 days and leaves the others untouched', async () => {
    await createUser({ email: 'old-temp@example.org', professor: 'active', mustChangePassword: true });
    await createUser({ email: 'activated@example.org', professor: 'active' });
    await createUser({ email: 'admin2@example.org', role: 'ADMIN', mustChangePassword: true });
    const sql = fs.readFileSync(path.resolve(__dirname, '../../prisma/migrations/20261026120000_add_user_temporary_password_expiry/migration.sql'), 'utf8');
    const update = sql.slice(sql.indexOf('UPDATE "users"'));
    const before = Date.now();
    await prisma.$executeRawUnsafe(update);
    const rows = await prisma.user.findMany({ select: { email: true, temporaryPasswordExpiresAt: true } });
    const by = Object.fromEntries(rows.map((r) => [r.email, r.temporaryPasswordExpiresAt]));
    expect(by['activated@example.org']).toBeNull();
    expect(by['admin2@example.org']).toBeNull();
    const backfilled = by['old-temp@example.org']!.getTime();
    expect(backfilled).toBeGreaterThanOrEqual(before + TEMPORARY_PASSWORD_TTL_MS - 5000);
    expect(backfilled).toBeLessThanOrEqual(Date.now() + TEMPORARY_PASSWORD_TTL_MS + 5000);
  });
});
