import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '../../src/config/database';
import { cookiePair, createUser, PASSWORD } from '../auth/helpers';
import { resetDatabase } from '../helpers/database';
import { adminApp, login } from './helpers';

/* A professor's own profile (decision #67): readable; only the name is editable. */

beforeEach(async () => {
  await resetDatabase();
});

afterAll(async () => {
  await resetDatabase();
  await prisma.$disconnect();
});

async function signedIn(email = 'prof@example.org') {
  const { server } = adminApp();
  const user = await createUser({ email, professor: 'active' });
  const cookie = cookiePair(await login(server, email, PASSWORD), 'cse_session');
  return { server, user, cookie };
}

describe('GET /api/me/profile', () => {
  it('returns the signed-in professor\'s own profile', async () => {
    const { server, cookie, user } = await signedIn();
    const res = await request(server).get('/api/me/profile').set('Cookie', cookie);
    expect(res.status).toBe(200);
    const professor = await prisma.professor.findUniqueOrThrow({ where: { userId: user.id } });
    expect(res.body).toEqual({
      profile: { id: professor.id, name: professor.name, department: null, designation: null, email: 'prof@example.org' },
    });
  });

  it('needs a session; administrators and unlinked professor accounts have no profile', async () => {
    const { server } = adminApp();
    expect((await request(server).get('/api/me/profile')).status).toBe(401);

    await createUser({ email: 'admin@example.org', role: 'ADMIN' });
    const admin = cookiePair(await login(server, 'admin@example.org', PASSWORD), 'cse_session');
    expect((await request(server).get('/api/me/profile').set('Cookie', admin)).body.error.code).toBe('FORBIDDEN');

    await createUser({ email: 'unlinked@example.org' });
    const unlinked = cookiePair(await login(server, 'unlinked@example.org', PASSWORD), 'cse_session');
    expect((await request(server).get('/api/me/profile').set('Cookie', unlinked)).body.error.code).toBe('PROFILE_NOT_FOUND');
  });
});

describe('PATCH /api/me/profile', () => {
  it('lets a professor change only their own name', async () => {
    const { server, cookie, user } = await signedIn();
    const other = await createUser({ email: 'other@example.org', professor: 'active' });
    const otherProfessor = await prisma.professor.findUniqueOrThrow({ where: { userId: other.id } });

    const res = await request(server).patch('/api/me/profile').set('Cookie', cookie).send({ name: '  New Name  ' });
    expect(res.status).toBe(200);
    expect(res.body.profile.name).toBe('New Name');
    expect((await prisma.professor.findUniqueOrThrow({ where: { userId: user.id } })).name).toBe('New Name');
    expect((await prisma.professor.findUniqueOrThrow({ where: { id: otherProfessor.id } })).name).toBe(otherProfessor.name);
  });

  it('refuses every other field, including another professor\'s ID, and an empty name', async () => {
    const { server, cookie, user } = await signedIn();
    const other = await createUser({ email: 'other@example.org', professor: 'active' });
    const otherProfessor = await prisma.professor.findUniqueOrThrow({ where: { userId: other.id } });
    const before = await prisma.professor.findUniqueOrThrow({ where: { userId: user.id } });

    for (const body of [
      { department: 'Physics' },
      { designation: 'Dean' },
      { email: 'new@example.org' },
      { isActive: false },
      { name: 'X', professorId: otherProfessor.id },
      { name: 'X', id: otherProfessor.id },
      { name: '   ' },
      {},
    ]) {
      const res = await request(server).patch('/api/me/profile').set('Cookie', cookie).send(body);
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
    expect(await prisma.professor.findUniqueOrThrow({ where: { userId: user.id } })).toEqual(before);
    expect((await prisma.professor.findUniqueOrThrow({ where: { id: otherProfessor.id } })).name).toBe(otherProfessor.name);
  });

  it('is unavailable to a deactivated professor (the session ends)', async () => {
    const { server, cookie, user } = await signedIn();
    await prisma.professor.update({ where: { userId: user.id }, data: { isActive: false } });
    expect((await request(server).patch('/api/me/profile').set('Cookie', cookie).send({ name: 'New Name' })).status).toBe(401);
  });
});
