import request from 'supertest';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { prisma } from '../../src/config/database';
import { discoverOpenAlexIdentity, DiscoveryPreconditionError } from '../../src/services/discovery/openAlexDiscovery';
import { passwordPolicyProblem } from '../../src/services/auth/password';
import { resetDatabase } from '../helpers/database';
import { cookiePair, createUser, fakeMailer, PASSWORD } from '../auth/helpers';
import { adminApp, adminCookie, login, replayIdentityClients, tableCounts, temporaryPasswordOf } from './helpers';

/* Professor management by the administrator (Project_plan.md §6.2, §15; Phase 9). */

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

const TEMP_PASSWORD = /^[A-HJ-NP-Z2-9]{5}(-[A-HJ-NP-Z2-9]{5}){3}$/;

async function setup() {
  const mail = fakeMailer();
  const { server, calls } = adminApp({ mailer: mail.mailer });
  const cookie = await adminCookie(server);
  const as = (method: 'get' | 'post' | 'patch' | 'delete', path: string) => request(server)[method](path).set('Cookie', cookie);
  /** The temporary password emailed to `email` most recently. */
  const emailedPassword = (email: string) => temporaryPasswordOf(mail.sent.filter((m) => m.to === email).at(-1));
  return { server, cookie, as, calls, sent: mail.sent, emailedPassword };
}

async function createProf(as: Awaited<ReturnType<typeof setup>>['as'], body: Record<string, unknown> = {}) {
  return as('post', '/api/admin/professors').send({ name: 'Ada Lovelace', department: 'CSE', designation: 'Professor', email: 'ada@example.org', ...body });
}

describe('authorization on every professor-management route', () => {
  const routes: Array<[string, string, Record<string, unknown> | null]> = [
    ['get', '/api/admin/professors', null],
    ['post', '/api/admin/professors', { name: 'X Y', email: 'x@example.org' }],
    ['get', '/api/admin/professors/00000000-0000-4000-8000-000000000001', null],
    ['patch', '/api/admin/professors/00000000-0000-4000-8000-000000000001', { name: 'X' }],
    ['patch', '/api/admin/professors/00000000-0000-4000-8000-000000000001/status', { isActive: false }],
    ['post', '/api/admin/professors/00000000-0000-4000-8000-000000000001/account', { email: 'x@example.org' }],
    ['post', '/api/admin/professors/00000000-0000-4000-8000-000000000001/identities/preview', { source: 'DBLP', externalId: 'v/MosheYVardi' }],
    ['post', '/api/admin/professors/00000000-0000-4000-8000-000000000001/identities', { previewToken: 'x' }],
    ['patch', '/api/admin/professors/00000000-0000-4000-8000-000000000001/identities/00000000-0000-4000-8000-000000000002', { isActive: false }],
    ['delete', '/api/admin/professors/00000000-0000-4000-8000-000000000001/identities/00000000-0000-4000-8000-000000000002', null],
  ];

  it('rejects anonymous users, professors, admins with a temporary password and foreign origins', async () => {
    const { server, calls } = adminApp();
    await createUser({ email: 'prof@example.org', professor: 'active' });
    await createUser({ email: 'temp-admin@example.org', role: 'ADMIN', mustChangePassword: true });
    const profCookie = cookiePair(await login(server, 'prof@example.org', PASSWORD), 'cse_session');
    const tempAdminCookie = cookiePair(await login(server, 'temp-admin@example.org', PASSWORD), 'cse_session');
    const before = await tableCounts();

    for (const [method, path, body] of routes) {
      const send = (cookie: string | null, origin?: string) => {
        let req = request(server)[method as 'get'](path);
        if (cookie) req = req.set('Cookie', cookie);
        if (origin) req = req.set('Origin', origin);
        return body ? req.send(body) : req;
      };
      expect((await send(null)).status, `${method} ${path} anonymous`).toBe(401);
      expect((await send(profCookie)).body.error.code, `${method} ${path} professor`).toBe('FORBIDDEN');
      expect((await send(tempAdminCookie)).body.error.code, `${method} ${path} temporary password`).toBe('PASSWORD_CHANGE_REQUIRED');
      if (method !== 'get') expect((await send(tempAdminCookie, 'https://evil.example')).body.error.code).toBe('ORIGIN_NOT_ALLOWED');
    }
    expect(await tableCounts()).toEqual(before);
    expect(calls).toHaveLength(0); // no source was contacted
  });
});

