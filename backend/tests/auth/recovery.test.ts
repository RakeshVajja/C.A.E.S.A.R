import request from 'supertest';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../../src/app';
import { prisma } from '../../src/config/database';
import { RECOVERY_MAX_SENDS_PER_HOUR } from '../../src/services/auth/passwordRecovery';
import { signSessionToken } from '../../src/services/auth/tokens';
import type { Mailer } from '../../src/services/email/mailer';
import { resetDatabase } from '../helpers/database';
import { codeOf, cookiePair, createUser, fakeMailer, PASSWORD, setCookie, testClock } from './helpers';

/* Professor password recovery by emailed code (Project_plan.md §15.4). No real email is sent. */

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

const PROF = 'prof@example.org';
const NEW_PASSWORD = 'a recovered password';
// Generous IP limits: these tests exercise the per-account limits.
const relaxed = { recoveryRequest: { windowMs: 60_000, max: 1000 }, recoveryVerify: { windowMs: 60_000, max: 1000 }, recoveryReset: { windowMs: 60_000, max: 1000 } };

function setup(mailer: Mailer | null = fakeMailer().mailer) {
  const clock = testClock();
  const server = createApp({ mailer, now: clock.now, rateLimits: relaxed });
  return {
    clock,
    server,
    requestCode: (email = PROF) => request(server).post('/api/auth/password-recovery/request').send({ email }),
    verify: (code: string, email = PROF) => request(server).post('/api/auth/password-recovery/verify').send({ email, code }),
    reset: (cookie: string | null, newPassword = NEW_PASSWORD) => {
      const req = request(server).post('/api/auth/password-recovery/reset');
      return (cookie ? req.set('Cookie', cookie) : req).send({ newPassword });
    },
  };
}

const recoveryState = (email = PROF) =>
  prisma.user.findUniqueOrThrow({
    where: { email },
    select: {
      passwordResetCodeHash: true,
      passwordResetExpiresAt: true,
      passwordResetAttempts: true,
      passwordResetLastSentAt: true,
      passwordResetSendCount: true,
      passwordHash: true,
      mustChangePassword: true,
    },
  });

describe('requesting a code', () => {
  it('emails a 6-digit code to an eligible professor and stores only its keyed hash', async () => {
    await createUser({ email: PROF, professor: 'active' });
    const { mailer, sent } = fakeMailer();
    const res = await setup(mailer).requestCode(' Prof@Example.org ');

    expect(res.status).toBe(202);
    expect(res.body).toEqual({ message: 'If an eligible account exists for this email address, a recovery code has been sent.' });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ to: PROF, subject: 'CSE Research Hub password recovery code' });
    const code = codeOf(sent[0]);
    expect(code).toMatch(/^\d{6}$/);
    expect(JSON.stringify(res.body)).not.toContain(code);

    const state = await recoveryState();
    expect(state.passwordResetCodeHash).toMatch(/^[0-9a-f]{64}$/);
    expect(state.passwordResetCodeHash).not.toContain(code);
    expect(state).toMatchObject({ passwordResetAttempts: 0, passwordResetSendCount: 1 });
    expect(state.passwordResetExpiresAt!.getTime() - state.passwordResetLastSentAt!.getTime()).toBe(10 * 60_000);
  });

  it('answers unknown, admin, inactive and unlinked accounts exactly like an eligible one, sending nothing', async () => {
    await createUser({ email: PROF, professor: 'active' });
    await createUser({ email: 'admin@example.org', role: 'ADMIN' });
    await createUser({ email: 'inactive@example.org', professor: 'inactive' });
    await createUser({ email: 'unlinked@example.org' });
    const { mailer, sent } = fakeMailer();
    const { requestCode } = setup(mailer);

    const responses = [];
    for (const email of [PROF, 'nobody@example.org', 'admin@example.org', 'inactive@example.org', 'unlinked@example.org']) {
      const res = await requestCode(email);
      responses.push({ status: res.status, body: res.body, cookies: res.headers['set-cookie'] ?? null });
    }
    expect(new Set(responses.map((r) => JSON.stringify(r))).size).toBe(1);
    expect(sent.map((m) => m.to)).toEqual([PROF]);
    for (const email of ['admin@example.org', 'inactive@example.org', 'unlinked@example.org']) {
      expect((await recoveryState(email)).passwordResetCodeHash).toBeNull();
    }
  });

  it('enforces the 60-second cooldown and at most 5 codes per hour, with the same public answer', async () => {
    await createUser({ email: PROF, professor: 'active' });
    const { mailer, sent } = fakeMailer();
    const { clock, requestCode } = setup(mailer);

    expect((await requestCode()).status).toBe(202);
    clock.advance(30_000);
    expect((await requestCode()).status).toBe(202); // within the cooldown: nothing sent
    expect(sent).toHaveLength(1);

    for (let i = 1; i < RECOVERY_MAX_SENDS_PER_HOUR; i++) {
      clock.advance(61_000);
      await requestCode();
    }
    expect(sent).toHaveLength(5);
    clock.advance(61_000);
    expect((await requestCode()).status).toBe(202); // 6th within the hour: nothing sent
    expect(sent).toHaveLength(5);

    clock.advance(60 * 60_000); // an hour without sends restarts the count
    await requestCode();
    expect(sent).toHaveLength(6);
    expect((await recoveryState()).passwordResetSendCount).toBe(1);
  });

  it('issues and sends exactly one code for concurrent requests', async () => {
    await createUser({ email: PROF, professor: 'active' });
    const { mailer, sent } = fakeMailer();
    const { requestCode } = setup(mailer);
    const results = await Promise.all(Array.from({ length: 10 }, () => requestCode()));
    expect(results.every((r) => r.status === 202)).toBe(true);
    expect(sent).toHaveLength(1);
    expect((await recoveryState()).passwordResetSendCount).toBe(1);
  });
});

