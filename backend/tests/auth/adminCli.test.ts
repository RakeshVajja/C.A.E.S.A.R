import { spawnSync } from 'child_process';
import path from 'path';
import { PassThrough, Readable } from 'stream';
import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseArgs } from '../../scripts/admin-account';
import { InputCancelled, readHidden, readPasswordFromStdin } from '../../scripts/lib/secretInput';
import { createApp } from '../../src/app';
import { prisma } from '../../src/config/database';
import { resetDatabase } from '../helpers/database';
import { cookiePair, createUser, PASSWORD } from './helpers';

/*
 * The admin command-line utility (Project_plan.md §15.4, decision #56), run as a real subprocess
 * against the isolated test database (DATABASE_URL and the other test settings are inherited).
 */

vi.setConfig({ testTimeout: 60_000 });

beforeEach(async () => {
  await resetDatabase();
});

afterAll(async () => {
  await resetDatabase();
  await prisma.$disconnect();
});

const BACKEND = path.resolve(__dirname, '../..');
const ADMIN = 'admin@example.org';
const NEW_PASSWORD = 'a fresh admin password';

function runCli(args: string[], input?: string, env: Record<string, string> = {}) {
  const result = spawnSync(path.join(BACKEND, 'node_modules/.bin/tsx'), ['scripts/admin-account.ts', ...args], {
    cwd: BACKEND,
    input: input ?? '',
    encoding: 'utf8',
    env: { ...process.env, ...env },
    timeout: 50_000,
  });
  return { code: result.status, stdout: result.stdout, stderr: result.stderr, output: `${result.stdout}\n${result.stderr}` };
}

const stdinArgs = (command: string[], confirm = ADMIN) => [...command, '--password-stdin', '--confirm', confirm];
const adminHash = async () => (await prisma.user.findUniqueOrThrow({ where: { email: ADMIN } })).passwordHash;

