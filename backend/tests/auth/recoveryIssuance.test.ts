import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { prisma } from '../../src/config/database';
import {
  requestPasswordRecovery,
  resetPasswordWithRecovery,
  verifyRecoveryCode,
} from '../../src/services/auth/passwordRecovery';
import { resetDatabase } from '../helpers/database';
import { createUser, fakeMailer, testClock } from './helpers';

/*
 * F7: a reset capability is bound to one issuance of a code, not only to its six digits. The code
 * generator is made deterministic for this file only (crypto.randomInt), so the same code can be
 * issued twice; nothing in the application is changed for the test.
 */

const fixedCode = vi.hoisted(() => ({ value: null as number | null }));

vi.mock('crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('crypto')>();
  const randomInt = (...args: unknown[]) =>
    fixedCode.value !== null ? fixedCode.value : (actual.randomInt as (...a: unknown[]) => number)(...args);
  return { ...actual, default: { ...actual, randomInt }, randomInt };
});

beforeEach(async () => {
  await resetDatabase();
  fixedCode.value = null;
});

afterAll(async () => {
  await resetDatabase();
  await prisma.$disconnect();
});

describe('reset capabilities are bound to a code issuance (F7)', () => {
  it('a capability from the first issuance is refused after the same code is issued again', async () => {
    const user = await createUser({ email: 'prof@example.org', professor: 'active' });
    const { mailer, sent } = fakeMailer();
    const clock = testClock();
    const deps = { mailer, now: clock.now };
    fixedCode.value = 123456;

    await requestPasswordRecovery('prof@example.org', deps);
    const first = await verifyRecoveryCode('prof@example.org', '123456', deps);
    const firstHash = (await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).passwordResetCodeHash;

    clock.advance(61_000);
    await requestPasswordRecovery('prof@example.org', deps);
    expect(sent.map((m) => /\d{6}/.exec(m.text)?.[0])).toEqual(['123456', '123456']);
    // Same code, same keyed hash: only the issuance distinguishes the two.
    expect((await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).passwordResetCodeHash).toBe(firstHash);

    await expect(resetPasswordWithRecovery(first.token, 'first issuance password', deps)).rejects.toMatchObject({
      code: 'INVALID_OR_EXPIRED_RESET',
    });

    const second = await verifyRecoveryCode('prof@example.org', '123456', deps);
    await expect(resetPasswordWithRecovery(second.token, 'second issuance password', deps)).resolves.toBeUndefined();
  });
});