describe('verifying a code', () => {
  async function issued() {
    await createUser({ email: PROF, professor: 'active' });
    const { mailer, sent } = fakeMailer();
    const ctx = setup(mailer);
    await ctx.requestCode();
    return { ...ctx, code: codeOf(sent[0]), sent };
  }

  it('gives a reset cookie scoped to the recovery path for the right code; never the token in the body', async () => {
    const { verify, code } = await issued();
    const res = await verify(code);
    expect(res.status).toBe(200);
    const cookie = setCookie(res, 'cse_password_reset')!;
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/SameSite=Lax/);
    expect(cookie).toMatch(/Path=\/api\/auth\/password-recovery/);
    expect(JSON.stringify(res.body)).not.toMatch(/eyJ/);
    expect(setCookie(res, 'cse_session')).toBeUndefined();
  });

  it('answers wrong codes, unknown emails and no pending code identically; checks the format first', async () => {
    const { verify, code } = await issued();
    const wrong = code === '000000' ? '000001' : '000000';
    const answers = [await verify(wrong), await verify(code, 'nobody@example.org'), await verify(code, 'other@example.org')];
    for (const res of answers) {
      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: { code: 'INVALID_OR_EXPIRED_CODE', message: 'The code is invalid or has expired' } });
    }
    expect((await verify('12345')).body.error.code).toBe('VALIDATION_ERROR');
  });

  it('expires codes after 10 minutes', async () => {
    const { verify, clock, code } = await issued();
    clock.advance(10 * 60_000 + 1);
    expect((await verify(code)).body.error.code).toBe('INVALID_OR_EXPIRED_CODE');
  });

  it('allows at most 5 attempts per code, also under concurrent requests', async () => {
    const { verify, code } = await issued();
    const results = await Promise.all(Array.from({ length: 12 }, () => verify(code)));
    expect(results.filter((r) => r.status === 200)).toHaveLength(5);
    expect(results.filter((r) => r.status === 400)).toHaveLength(7);
    expect((await recoveryState()).passwordResetAttempts).toBe(5);
  });

  it('locks the code after 5 wrong attempts', async () => {
    const { verify, code } = await issued();
    const wrong = code === '000000' ? '000001' : '000000';
    for (let i = 0; i < 5; i++) await verify(wrong);
    expect((await verify(code)).status).toBe(400);
  });
});

