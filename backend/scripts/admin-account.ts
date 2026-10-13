/**
 * Administrator account utility (Project_plan.md §15.2, §15.4, decision #56). The only way to
 * create the admin account or recover its password; there is no HTTP endpoint for either.
 *
 *   npm run admin -- create --email admin@example.org
 *   npm run admin -- reset-password
 *
 * Passwords are typed at a hidden prompt (twice) — or, for automation, piped in with
 * --password-stdin together with --confirm <admin email>. They are never accepted as arguments
 * and never printed; neither are hashes, tokens or the database URL.
 *
 * Exit codes: 0 done (or nothing to do), 1 refused or failed, 2 cancelled.
 */
import type { PrismaClient } from '@prisma/client';
import { InputCancelled, RawTtyInput, readHidden, readLine, readPasswordFromStdin } from './lib/secretInput';

type Command = 'create' | 'reset-password';

interface Args {
  command: Command;
  email: string | null;
  confirm: string | null;
  passwordStdin: boolean;
}

const USAGE = `Usage:
  npm run admin -- create --email <admin email> [--password-stdin --confirm <admin email>]
  npm run admin -- reset-password [--password-stdin --confirm <admin email>]

Passwords are entered at a hidden prompt, or piped to standard input with --password-stdin.
They are never accepted as command-line arguments.`;

class UsageError extends Error {}

export function parseArgs(argv: readonly string[]): Args | 'help' {
  const [command, ...rest] = argv;
  if (command === undefined || command === 'help' || command === '--help' || command === '-h') return 'help';
  if (command !== 'create' && command !== 'reset-password') throw new UsageError('Unknown command (not shown); use "create" or "reset-password"');

  const args: Args = { command, email: null, confirm: null, passwordStdin: false };
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    const [flag, inline] = arg.startsWith('--') && arg.includes('=') ? [arg.slice(0, arg.indexOf('=')), arg.slice(arg.indexOf('=') + 1)] : [arg, undefined];
    const value = () => {
      const v = inline ?? rest[++i];
      if (v === undefined || v === '') throw new UsageError(`${flag} needs a value`);
      return v;
    };
    if (flag === '--password-stdin' && inline === undefined) args.passwordStdin = true;
    else if (flag === '--email' && command === 'create') args.email = value();
    else if (flag === '--confirm') args.confirm = value();
    else if (/pass|pwd|secret/i.test(flag)) {
      throw new UsageError(
        'Passwords are never accepted as command-line arguments (they would appear in shell history and process lists). ' +
          'Use the hidden prompt, or pipe the password in with --password-stdin.',
      );
    }
    // Never echo an unexpected argument: it could be a password typed in the wrong place.
    else throw new UsageError('Unexpected argument (not shown). Run "npm run admin -- help" for usage.');
  }
  if (command === 'create' && !args.email) throw new UsageError('create needs --email <admin email>');
  if (args.passwordStdin && !args.confirm) throw new UsageError('--password-stdin needs --confirm <admin email>');
  return args;
}

interface Io {
  stdin: NodeJS.ReadStream;
  stdout: NodeJS.WriteStream;
  stderr: NodeJS.WriteStream;
}

