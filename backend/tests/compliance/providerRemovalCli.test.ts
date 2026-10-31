import { spawnSync } from 'child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs';
import os from 'os';
import path from 'path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseArgs } from '../../scripts/provider-removal';
import { prisma } from '../../src/config/database';
import { ingestPublication } from '../../src/services/matching/engine';
import { buildNormalizedPublication } from '../../src/services/normalization/normalizedPublication';
import { resetDatabase } from '../helpers/database';

/*
 * The provider-removal command line (stage 15.8, decision #124), run as a real subprocess against
 * the isolated test database (DATABASE_URL and the other test settings are inherited). Synthetic data only.
 */

vi.setConfig({ testTimeout: 90_000 });

const BACKEND = path.resolve(__dirname, '../..');
const PROVIDER_TEXT = 'SYNTHETIC-PROVIDER-CONTENT';
let dir: string;

beforeEach(async () => {
  await resetDatabase();
  dir = mkdtempSync(path.join(os.tmpdir(), 'provider-removal-test-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

afterAll(async () => {
  await resetDatabase();
  await prisma.$disconnect();
});

function runCli(args: string[]) {
  const result = spawnSync(path.join(BACKEND, 'node_modules/.bin/tsx'), ['scripts/provider-removal.ts', ...args], {
    cwd: BACKEND,
    encoding: 'utf8',
    env: process.env,
    timeout: 80_000,
  });
  return { code: result.status, stdout: result.stdout, stderr: result.stderr, output: `${result.stdout}\n${result.stderr}` };
}

function expectNothingSensitive(output: string) {
  expect(output).not.toContain(PROVIDER_TEXT);
  expect(output).not.toMatch(/postgres(ql)?:\/\//);
}

async function world() {
  const wosOnly = await ingestPublication(
    buildNormalizedPublication({ source: 'WOS', externalId: 'WOS:000000000000010', title: `${PROVIDER_TEXT} title`, typeFamily: 'JOURNAL', rawMetadata: { note: PROVIDER_TEXT } }),
  );
  const professor = await prisma.professor.create({ data: { name: 'Synthetic Professor' } });
  await prisma.professorPublication.create({ data: { professorId: professor.id, publicationId: wosOnly.publicationId, status: 'APPROVED', origin: 'DISCOVERED' } });
  const kept = await ingestPublication(buildNormalizedPublication({ source: 'OPENALEX', externalId: 'W1', title: 'Kept paper', typeFamily: 'JOURNAL' }));
  return { removed: wosOnly.publicationId, kept: kept.publicationId };
}

const fingerprintOf = (stdout: string) => /Fingerprint: ([0-9a-f]{64})/.exec(stdout)?.[1];

describe('arguments', () => {
  it('parses exclusions and refuses malformed or incomplete commands', () => {
    const id = '0b6f3d6e-8a1f-4a43-9a43-6f1c2b9d0e11';
    expect(parseArgs(['plan', '--provider', 'wos', '--exclude-curation', `${id}:title`, '--exclude-manual', id.toUpperCase()])).toMatchObject({
      command: 'plan',
      provider: 'WOS',
      exclusions: { curation: [{ publicationId: id, field: 'title' }], manualRecords: [id] },
    });
    expect(parseArgs(['execute', '--provider', 'WOS', '--fingerprint', 'a'.repeat(64), '--report', 'r.json', '--keep-legacy', `${id}:venue`, '--remove-legacy', `${id}:doi`])).toMatchObject({
      exclusions: { legacy: [{ publicationId: id, field: 'venue', decision: 'KEEP' }, { publicationId: id, field: 'doi', decision: 'REMOVE' }] },
    });
    expect(parseArgs(['plan', '--provider', 'WOS', '--keep-manual', id.toUpperCase()])).toMatchObject({ exclusions: { keepManual: [id] } });
    expect(parseArgs([])).toBe('help');
    for (const argv of [
      ['remove', '--provider', 'WOS'],
      ['plan'],
      ['plan', '--provider', 'OPENALEX'],
      ['plan', '--provider', 'WOS', '--exclude-curation', `${id}:abstract`],
      ['plan', '--provider', 'WOS', '--exclude-manual', 'not-an-id'],
      ['plan', '--provider', 'WOS', '--keep-legacy', id],
      ['plan', '--provider', 'WOS', '--keep-manual', 'not-an-id'],
      ['plan', '--provider', 'WOS', '--remove-legacy', `${id}:abstract`],
      ['plan', '--provider', 'WOS', '--fingerprint', 'a'.repeat(64)], // plans take no fingerprint
      ['execute', '--provider', 'WOS', '--report', 'r.json'],
      ['execute', '--provider', 'WOS', '--fingerprint', 'abc', '--report', 'r.json'],
      ['execute', '--provider', 'WOS', '--fingerprint', 'a'.repeat(64)], // no report
    ]) {
      expect(() => parseArgs(argv), argv.join(' ')).toThrow();
    }
  });
});

describe('plan and execute as a subprocess', () => {
  it('plans without changes, then executes only the approved plan and records it in a new owner-only report', async () => {
    const w = await world();
    const planFile = path.join(dir, 'plan.json');

    const plan = runCli(['plan', '--provider', 'WOS', '--report', planFile]);
    expect(plan.code, plan.stderr).toBe(0);
    expect(plan.stdout).toContain('Removal plan for WOS (dry run; nothing was changed).');
    expect(plan.stdout).toMatch(/publicationsDeleted\s+1/);
    expectNothingSensitive(plan.output);
    const fingerprint = fingerprintOf(plan.stdout)!;
    expect(fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(statSync(planFile).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(planFile, 'utf8'))).toMatchObject({ kind: 'PROVIDER_REMOVAL_PLAN', fingerprint });
    expectNothingSensitive(readFileSync(planFile, 'utf8'));
    expect(await prisma.publication.count()).toBe(2);

    // An existing report file is never overwritten.
    expect(runCli(['plan', '--provider', 'WOS', '--report', planFile]).stderr).toContain('already exists');

    // A wrong fingerprint changes nothing and leaves no report behind.
    const wrongReport = path.join(dir, 'wrong.json');
    const wrong = runCli(['execute', '--provider', 'WOS', '--fingerprint', 'f'.repeat(64), '--report', wrongReport]);
    expect(wrong.code).toBe(1);
    expect(wrong.stderr).toContain('PLAN_CHANGED');
    expect(existsSync(wrongReport)).toBe(false);
    expect(await prisma.publication.count()).toBe(2);

    const reportFile = path.join(dir, 'removal.json');
    const executed = runCli(['execute', '--provider', 'WOS', '--fingerprint', fingerprint, '--report', reportFile]);
    expect(executed.code, executed.stderr).toBe(0);
    expect(executed.stdout).toContain('Removed WOS data.');
    expectNothingSensitive(executed.output);
    expect(statSync(reportFile).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(reportFile, 'utf8'))).toMatchObject({ kind: 'PROVIDER_REMOVAL_EXECUTED', fingerprint, summary: { publicationsDeleted: 1, relationshipsDeleted: 1 } });
    expect(await prisma.publication.findMany({ select: { id: true } })).toEqual([{ id: w.kept }]);
    expect(await prisma.publicationSourceRecord.count({ where: { source: 'WOS' } })).toBe(0);
  });

  it('refuses to execute into an existing report file before touching the database', async () => {
    await world();
    const plan = runCli(['plan', '--provider', 'WOS']);
    const reportFile = path.join(dir, 'existing.json');
    writeFileSync(reportFile, 'keep me');
    const run = runCli(['execute', '--provider', 'WOS', '--fingerprint', fingerprintOf(plan.stdout)!, '--report', reportFile]);
    expect(run.code).toBe(1);
    expect(readFileSync(reportFile, 'utf8')).toBe('keep me');
    expect(await prisma.publication.count()).toBe(2);
  });

  it('lists legacy fields as unresolved and refuses to execute until each has a decision', async () => {
    const w = await world();
    await prisma.publication.update({ where: { id: w.removed }, data: { isCurated: true, curation: { title: { basis: 'PRE_PHASE15' } } } });

    const plan = runCli(['plan', '--provider', 'WOS']);
    expect(plan.code, plan.stderr).toBe(0);
    expect(plan.stdout).toContain(`curated title of publication ${w.removed}: UNRESOLVED`);
    expect(plan.stdout).toContain('1 unresolved: "execute" is refused');
    const reportFile = path.join(dir, 'refused.json');
    const refused = runCli(['execute', '--provider', 'WOS', '--fingerprint', fingerprintOf(plan.stdout)!, '--report', reportFile]);
    expect(refused.code).toBe(1);
    expect(refused.stderr).toContain('LEGACY_UNRESOLVED');
    expect(existsSync(reportFile)).toBe(false);
    expect(await prisma.publication.count()).toBe(2);

    const decided = runCli(['plan', '--provider', 'WOS', '--keep-legacy', `${w.removed}:title`]);
    expect(decided.stdout).toContain(`curated title of publication ${w.removed}: KEEP`);
    const executed = runCli(['execute', '--provider', 'WOS', '--fingerprint', fingerprintOf(decided.stdout)!, '--keep-legacy', `${w.removed}:title`, '--report', reportFile]);
    expect(executed.code, executed.stderr).toBe(0);
    expect(await prisma.publication.findUniqueOrThrow({ where: { id: w.removed } })).toMatchObject({ curation: { title: { basis: 'PRE_PHASE15' } } });
    expect(await prisma.publicationSourceRecord.count({ where: { source: 'WOS' } })).toBe(0);
  });

  it('lists manual entries without basis or evidence as unresolved and refuses to execute until each has a decision', async () => {
    const w = await world();
    const manual = await prisma.publicationSourceRecord.create({
      data: { publicationId: w.removed, source: 'MANUAL', externalId: '00000000-0000-4000-8000-000000000999', title: 'Manual copy', normalizedTitle: 'manual copy', typeFamily: 'JOURNAL', matchMethod: 'TITLE_YEAR' },
    });

    const plan = runCli(['plan', '--provider', 'WOS']);
    expect(plan.code, plan.stderr).toBe(0);
    expect(plan.stdout).toContain(`manual entry ${manual.id} (publication ${w.removed}): basis (none), evidence (none) — UNRESOLVED`);
    const reportFile = path.join(dir, 'refused.json');
    const refused = runCli(['execute', '--provider', 'WOS', '--fingerprint', fingerprintOf(plan.stdout)!, '--report', reportFile]);
    expect(refused.code).toBe(1);
    expect(refused.stderr).toContain('LEGACY_UNRESOLVED');
    expect(existsSync(reportFile)).toBe(false);

    const decided = runCli(['plan', '--provider', 'WOS', '--keep-manual', manual.id]);
    expect(decided.stdout).toContain('— KEEP');
    const executed = runCli(['execute', '--provider', 'WOS', '--fingerprint', fingerprintOf(decided.stdout)!, '--keep-manual', manual.id, '--report', reportFile]);
    expect(executed.code, executed.stderr).toBe(0);
    expect(await prisma.publicationSourceRecord.findMany({ where: { publicationId: w.removed }, select: { id: true } })).toEqual([{ id: manual.id }]);
  });
});