describe('resetting the password', () => {
  async function verified() {
    await createUser({ email: PROF, professor: 'active', mustChangePassword: true });
    const { mailer, sent } = fakeMailer();
    const ctx = setup(mailer);
    await ctx.requestCode();
    const res = await ctx.verify(codeOf(sent[0]));
    return { ...ctx, sent, resetCookie: cookiePair(res, 'cse_password_reset') };
  }

  it('sets the password, clears the code state, ends every session and does not sign in', async () => {
    const { server, reset, resetCookie } = await verified();
    const before = await recoveryState();
    const user = await prisma.user.findUniqueOrThrow({ where: { email: PROF } });
    const oldSession = `cse_session=${signSessionToken(user.id, user.passwordHash)}`;
    expect((await request(server).get('/api/auth/me').set('Cookie', oldSession)).status).toBe(200);

    const res = await reset(resetCookie);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ message: 'Password updated. Sign in with your new password.' });
    expect(setCookie(res, 'cse_password_reset')).toMatch(/Expires=Thu, 01 Jan 1970/);
    expect(setCookie(res, 'cse_session')).toMatch(/Expires=Thu, 01 Jan 1970/); // cleared, not issued

    const after = await recoveryState();
    expect(after).toMatchObject({ passwordResetCodeHash: null, passwordResetExpiresAt: null, passwordResetAttempts: 0, mustChangePassword: false });
    // Send limits survive a reset, so a reset cannot be used to bypass them.
    expect(after.passwordResetSendCount).toBe(before.passwordResetSendCount);
    expect(after.passwordResetLastSentAt).toEqual(before.passwordResetLastSentAt);

    expect((await request(server).get('/api/auth/me').set('Cookie', oldSession)).status).toBe(401);
    const login = await request(server).post('/api/auth/login').send({ email: PROF, password: NEW_PASSWORD });
    expect(login.status).toBe(200);
    expect((await request(server).post('/api/auth/login').send({ email: PROF, password: PASSWORD })).status).toBe(401);

    // The reset capability is single-use.
    expect((await reset(resetCookie, 'yet another password')).body.error.code).toBe('INVALID_OR_EXPIRED_RESET');
  });

  it('enforces the password policy without consuming the code', async () => {
    const { reset, resetCookie } = await verified();
    expect((await reset(resetCookie, 'short')).body.error.code).toBe('INVALID_PASSWORD');
    expect((await reset(resetCookie, 'é'.repeat(37))).body.error.code).toBe('INVALID_PASSWORD');
    expect((await reset(resetCookie, PASSWORD)).body.error.code).toBe('PASSWORD_REUSED');
    expect((await reset(resetCookie)).status).toBe(200);
  });

  it('lets only one of several concurrent resets succeed', async () => {
    const { reset, resetCookie } = await verified();
    const candidates = Array.from({ length: 6 }, (_, i) => `concurrent password ${i}`);
    const results = await Promise.all(candidates.map((p) => reset(resetCookie, p)));
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    expect(results.filter((r) => r.status === 400).every((r) => r.body.error.code === 'INVALID_OR_EXPIRED_RESET')).toBe(true);
  });

  it('a new code invalidates earlier reset capabilities and codes', async () => {
    const { clock, requestCode, verify, reset, resetCookie, sent } = await verified();
    const firstCode = codeOf(sent[0]);
    clock.advance(61_000);
    await requestCode();
    expect(sent).toHaveLength(2);

    expect((await reset(resetCookie)).body.error.code).toBe('INVALID_OR_EXPIRED_RESET');
    if (firstCode !== codeOf(sent[1])) expect((await verify(firstCode)).status).toBe(400);
    const second = await verify(codeOf(sent[1]));
    expect((await reset(cookiePair(second, 'cse_password_reset'))).status).toBe(200);
  });

  it('refuses a missing, invalid or session cookie, and an account deactivated meanwhile', async () => {
    const { server, reset, resetCookie } = await verified();
    expect((await reset(null)).body.error.code).toBe('INVALID_OR_EXPIRED_RESET');
    expect((await reset('cse_password_reset=garbage')).body.error.code).toBe('INVALID_OR_EXPIRED_RESET');
    const user = await prisma.user.findUniqueOrThrow({ where: { email: PROF } });
    const session = signSessionToken(user.id, user.passwordHash);
    expect((await reset(`cse_password_reset=${session}`)).body.error.code).toBe('INVALID_OR_EXPIRED_RESET');
    // The reset token is not a session either.
    const resetToken = resetCookie.split('=')[1];
    expect((await request(server).get('/api/auth/me').set('Cookie', `cse_session=${resetToken}`)).status).toBe(401);

    await prisma.professor.updateMany({ where: { userId: user.id }, data: { isActive: false } });
    expect((await reset(resetCookie)).body.error.code).toBe('INVALID_OR_EXPIRED_RESET');
  });

  it('expires the reset capability with the code', async () => {
    const { clock, reset, resetCookie } = await verified();
    clock.advance(10 * 60_000 + 1000);
    expect((await reset(resetCookie)).body.error.code).toBe('INVALID_OR_EXPIRED_RESET');
  });
});

