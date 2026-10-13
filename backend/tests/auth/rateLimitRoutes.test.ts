import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app';
import { prisma } from '../../src/config/database';
import { resetDatabase } from '../helpers/database';
import { createUser, fakeMailer, PASSWORD, testClock } from './helpers';

/* Per-IP rate limits on the authentication and recovery endpoints (decision #59). */

beforeEach(async () => {
  await resetDatabase();
});

afterAll(async () => {
  await resetDatabase();
  await prisma.$disconnect();
});

function limitedApp() {
  const clock = testClock();
  const server = createApp({
    mailer: fakeMailer().mailer,
    now: clock.now,
    trustProxy: true, // tests simulate client IPs with X-Forwarded-For
    rateLimits: {
      login: { windowMs: 60_000, max: 2 },
      recoveryRequest: { windowMs: 60_000, max: 2 },
      recoveryVerify: { windowMs: 60_000, max: 2 },
    },
  });
  return { server, clock };
}

const loginFrom = (server: ReturnType<typeof createApp>, ip: string, email: string, password = PASSWORD) =>
  request(server).post('/api/auth/login').set('X-Forwarded-For', ip).send({ email, password });

describe('per-IP rate limits', () => {
  it('limits one IP, leaves other IPs alone, and restarts after the window', async () => {
    await createUser({ email: 'prof@example.org' });
    const { server, clock } = limitedApp();

    expect((await loginFrom(server, '203.0.113.1', 'prof@example.org', 'wrong password!')).status).toBe(401);
    expect((await loginFrom(server, '203.0.113.1', 'prof@example.org', 'wrong password!')).status).toBe(401);
    const limited = await loginFrom(server, '203.0.113.1', 'prof@example.org');
    expect(limited.status).toBe(429);
    expect(limited.body).toEqual({ error: { code: 'RATE_LIMITED', message: 'Too many requests; try again later' } });
    expect(limited.headers['retry-after']).toBe('60');

    expect((await loginFrom(server, '198.51.100.7', 'prof@example.org')).status).toBe(200);

    clock.advance(60_000);
    expect((await loginFrom(server, '203.0.113.1', 'prof@example.org')).status).toBe(200);
  });

  it('answers limited requests identically for existing and unknown accounts', async () => {
    await createUser({ email: 'prof@example.org', professor: 'active' });
    const { server } = limitedApp();
    const ip = '203.0.113.9';
    const ask = (email: string) => request(server).post('/api/auth/password-recovery/request').set('X-Forwarded-For', ip).send({ email });

    await ask('prof@example.org');
    await ask('nobody@example.org');
    const existing = await ask('prof@example.org');
    const unknown = await ask('nobody@example.org');
    expect(existing.status).toBe(429);
    expect({ status: unknown.status, body: unknown.body }).toEqual({ status: existing.status, body: existing.body });
  });

  it('limits code verification per IP in front of the per-code attempt limit', async () => {
    await createUser({ email: 'prof@example.org', professor: 'active' });
    const { server } = limitedApp();
    const verify = () =>
      request(server).post('/api/auth/password-recovery/verify').set('X-Forwarded-For', '203.0.113.5').send({ email: 'prof@example.org', code: '000000' });
    expect((await verify()).status).toBe(400);
    expect((await verify()).status).toBe(400);
    expect((await verify()).status).toBe(429);
  });
});