function expectNoSecrets(output: string, ...secrets: string[]) {
  for (const secret of secrets) expect(output).not.toContain(secret);
  expect(output).not.toMatch(/\$2[aby]\$/); // no bcrypt hash
  expect(output).not.toMatch(/postgres(ql)?:\/\//); // no database URL
}

describe('admin-account create', () => {
  it('creates the single admin from a piped password and is idempotent', async () => {
    const run = runCli(stdinArgs(['create', '--email', ' Admin@Example.org ']), `${NEW_PASSWORD}\n`);
    expect(run.code).toBe(0);
    expect(run.stdout).toContain(`Admin account created: ${ADMIN}`);
    expectNoSecrets(run.output, NEW_PASSWORD);

    const admin = await prisma.user.findUniqueOrThrow({ where: { email: ADMIN } });
    expect(admin).toMatchObject({ role: 'ADMIN', mustChangePassword: false });
    expect(admin.passwordHash).toMatch(/^\$2[aby]\$/);
    const login = await request(createApp({ mailer: null })).post('/api/auth/login').send({ email: ADMIN, password: NEW_PASSWORD });
    expect(login.status).toBe(200);

    const again = runCli(stdinArgs(['create', '--email', ADMIN]), 'another password value\n');
    expect(again.code).toBe(0);
    expect(again.stdout).toContain('already exists; nothing changed');
    expect(await adminHash()).toBe(admin.passwordHash);
  });

  it('refuses a second admin and an email that belongs to another account', async () => {
    await createUser({ email: ADMIN, role: 'ADMIN' });
    await createUser({ email: 'prof@example.org' });
    const second = runCli(stdinArgs(['create', '--email', 'other@example.org'], 'other@example.org'), `${NEW_PASSWORD}\n`);
    expect(second.code).toBe(1);
    expect(second.stderr).toContain('An admin account already exists');
    expect(await prisma.user.count({ where: { role: 'ADMIN' } })).toBe(1);

    await prisma.user.deleteMany({ where: { role: 'ADMIN' } });
    const taken = runCli(stdinArgs(['create', '--email', 'prof@example.org'], 'prof@example.org'), `${NEW_PASSWORD}\n`);
    expect(taken.code).toBe(1);
    expect(taken.stderr).toContain('already belongs to a non-admin account');
  });
});

describe('admin-account reset-password', () => {
  it('resets the password and ends existing admin sessions', async () => {
    await createUser({ email: ADMIN, role: 'ADMIN' });
    const server = createApp({ mailer: null });
    const session = cookiePair(await request(server).post('/api/auth/login').send({ email: ADMIN, password: PASSWORD }), 'cse_session');
    expect((await request(server).get('/api/auth/me').set('Cookie', session)).status).toBe(200);

    const run = runCli(stdinArgs(['reset-password']), `${NEW_PASSWORD}\r\n`);
    expect(run.code).toBe(0);
    expect(run.stdout).toContain(`Password updated for ${ADMIN}. Existing admin sessions are no longer valid.`);
    expectNoSecrets(run.output, NEW_PASSWORD, PASSWORD);

    expect((await request(server).get('/api/auth/me').set('Cookie', session)).status).toBe(401);
    expect((await request(server).post('/api/auth/login').send({ email: ADMIN, password: NEW_PASSWORD })).status).toBe(200);
  });

  it('clears any recovery state on the admin row, keeping send limits (F3); admins still cannot use email recovery', async () => {
    const admin = await createUser({ email: ADMIN, role: 'ADMIN' });
    const sentAt = new Date('2026-10-13T10:00:00.000Z');
    await prisma.user.update({
      where: { id: admin.id },
      data: {
        passwordResetCodeHash: 'f'.repeat(64),
        passwordResetExpiresAt: new Date(Date.now() + 600_000),
        passwordResetAttempts: 2,
        passwordResetLastSentAt: sentAt,
        passwordResetSendCount: 1,
      },
    });

    expect(runCli(stdinArgs(['reset-password']), `${NEW_PASSWORD}\n`).code).toBe(0);
    expect(await prisma.user.findUniqueOrThrow({ where: { id: admin.id } })).toMatchObject({
      passwordResetCodeHash: null,
      passwordResetExpiresAt: null,
      passwordResetAttempts: 0,
      passwordResetLastSentAt: sentAt,
      passwordResetSendCount: 1,
    });
  });

  it('refuses when there is no admin, or more than one', async () => {
    const none = runCli(stdinArgs(['reset-password']), `${NEW_PASSWORD}\n`);
    expect(none.code).toBe(1);
    expect(none.stderr).toContain('No admin account exists');

    await createUser({ email: ADMIN, role: 'ADMIN' });
    await createUser({ email: 'second-admin@example.org', role: 'ADMIN' });
    const before = await adminHash();
    const many = runCli(stdinArgs(['reset-password']), `${NEW_PASSWORD}\n`);
    expect(many.code).toBe(1);
    expect(many.stderr).toContain('2 admin accounts exist, but exactly one is expected');
    expect(await adminHash()).toBe(before);
  });

  it('cancels on a wrong confirmation and refuses policy violations, changing nothing', async () => {
    await createUser({ email: ADMIN, role: 'ADMIN' });
    const before = await adminHash();

    const wrong = runCli(stdinArgs(['reset-password'], 'someone@example.org'), `${NEW_PASSWORD}\n`);
    expect(wrong.code).toBe(2);
    expect(wrong.stderr).toContain('Confirmation did not match');

    const short = runCli(stdinArgs(['reset-password']), 'short\n');
    expect(short.code).toBe(1);
    expect(short.stderr).toContain('at least 10 characters');

    const reused = runCli(stdinArgs(['reset-password']), `${PASSWORD}\n`);
    expect(reused.code).toBe(1);
    expect(reused.stderr).toContain('must differ from the current password');
    expectNoSecrets(reused.output, PASSWORD);

    expect(await adminHash()).toBe(before);
  });
});

describe('admin-account input safety', () => {
  it('never accepts a password as an argument and never echoes unexpected arguments', async () => {
    for (const args of [
      ['reset-password', '--password=hunter2hunter2'],
      ['reset-password', '--password', 'hunter2hunter2'],
      ['create', '--email', ADMIN, '--admin-pass', 'hunter2hunter2'],
    ]) {
      const run = runCli(args);
      expect(run.code).toBe(1);
      expect(run.stderr).toContain('Passwords are never accepted as command-line arguments');
      expect(run.output).not.toContain('hunter2hunter2');
    }
    const positional = runCli(['reset-password', 'hunter2hunter2']);
    expect(positional.code).toBe(1);
    expect(positional.stderr).toContain('Unexpected argument (not shown)');
    expect(positional.output).not.toContain('hunter2hunter2');
  });

  it('refuses without a terminal unless --password-stdin is used, and requires --confirm with it', async () => {
    await createUser({ email: ADMIN, role: 'ADMIN' });
    const noTty = runCli(['reset-password', '--confirm', ADMIN], `${NEW_PASSWORD}\n`);
    expect(noTty.code).toBe(1);
    expect(noTty.stderr).toContain('No terminal for the hidden prompt');

    const noConfirm = runCli(['reset-password', '--password-stdin'], `${NEW_PASSWORD}\n`);
    expect(noConfirm.code).toBe(1);
    expect(noConfirm.stderr).toContain('--password-stdin needs --confirm');
  });

  it('reports invalid configuration and database failures without secrets', async () => {
    const badSecret = runCli(['reset-password'], '', { JWT_SECRET: 'too-short-secret-value' });
    expect(badSecret.code).toBe(1);
    expect(badSecret.stderr).toContain('JWT_SECRET must be at least 32 characters');
    expect(badSecret.output).not.toContain('too-short-secret-value');

    const unreachable = 'postgresql://cli_user:db-password-xyz@127.0.0.1:1/unreachable_test';
    const noDb = runCli(stdinArgs(['reset-password']), `${NEW_PASSWORD}\n`, { DATABASE_URL: unreachable });
    expect(noDb.code).toBe(1);
    expect(noDb.stderr).toContain('Database operation failed');
    expectNoSecrets(noDb.output, 'db-password-xyz', NEW_PASSWORD);
  });
});

describe('secret input helpers', () => {
  function fakeTty() {
    return Object.assign(new PassThrough(), { isTTY: true, setRawMode: vi.fn((mode: boolean) => mode) });
  }

  it('reads a hidden line in raw mode without echoing it; backspace edits', async () => {
    const input = fakeTty();
    const output = new PassThrough();
    let echoed = '';
    output.on('data', (chunk: Buffer) => (echoed += chunk.toString()));

    const pending = readHidden('Password: ', input, output);
    input.write('secret pass\u007fS');
    input.write('\r');
    expect(await pending).toBe('secret pasS');
    expect(echoed).toBe('Password: \n');
    expect(input.setRawMode.mock.calls).toEqual([[true], [false]]);
  });

  it('cancels on Ctrl-C and restores the terminal', async () => {
    const input = fakeTty();
    const pending = readHidden('Password: ', input, new PassThrough());
    input.write('abc\u0003');
    await expect(pending).rejects.toBeInstanceOf(InputCancelled);
    expect(input.setRawMode).toHaveBeenLastCalledWith(false);
  });

  it('reads one piped line, removing only the final line break', async () => {
    expect(await readPasswordFromStdin(Readable.from([' spaced pass  \n']))).toBe(' spaced pass  ');
    expect(await readPasswordFromStdin(Readable.from(['crlf password\r\n']))).toBe('crlf password');
    await expect(readPasswordFromStdin(Readable.from(['two\nlines\n']))).rejects.toThrow('single line');
    await expect(readPasswordFromStdin(Readable.from(['']))).rejects.toThrow('No password');
    await expect(readPasswordFromStdin(Object.assign(Readable.from(['x']), { isTTY: true }))).rejects.toThrow('piped in');
  });

  it('parses arguments', () => {
    expect(parseArgs(['create', '--email=a@b.org'])).toEqual({ command: 'create', email: 'a@b.org', confirm: null, passwordStdin: false });
    expect(parseArgs(['help'])).toBe('help');
    expect(() => parseArgs(['create'])).toThrow('--email');
    expect(() => parseArgs(['reset-password', '--email', 'a@b.org'])).toThrow('Unexpected argument');
    expect(() => parseArgs(['drop-tables'])).toThrow('Unknown command (not shown)');
  });
});