describe('attempt budget shared across replacement codes (F2, decisions #61, #64)', () => {
  async function exhaustedWindow() {
    await createUser({ email: PROF, professor: 'active' });
    const { mailer, sent } = fakeMailer();
    const ctx = setup(mailer);
    await ctx.requestCode();
    const wrong = (code: string) => (code === '000000' ? '000001' : '000000');
    for (let i = 0; i < 5; i++) expect((await ctx.verify(wrong(codeOf(sent[0])))).status).toBe(400);
    const state = await recoveryState();
    expect(state.passwordResetAttempts).toBe(5);
    return { ...ctx, sent, exhausted: state };
  }

  it('while the budget is used up, no code is issued or sent and nothing advances; the answer is unchanged', async () => {
    const { clock, requestCode, verify, sent, exhausted } = await exhaustedWindow();
    clock.advance(61_000);
    const suppressed = await requestCode();
    const unknown = await requestCode('nobody@example.org');

    expect({ status: suppressed.status, body: suppressed.body }).toEqual({ status: unknown.status, body: unknown.body });
    expect(suppressed.status).toBe(202);
    expect(sent).toHaveLength(1); // no unusable code is sent
    expect(await recoveryState()).toEqual(exhausted); // hash, expiry, attempts, last send and count unchanged
    expect((await verify(codeOf(sent[0]))).body.error.code).toBe('INVALID_OR_EXPIRED_CODE');
  });

  it('repeated requests cannot extend the lockout: the window still ends an hour after the last real send', async () => {
    const { clock, requestCode, verify, sent, exhausted } = await exhaustedWindow();
    for (const step of [61_000, 20 * 60_000, 20 * 60_000, 18 * 60_000]) {
      clock.advance(step); // up to 59 min 1 s after the only send
      await requestCode();
    }
    expect(sent).toHaveLength(1);
    expect(await recoveryState()).toEqual(exhausted);

    // Exactly an hour after the only real send (all requests above were suppressed): a new window.
    clock.advance(exhausted.passwordResetLastSentAt!.getTime() + 60 * 60_000 - clock.now().getTime());
    expect((await requestCode()).status).toBe(202);
    expect(sent).toHaveLength(2);
    expect(await recoveryState()).toMatchObject({ passwordResetAttempts: 0, passwordResetSendCount: 1 });
    expect((await verify(codeOf(sent[1]))).status).toBe(200);
  });

  it('concurrent requests cannot bypass an exhausted budget, and after the window exactly one code is sent', async () => {
    const { clock, requestCode, sent, exhausted } = await exhaustedWindow();
    clock.advance(10 * 60_000);
    const blocked = await Promise.all(Array.from({ length: 10 }, () => requestCode()));
    expect(blocked.every((r) => r.status === 202)).toBe(true);
    expect(sent).toHaveLength(1);
    expect(await recoveryState()).toEqual(exhausted);

    clock.advance(50 * 60_000);
    await Promise.all(Array.from({ length: 10 }, () => requestCode()));
    expect(sent).toHaveLength(2);
    expect(await recoveryState()).toMatchObject({ passwordResetAttempts: 0, passwordResetSendCount: 1 });
  });

  it('a replacement code issued with attempts left carries over only the remaining attempts, also in parallel', async () => {
    await createUser({ email: PROF, professor: 'active' });
    const { mailer, sent } = fakeMailer();
    const { clock, requestCode, verify } = setup(mailer);
    await requestCode();
    const wrong = codeOf(sent[0]) === '000000' ? '000001' : '000000';
    for (let i = 0; i < 3; i++) await verify(wrong); // 3 of 5 attempts used on the first code

    clock.advance(61_000);
    await requestCode();
    expect(sent).toHaveLength(2);
    const results = await Promise.all(Array.from({ length: 10 }, () => verify(codeOf(sent[1]))));
    expect(results.filter((r) => r.status === 200)).toHaveLength(2); // only the 2 remaining attempts
    expect((await recoveryState()).passwordResetAttempts).toBe(5);
  });
});

