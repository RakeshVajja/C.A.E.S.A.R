/**
 * Provider-data removal (Project_plan.md §13.10, §22.4; decision #124). Administrator command line
 * only; there is no HTTP endpoint.
 *
 *   npm run provider-removal -- plan    --provider WOS [exclusions] [--report plan.json]
 *   npm run provider-removal -- execute --provider WOS --fingerprint <hex> [exclusions] --report removal.json
 *
 *   exclusions: --exclude-curation <publicationId>:<field>   (repeatable; INDEPENDENT curated values)
 *               --exclude-manual <sourceRecordId>             (repeatable; manual entries)
 *   decisions:  --keep-legacy <publicationId>:<field>         (repeatable; fields edited before basis
 *               --remove-legacy <publicationId>:<field>        recording — each needs one, #145)
 *               --keep-manual <sourceRecordId>                (repeatable; a manual entry without basis or
 *                                                               evidence is kept only with this, or removed
 *                                                               with --exclude-manual — each needs one, #146)
 *
 * `plan` is read-only: it prints a summary, the values listed for review and the plan fingerprint.
 * `execute` removes the data in one transaction only when the plan — rebuilt inside it, with the
 * same exclusions — still has that fingerprint. Reports hold IDs and counts, never provider content;
 * the execution report must be kept with the database backups (re-applied after any restore).
 * Nothing here prints the database URL or credentials.
 *
 * Exit codes: 0 done, 1 refused or failed.
 */
import { rmSync, writeFileSync } from 'fs';
import type { PrismaClient } from '@prisma/client';
import type { RemovableProvider, RemovalExclusions, RemovalReport } from '../src/services/compliance/providerRemoval';
import { CURATED_FIELDS, CuratedField } from '../src/services/publications/curation';