describe('creating professors', () => {
  it('creates the professor and its PROFESSOR account together and emails the temporary password, never returning it', async () => {
    const { server, as, sent, emailedPassword } = await setup();
    const logged: string[] = [];
    for (const m of ['log', 'info', 'warn', 'error'] as const) {
      vi.spyOn(console, m).mockImplementation((...a: unknown[]) => void logged.push(a.map(String).join(' ')));
    }
    const res = await createProf(as, { email: '  Ada@Example.ORG ' });

    expect(res.status).toBe(201);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body).not.toHaveProperty('temporaryPassword');
    expect(res.body.invitation).toEqual({ status: 'SENT' });
    expect(sent).toHaveLength(1);
    expect(sent[0].to).toBe('ada@example.org');
    const temporaryPassword = emailedPassword('ada@example.org');
    expect(temporaryPassword).toMatch(TEMP_PASSWORD);
    expect(passwordPolicyProblem(temporaryPassword)).toBeNull();
    expect(JSON.stringify(res.body)).not.toContain(temporaryPassword);
    expect(res.body.professor).toMatchObject({
      name: 'Ada Lovelace',
      department: 'CSE',
      designation: 'Professor',
      isActive: true,
      account: { email: 'ada@example.org', mustChangePassword: true, activated: false },
      identities: [],
    });
    const user = await prisma.user.findUniqueOrThrow({ where: { email: 'ada@example.org' }, include: { professor: true } });
    expect(user).toMatchObject({ role: 'PROFESSOR', mustChangePassword: true });
    expect(user.professor?.id).toBe(res.body.professor.id);
    expect(user.passwordHash).not.toContain(temporaryPassword);
    expect(logged.join('\n')).not.toContain(temporaryPassword);

    // Not retrievable later.
    const detail = await as('get', `/api/admin/professors/${res.body.professor.id}`);
    expect(JSON.stringify(detail.body)).not.toContain(temporaryPassword);
    expect(JSON.stringify((await as('get', '/api/admin/professors')).body)).not.toContain(temporaryPassword);

    // First login is limited until the temporary password is changed.
    const first = await login(server, 'ada@example.org', temporaryPassword);
    expect(first.body.user.mustChangePassword).toBe(true);
    const profCookie = cookiePair(first, 'cse_session');
    expect((await request(server).get('/api/me/profile').set('Cookie', profCookie)).body.error.code).toBe('PASSWORD_CHANGE_REQUIRED');
    const changed = await request(server)
      .post('/api/auth/change-password')
      .set('Cookie', profCookie)
      .send({ currentPassword: temporaryPassword, newPassword: 'my own password 1' });
    expect(changed.status).toBe(200);
    expect((await request(server).get('/api/me/profile').set('Cookie', cookiePair(changed, 'cse_session'))).status).toBe(200);
  });

  it('rejects a duplicate email without leaving a professor or user behind, also concurrently', async () => {
    const { as } = await setup();
    await createUser({ email: 'taken@example.org' });
    const before = await tableCounts();
    const dup = await createProf(as, { email: 'taken@example.org' });
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe('EMAIL_IN_USE');
    expect(await tableCounts()).toEqual(before);

    const results = await Promise.all(Array.from({ length: 5 }, () => createProf(as, { email: 'same@example.org' })));
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(results.filter((r) => r.status === 409)).toHaveLength(4);
    expect(await prisma.professor.count()).toBe(before.professors + 1);
    expect(await prisma.user.count()).toBe(before.users + 1);
  });

  it('validates input strictly; the role and other account fields cannot be supplied', async () => {
    const { as } = await setup();
    for (const body of [
      { name: '', email: 'a@example.org' },
      { name: 'A B', email: 'not-an-email' },
      { name: 'A B' },
      { name: 'A B', email: 'a@example.org', role: 'ADMIN' },
      { name: 'A B', email: 'a@example.org', mustChangePassword: false },
      { name: 'A B', email: 'a@example.org', isActive: false },
    ]) {
      const res = await as('post', '/api/admin/professors').send(body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    }
    expect(await prisma.user.count({ where: { role: 'ADMIN' } })).toBe(1);
    expect(await prisma.professor.count()).toBe(0);
  });
});

