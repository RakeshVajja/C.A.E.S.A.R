import type { UserRole } from '@prisma/client';
import type { Response } from 'supertest';
import { prisma } from '../../src/config/database';
import { hashPassword } from '../../src/services/auth/password';
import type { Mailer, MailMessage } from '../../src/services/email/mailer';

export const PASSWORD = 'correct horse battery';

export async function createUser(options: {
  email: string;
  role?: UserRole;
  password?: string;
  mustChangePassword?: boolean;
  /** 'active' / 'inactive' links a Professor record; omitted → no professor (unlinked). */
  professor?: 'active' | 'inactive';
}) {
  const user = await prisma.user.create({
    data: {
      email: options.email,
      role: options.role ?? 'PROFESSOR',
      passwordHash: await hashPassword(options.password ?? PASSWORD),
      mustChangePassword: options.mustChangePassword ?? false,
    },
  });
  if (options.professor) {
    await prisma.professor.create({ data: { name: `Prof ${options.email}`, userId: user.id, isActive: options.professor === 'active' } });
  }
  return user;
}

/** The raw Set-Cookie header for `name`, if the response sets it. */
export function setCookie(res: Response, name: string): string | undefined {
  const header = res.headers['set-cookie'] as unknown as string[] | undefined;
  return header?.find((c) => c.startsWith(`${name}=`));
}

/** "name=value" for sending the cookie back. */
export function cookiePair(res: Response, name: string): string {
  const cookie = setCookie(res, name);
  if (!cookie) throw new Error(`Response did not set ${name}`);
  return cookie.split(';')[0];
}

export function fakeMailer() {
  const sent: MailMessage[] = [];
  const mailer: Mailer = {
    async send(message) {
      sent.push(message);
    },
  };
  return { mailer, sent };
}

/** The 6-digit code of the n-th email (0-based). */
export function codeOf(message: MailMessage | undefined): string {
  const match = /\b(\d{6})\b/.exec(message?.text ?? '');
  if (!match) throw new Error('No recovery code in the email');
  return match[1];
}

/** A clock tests can move forward. */
export function testClock(start = '2026-10-13T10:00:00.000Z') {
  let current = new Date(start).getTime();
  return {
    now: () => new Date(current),
    advance(ms: number) {
      current += ms;
    },
  };
}