describe('a password change ends a pending recovery (F3)', () => {
  it('a reset capability obtained before a normal password change can no longer be used', async () => {
    await createUser({ email: PROF, professor: 'active' });
    const { mailer, sent } = fakeMailer();
    const { server, requestCode, verify, reset } = setup(mailer);
    await requestCode();
    const resetCookie = cookiePair(await verify(codeOf(sent[0])), 'cse_password_reset');
    const before = await recoveryState();

    const session = cookiePair(await request(server).post('/api/auth/login').send({ email: PROF, password: PASSWORD }), 'cse_session');
    const changed = await request(server)
      .post('/api/auth/change-password')
      .set('Cookie', session)
      .send({ currentPassword: PASSWORD, newPassword: 'changed normally 123' });
    expect(changed.status).toBe(200);

    expect(await recoveryState()).toMatchObject({
      passwordResetCodeHash: null,
      passwordResetExpiresAt: null,
      passwordResetAttempts: 0,
      passwordResetSendCount: before.passwordResetSendCount, // send limits are kept
      passwordResetLastSentAt: before.passwordResetLastSentAt,
    });
    expect((await reset(resetCookie)).body.error.code).toBe('INVALID_OR_EXPIRED_RESET');
    expect((await verify(codeOf(sent[0]))).status).toBe(400);
    expect((await request(server).post('/api/auth/login').send({ email: PROF, password: 'changed normally 123' })).status).toBe(200);
  });
});

describe('unavailable or failing email', () => {
  it('without SMTP configuration, every recovery step answers 503 alike and nothing is stored', async () => {
    await createUser({ email: PROF, professor: 'active' });
    const { requestCode, verify, reset } = setup(null);
    const responses = [await requestCode(), await requestCode('nobody@example.org'), await verify('123456'), await reset(null)];
    for (const res of responses) {
      expect(res.status).toBe(503);
      expect(res.body).toEqual({ error: { code: 'RECOVERY_UNAVAILABLE', message: 'Password recovery is currently unavailable' } });
    }
    expect((await recoveryState()).passwordResetCodeHash).toBeNull();
  });

  it('a mailer that throws synchronously cannot change the public answer', async () => {
    await createUser({ email: PROF, professor: 'active' });
    const logged: string[] = [];
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => void logged.push(args.map(String).join(' ')));
    const throwsAtOnce = {
      send(message: { text: string }): Promise<void> {
        throw new Error(`immediate failure ${message.text}`);
      },
    } as Mailer;
    const { requestCode } = setup(throwsAtOnce);

    const eligible = await requestCode();
    const unknown = await requestCode('nobody@example.org');
    expect({ status: eligible.status, body: eligible.body }).toEqual({ status: unknown.status, body: unknown.body });
    expect(eligible.status).toBe(202);
    await vi.waitFor(() => expect(logged).toHaveLength(1));
    expect(logged[0]).toMatch(/^Password recovery email could not be sent for user [0-9a-f-]+ \(unknown error\)$/);
  });

  it('a delivery failure is logged without the code, the address or server text; the answer is unchanged', async () => {
    const user = await createUser({ email: PROF, professor: 'active' });
    let attempted = '';
    const failing: Mailer = {
      async send(message) {
        attempted = message.text;
        throw Object.assign(new Error(`550 mailbox ${message.to} rejected: ${message.text}`), { code: 'EENVELOPE', responseCode: 550 });
      },
    };
    const logged: string[] = [];
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => void logged.push(args.map(String).join(' ')));

    const res = await setup(failing).requestCode();
    await vi.waitFor(() => expect(logged).toHaveLength(1));

    expect(res.status).toBe(202);
    const code = codeOf({ to: PROF, subject: '', text: attempted });
    expect(logged[0]).toBe(`Password recovery email could not be sent for user ${user.id} (EENVELOPE, SMTP 550)`);
    expect(logged[0]).not.toContain(code);
    expect(logged[0]).not.toContain(PROF);
  });
});

describe('no secrets in responses or logs', () => {
  it('never exposes the code, reset token, passwords or hashes during a full recovery', async () => {
    await createUser({ email: PROF, professor: 'active' });
    const output: string[] = [];
    for (const method of ['log', 'info', 'warn', 'error', 'debug'] as const) {
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => void output.push(args.map(String).join(' ')));
    }
    const { mailer, sent } = fakeMailer();
    const { requestCode, verify, reset } = setup(mailer);

    const bodies: string[] = [];
    bodies.push(JSON.stringify((await requestCode()).body));
    const code = codeOf(sent[0]);
    const verified = await verify(code);
    bodies.push(JSON.stringify(verified.body));
    const resetCookie = cookiePair(verified, 'cse_password_reset');
    bodies.push(JSON.stringify((await reset(resetCookie)).body));

    const { passwordHash } = await prisma.user.findUniqueOrThrow({ where: { email: PROF } });
    const everything = [...bodies, ...output].join('\n');
    for (const secret of [code, resetCookie.split('=')[1], NEW_PASSWORD, PASSWORD, passwordHash]) {
      expect(everything).not.toContain(secret);
    }
  });
});