const PROVIDERS: readonly RemovableProvider[] = ['SCOPUS', 'WOS', 'JCR'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const USAGE = `Usage:
  npm run provider-removal -- plan    --provider <SCOPUS|WOS|JCR> [exclusions] [--report <new file>]
  npm run provider-removal -- execute --provider <SCOPUS|WOS|JCR> --fingerprint <hex> [exclusions] --report <new file>

Exclusions (repeatable, identical for plan and execute):
  --exclude-curation <publicationId>:<field>   do not retain this INDEPENDENT curated value
  --exclude-manual <sourceRecordId>            do not retain this manual entry

Decisions (one per field edited before basis recording that the plan lists; identical for plan and execute):
  --keep-legacy <publicationId>:<field>        keep this value of unknown provenance
  --remove-legacy <publicationId>:<field>      remove it (the field is recomputed from the remaining sources)
  --keep-manual <sourceRecordId>               keep a manual entry without basis or evidence
                                               (remove it with --exclude-manual)

"plan" changes nothing. "execute" runs only if every listed field has a decision and the plan is
unchanged since it was reviewed.`;

class UsageError extends Error {}

interface Args {
  command: 'plan' | 'execute';
  provider: RemovableProvider;
  fingerprint: string | null;
  report: string | null;
  exclusions: RemovalExclusions;
}

export function parseArgs(argv: readonly string[]): Args | 'help' {
  const [command, ...rest] = argv;
  if (command === undefined || command === 'help' || command === '--help' || command === '-h') return 'help';
  if (command !== 'plan' && command !== 'execute') throw new UsageError('Unknown command; use "plan" or "execute"');

  let provider: string | null = null;
  const args: Omit<Args, 'provider'> = { command, fingerprint: null, report: null, exclusions: { curation: [], manualRecords: [], legacy: [], keepManual: [] } };
  for (let i = 0; i < rest.length; i++) {
    const flag = rest[i];
    const value = () => {
      const v = rest[++i];
      if (v === undefined || v === '' || v.startsWith('--')) throw new UsageError(`${flag} needs a value`);
      return v;
    };
    if (flag === '--provider') provider = value().toUpperCase();
    else if (flag === '--fingerprint' && command === 'execute') args.fingerprint = value().toLowerCase();
    else if (flag === '--report') args.report = value();
    else if (flag === '--exclude-curation') args.exclusions.curation.push(curatedField(flag, value()));
    else if (flag === '--keep-legacy') args.exclusions.legacy!.push({ ...curatedField(flag, value()), decision: 'KEEP' });
    else if (flag === '--remove-legacy') args.exclusions.legacy!.push({ ...curatedField(flag, value()), decision: 'REMOVE' });
    else if (flag === '--exclude-manual') {
      const v = value();
      if (!UUID.test(v)) throw new UsageError('--exclude-manual expects a source record ID');
      args.exclusions.manualRecords.push(v.toLowerCase());
    } else if (flag === '--keep-manual') {
      const v = value();
      if (!UUID.test(v)) throw new UsageError('--keep-manual expects a source record ID');
      args.exclusions.keepManual!.push(v.toLowerCase());
    } else throw new UsageError(`Unexpected argument ${JSON.stringify(flag.slice(0, 40))}. Run "npm run provider-removal -- help" for usage.`);
  }
  if (!provider || !(PROVIDERS as readonly string[]).includes(provider)) throw new UsageError('--provider must be SCOPUS, WOS or JCR');
  if (command === 'execute' && !/^[0-9a-f]{64}$/.test(args.fingerprint ?? '')) throw new UsageError('execute needs --fingerprint <64 hex characters> from the reviewed plan');
  if (command === 'execute' && !args.report) throw new UsageError('execute needs --report <new file>: the execution report must be kept with the backups');
  return { ...args, provider: provider as RemovableProvider };
}

/** `<publicationId>:<field>` of a curated value. */
function curatedField(flag: string, v: string): { publicationId: string; field: CuratedField } {
  const at = v.lastIndexOf(':');
  const publicationId = v.slice(0, at);
  const field = v.slice(at + 1);
  if (at < 0 || !UUID.test(publicationId) || !(CURATED_FIELDS as readonly string[]).includes(field)) {
    throw new UsageError(`${flag} expects <publicationId>:<field>, field one of ${CURATED_FIELDS.join(', ')}`);
  }
  return { publicationId: publicationId.toLowerCase(), field: field as CuratedField };
}

interface Io {
  stdout: NodeJS.WritableStream;
  stderr: NodeJS.WritableStream;
}

export async function main(argv: readonly string[], io: Io = process): Promise<number> {
  const out = (line = '') => io.stdout.write(`${line}\n`);
  const fail = (line: string) => {
    io.stderr.write(`Error: ${line}\n`);
    return 1;
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

  let prisma: PrismaClient;
  let removal: typeof import('../src/services/compliance/providerRemoval');
  try {
    prisma = (await import('../src/config/database')).prisma;
    removal = await import('../src/services/compliance/providerRemoval');
  } catch (error) {
    return fail(error instanceof Error && error.message.startsWith('Invalid environment configuration') ? error.message : 'Configuration could not be loaded');
  }

  let reserved = false;
  try {
    // The report file is created (empty, owner-only) before anything runs, so a removal can never
    // complete without a place to record it.
    if (args.report) {
      reserveReport(args.report);
      reserved = true;
    }
    const options = { client: prisma, now: () => new Date() };
    const report =
      args.command === 'plan'
        ? await removal.planProviderRemoval(args.provider, args.exclusions, options)
        : await removal.executeProviderRemoval(args.provider, args.exclusions, args.fingerprint!, options);
    if (args.report) {
      reserved = false;
      writeFileSync(args.report, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
    }
    printReport(report, out);
    if (args.report) out(`Report written to ${args.report}`);
    return 0;
  } catch (error) {
    if (reserved) rmSync(args.report!, { force: true });
    if (error instanceof removal.RemovalError) return fail(`${error.code}: ${error.message}`);
    if (error instanceof UsageError) return fail(error.message);
    return fail(describeFailure(error));
  } finally {
    await prisma.$disconnect().catch(() => undefined);
  }
}

/** Creates the new, empty report file, readable by its owner only; an existing file is never overwritten. */
function reserveReport(path: string) {
  try {
    writeFileSync(path, '', { flag: 'wx', mode: 0o600 });
  } catch (error) {
    const code = (error as { code?: string }).code;
    throw new UsageError(code === 'EEXIST' ? `The report file ${path} already exists; choose a new file` : `The report file ${path} could not be written (${code ?? 'error'})`);
  }
}

function printReport(report: RemovalReport, out: (line?: string) => void) {
  const executed = report.kind === 'PROVIDER_REMOVAL_EXECUTED';
  out(executed ? `Removed ${report.provider} data.` : `Removal plan for ${report.provider} (dry run; nothing was changed).`);
  out();
  for (const [key, value] of Object.entries(report.summary)) out(`  ${key.padEnd(26)} ${value}`);
  if (executed && report.recomputedForReleasedDoi?.length) out(`  ${'releasedDoiRecomputed'.padEnd(26)} ${report.recomputedForReleasedDoi.length}`);
  if (!executed) {
    const { curationReview, manualReview, legacyReview, unknownManualReview } = report.plan;
    if (unknownManualReview.length) {
      out();
      out('Manual entries without basis or evidence (unknown provenance) — each needs --keep-manual or --exclude-manual:');
      for (const m of unknownManualReview) {
        out(`  manual entry ${m.recordId} (publication ${m.publicationId}): basis ${m.basis ?? '(none)'}, evidence ${m.evidence ?? '(none)'} — ${m.decision ?? 'UNRESOLVED'}`);
      }
      const unresolved = unknownManualReview.filter((m) => m.decision === null).length;
      if (unresolved) out(`  ${unresolved} unresolved: "execute" is refused until every entry has a decision (re-run "plan" with them).`);
    }
    if (legacyReview.length) {
      out();
      out('Edited before basis recording (unknown provenance) — each needs --keep-legacy or --remove-legacy:');
      for (const l of legacyReview) out(`  curated ${l.field} of publication ${l.publicationId}: ${l.decision ?? 'UNRESOLVED'}`);
      const unresolved = legacyReview.filter((l) => l.decision === null).length;
      if (unresolved) out(`  ${unresolved} unresolved: "execute" is refused until every field has a decision (re-run "plan" with them).`);
    }
    if (curationReview.length || manualReview.length) {
      out();
      out('Retained unless excluded — review the evidence (retention remains subject to Clarivate\'s written confirmation):');
      for (const c of curationReview) out(`  curated ${c.field} of publication ${c.publicationId}: INDEPENDENT — evidence: ${c.evidence ?? '(none)'}`);
      for (const m of manualReview) out(`  manual entry ${m.recordId} (publication ${m.publicationId}): ${m.basis ?? 'no basis recorded'} — evidence: ${m.evidence ?? '(none)'}`);
    }
    out();
    out(`Fingerprint: ${report.fingerprint}`);
    out('To execute this exact plan, run "execute" with this fingerprint, the same exclusions and decisions, and a new --report file.');
  }
  out();
  for (const note of report.notes) out(`Note: ${note}`);
}

/** A failure description without secrets (no connection strings, values or stack traces). */
function describeFailure(error: unknown): string {
  const name = (error as { constructor?: { name?: string } })?.constructor?.name ?? '';
  const code = (error as { errorCode?: unknown; code?: unknown })?.errorCode ?? (error as { code?: unknown })?.code;
  if (name.startsWith('PrismaClient')) {
    return `Database operation failed${typeof code === 'string' ? ` (Prisma ${code})` : ''}; nothing was removed. Check DATABASE_URL and that PostgreSQL is running and migrated`;
  }
  return 'Unexpected failure; nothing was removed or printed for safety';
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