describe('listing and details', () => {
  it('lists every professor ordered by name, including inactive ones and professors without an account', async () => {
    const { as } = await setup();
    await createProf(as, { name: 'Zed Zebra', email: 'zed@example.org' });
    const ada = await createProf(as, { name: 'Ada Lovelace', email: 'ada@example.org' });
    await prisma.professor.create({ data: { name: 'Marie Curie', isActive: false } });

    const res = await as('get', '/api/admin/professors');
    expect(res.status).toBe(200);
    expect(res.body.professors.map((p: { name: string }) => p.name)).toEqual(['Ada Lovelace', 'Marie Curie', 'Zed Zebra']);
    expect(res.body.professors[1]).toMatchObject({ isActive: false, account: null, identityCount: 0 });
    expect(JSON.stringify(res.body)).not.toMatch(/passwordHash|\$2[aby]\$/);

    const detail = await as('get', `/api/admin/professors/${ada.body.professor.id}`);
    expect(detail.body.professor).toMatchObject({ name: 'Ada Lovelace', account: { email: 'ada@example.org' } });
  });

  it('answers 404 for unknown and malformed IDs; there is no delete route', async () => {
    const { as } = await setup();
    const prof = await createProf(as);
    expect((await as('get', '/api/admin/professors/00000000-0000-4000-8000-000000000099')).body.error.code).toBe('PROFESSOR_NOT_FOUND');
    expect((await as('get', '/api/admin/professors/not-a-uuid')).body.error.code).toBe('PROFESSOR_NOT_FOUND');
    const del = await as('delete', `/api/admin/professors/${prof.body.professor.id}`);
    expect(del.status).toBe(404);
    expect(del.body.error.code).toBe('NOT_FOUND');
    expect(await prisma.professor.count()).toBe(1);
  });
});