export async function main(argv: readonly string[], io: Io = process): Promise<number> {
  const out = (line: string) => io.stdout.write(`${line}\n`);
  const fail = (line: string, code = 1) => {
    io.stderr.write(`Error: ${line}\n`);
    return code;
  };

  let args: Args | 'help';
  try {
    args = parseArgs(argv);
  } catch (error) {
    if (error instanceof UsageError) return fail(error.message);
    throw error;
  }
  if (args === 'help') {
    out(USAGE);
    return 0;
  }

  // Configuration is loaded only now, so that invalid settings are reported as a clean error.
  let prisma: PrismaClient;
  let admin: typeof import('../src/services/auth/adminAccount');
  try {
    prisma = (await import('../src/config/database')).prisma;
    admin = await import('../src/services/auth/adminAccount');
  } catch (error) {
    const message = error instanceof Error && error.message.startsWith('Invalid environment configuration') ? error.message : 'Configuration could not be loaded';
    return fail(message);
  }

  try {
    const target = await resolveTarget(prisma, admin, args);
    if (target === 'exists') {
      out(`The admin account ${args.email} already exists; nothing changed. Use "reset-password" to change its password.`);
      return 0;
    }
    out(args.command === 'create' ? `Creating the admin account ${target}.` : `Admin account: ${target}`);

    // Confirm the target identity before any credential changes.
    const typed = args.confirm ?? (await readLine(`Type the admin email address to confirm: `, io.stdin, io.stdout));
    if (!admin.emailsMatch(target, typed)) return fail('Confirmation did not match the admin email address; nothing changed', 2);

    const password = await readNewPassword(args, io);
    admin.checkPasswordPolicy(password);

    if (args.command === 'create') {
      const result = await admin.createAdmin(prisma, target, password);
      out(result === 'created' ? `Admin account created: ${target}` : `The admin account ${target} already exists; nothing changed.`);
    } else {
      await admin.resetAdminPassword(prisma, await admin.findSingleAdmin(prisma), password);
      out(`Password updated for ${target}. Existing admin sessions are no longer valid.`);
    }
    return 0;
  } catch (error) {
    if (error instanceof InputCancelled) return fail('Cancelled; nothing changed', 2);
    if (error instanceof admin.AdminAccountError) return fail(error.message, error.exitCode);
    return fail(describeFailure(error));
  } finally {
    await prisma.$disconnect().catch(() => undefined);
  }
}

async function resolveTarget(
  prisma: PrismaClient,
  admin: typeof import('../src/services/auth/adminAccount'),
  args: Args,
): Promise<string | 'exists'> {
  if (args.command === 'reset-password') return (await admin.findSingleAdmin(prisma)).email;

  const email = admin.parseAdminEmail(args.email!);
  const admins = await prisma.user.findMany({ where: { role: 'ADMIN' }, select: { email: true } });
  if (admins.length === 1 && admins[0].email === email) return 'exists';
  if (admins.length > 0) throw new admin.AdminAccountError('An admin account already exists; use the "reset-password" command instead');
  return email;
}

async function readNewPassword(args: Args, io: Io): Promise<string> {
  if (args.passwordStdin) return readPasswordFromStdin(io.stdin);
  if (!io.stdin.isTTY) {
    throw new UsageError('No terminal for the hidden prompt; pipe the password with --password-stdin and --confirm');
  }
  const first = await readHidden('New admin password (hidden): ', io.stdin as unknown as RawTtyInput, io.stdout);
  const second = await readHidden('Repeat the password: ', io.stdin as unknown as RawTtyInput, io.stdout);
  if (first !== second) throw new UsageError('The passwords did not match; nothing changed');
  return first;
}

/** A failure description without secrets (no connection strings, values or stack traces). */
function describeFailure(error: unknown): string {
  if (error instanceof UsageError) return error.message;
  const name = (error as { constructor?: { name?: string } })?.constructor?.name ?? '';
  const code = (error as { errorCode?: unknown; code?: unknown })?.errorCode ?? (error as { code?: unknown })?.code;
  if (name.startsWith('PrismaClient')) {
    return `Database operation failed${typeof code === 'string' ? ` (Prisma ${code})` : ''}; check DATABASE_URL and that PostgreSQL is running and migrated`;
  }
  if (error instanceof Error && /^(--password-stdin|No password)/.test(error.message)) return error.message;
  return 'Unexpected failure; nothing was printed for safety';
}

if (require.main === module) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    () => {
      process.stderr.write('Error: Unexpected failure; nothing was printed for safety\n');
      process.exitCode = 1;
    },
  );
}