describe('updating profiles and email', () => {
  it('updates and clears profile fields', async () => {
    const { as } = await setup();
    const id = (await createProf(as)).body.professor.id;
    const res = await as('patch', `/api/admin/professors/${id}`).send({ name: 'Augusta Ada King', department: null, designation: 'Emeritus' });
    expect(res.body.professor).toMatchObject({ name: 'Augusta Ada King', department: null, designation: 'Emeritus' });
    expect((await as('patch', `/api/admin/professors/${id}`).send({})).status).toBe(400);
    expect((await as('patch', `/api/admin/professors/${id}`).send({ isActive: false })).status).toBe(400);
  });

  it('changes the login email (normalized), clears a pending recovery code but keeps send limits', async () => {
    const { as } = await setup();
    const id = (await createProf(as)).body.professor.id;
    const sentAt = new Date('2026-10-14T09:00:00.000Z');
    await prisma.user.update({
      where: { email: 'ada@example.org' },
      data: { passwordResetCodeHash: 'f'.repeat(64), passwordResetExpiresAt: new Date(Date.now() + 60_000), passwordResetAttempts: 2, passwordResetLastSentAt: sentAt, passwordResetSendCount: 2 },
    });
    const res = await as('patch', `/api/admin/professors/${id}`).send({ email: ' Ada.King@Example.org ' });
    expect(res.body.professor.account.email).toBe('ada.king@example.org');
    expect(await prisma.user.findUniqueOrThrow({ where: { email: 'ada.king@example.org' } })).toMatchObject({
      passwordResetCodeHash: null,
      passwordResetExpiresAt: null,
      passwordResetAttempts: 0,
      passwordResetLastSentAt: sentAt,
      passwordResetSendCount: 2,
    });
  });

  it('rolls the whole update back when the new email is taken; refuses an email for a professor without account', async () => {
    const { as } = await setup();
    const id = (await createProf(as)).body.professor.id;
    await createUser({ email: 'taken@example.org' });
    const res = await as('patch', `/api/admin/professors/${id}`).send({ name: 'Changed Name', email: 'taken@example.org' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('EMAIL_IN_USE');
    expect(await prisma.professor.findUniqueOrThrow({ where: { id } })).toMatchObject({ name: 'Ada Lovelace' });

    const noAccount = await prisma.professor.create({ data: { name: 'No Account' } });
    expect((await as('patch', `/api/admin/professors/${noAccount.id}`).send({ email: 'new@example.org' })).body.error.code).toBe('NO_ACCOUNT');
  });
});

describe('activation and deactivation', () => {
  it('deactivation keeps all data, ends the professor session and blocks sign-in; reactivation restores access', async () => {
    const { server, as, emailedPassword } = await setup();
    const created = await createProf(as);
    const id = created.body.professor.id;
    const temporaryPassword = emailedPassword('ada@example.org');
    const session = await login(server, 'ada@example.org', temporaryPassword);
    const profCookie = cookiePair(session, 'cse_session');
    const identity = await prisma.externalIdentity.create({ data: { professorId: id, source: 'DBLP', externalId: 'v/MosheYVardi' } });
    const publication = await prisma.publication.create({ data: { title: 'T One', normalizedTitle: 't one', typeFamily: 'JOURNAL' } });
    await prisma.professorPublication.create({ data: { professorId: id, publicationId: publication.id, status: 'PENDING', origin: 'DISCOVERED', discoveredViaIdentityId: identity.id } });
    const before = await tableCounts();

    for (let i = 0; i < 2; i++) {
      const res = await as('patch', `/api/admin/professors/${id}/status`).send({ isActive: false });
      expect(res.status).toBe(200);
      expect(res.body.professor.isActive).toBe(false);
    }
    expect(await tableCounts()).toEqual(before);
    expect(await prisma.externalIdentity.findUniqueOrThrow({ where: { id: identity.id } })).toMatchObject({ isActive: true });
    expect(await prisma.professorPublication.count({ where: { professorId: id, status: 'PENDING' } })).toBe(1);
    expect((await request(server).get('/api/auth/me').set('Cookie', profCookie)).status).toBe(401);
    expect((await login(server, 'ada@example.org', temporaryPassword)).status).toBe(401);

    // Identities of an inactive professor are not synchronized (refused before any request).
    const { clients, calls } = replayIdentityClients();
    await expect(discoverOpenAlexIdentity(identity.id, { openAlex: clients.openAlex })).rejects.toBeInstanceOf(DiscoveryPreconditionError);
    expect(calls).toHaveLength(0);

    const reactivated = await as('patch', `/api/admin/professors/${id}/status`).send({ isActive: true });
    expect(reactivated.body.professor.isActive).toBe(true);
    expect((await login(server, 'ada@example.org', temporaryPassword)).status).toBe(200);
  });

  it('validates the status body', async () => {
    const { as } = await setup();
    const id = (await createProf(as)).body.professor.id;
    expect((await as('patch', `/api/admin/professors/${id}/status`).send({ isActive: 'no' })).status).toBe(400);
    expect((await as('patch', '/api/admin/professors/00000000-0000-4000-8000-000000000099/status').send({ isActive: false })).status).toBe(404);
  });
});

describe('account for an existing professor', () => {
  it('creates a login account and emails its temporary password; refuses a second account', async () => {
    const { as, sent, emailedPassword } = await setup();
    const prof = await prisma.professor.create({ data: { name: 'Grace Hopper' } });
    const res = await as('post', `/api/admin/professors/${prof.id}/account`).send({ email: 'Grace@Example.org' });
    expect(res.status).toBe(201);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body).not.toHaveProperty('temporaryPassword');
    expect(res.body.invitation).toEqual({ status: 'SENT' });
    expect(sent.map((m) => m.to)).toEqual(['grace@example.org']);
    expect(emailedPassword('grace@example.org')).toMatch(TEMP_PASSWORD);
    expect(res.body.professor.account).toMatchObject({ email: 'grace@example.org', mustChangePassword: true, activated: false });

    const again = await as('post', `/api/admin/professors/${prof.id}/account`).send({ email: 'other@example.org' });
    expect(again.body.error.code).toBe('ACCOUNT_EXISTS');
    expect(await prisma.user.count({ where: { role: 'PROFESSOR' } })).toBe(1);
  });

  it('concurrent requests create exactly one account and no orphan user; a taken email creates nothing', async () => {
    const { as } = await setup();
    const prof = await prisma.professor.create({ data: { name: 'Grace Hopper' } });
    const results = await Promise.all(
      ['g1@example.org', 'g2@example.org', 'g3@example.org'].map((email) => as('post', `/api/admin/professors/${prof.id}/account`).send({ email })),
    );
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(results.filter((r) => r.status === 409).every((r) => r.body.error.code === 'ACCOUNT_EXISTS')).toBe(true);
    expect(await prisma.user.count({ where: { role: 'PROFESSOR' } })).toBe(1);

    const other = await prisma.professor.create({ data: { name: 'Other Prof' } });
    await createUser({ email: 'taken@example.org' });
    const users = await prisma.user.count();
    const taken = await as('post', `/api/admin/professors/${other.id}/account`).send({ email: 'taken@example.org' });
    expect(taken.body.error.code).toBe('EMAIL_IN_USE');
    expect(await prisma.user.count()).toBe(users);
    expect((await prisma.professor.findUniqueOrThrow({ where: { id: other.id } })).userId).toBeNull();
  });
});
