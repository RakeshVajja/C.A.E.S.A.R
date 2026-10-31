import cron from 'node-cron';
import request from 'supertest';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../../src/app';
import { prisma } from '../../src/config/database';
import { DEFAULT_SYNC_CRON, DEFAULT_SYNC_TIMEZONE } from '../../src/config/env';
import { DblpClient } from '../../src/integrations/dblp/client';
import { OPENALEX_BASE_URL, OpenAlexClient } from '../../src/integrations/openalex/client';
import { ORCID_API_BASE_URL, OrcidClient } from '../../src/integrations/orcid/client';
import { ingestDiscoveredRecords } from '../../src/services/discovery/ingestDiscoveredRecords';
import { addManualPublication } from '../../src/services/manual/manualPublications';
import { runScheduledSync, startSyncScheduler } from '../../src/services/sync/scheduler';
import { recoverInterruptedRuns, SyncClients, SyncService } from '../../src/services/sync/syncService';
import { cookiePair, createUser, PASSWORD, testClock } from '../auth/helpers';
import { resetDatabase } from '../helpers/database';
import { loadFixture, noSleep, replayFetch, Route, toResponse } from '../helpers/fixtures';
import { adminCookie, tableCounts } from '../professors/helpers';
import { allProvidersPresent, noLicensedProviders } from '../helpers/providers';
import type { ProviderConfiguration } from '../../src/services/providers/providerStatus';

/* Synchronization (Project_plan.md §14; Phase 12). Recorded fixtures only — no network. */

vi.setConfig({ testTimeout: 60_000 });

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

const PRIEM = 'A5023888391'; // recorded OpenAlex author: 67 works over three pages of 25
const VARDI_ORCID = '0000-0002-0661-5773'; // recorded ORCID record: 8 summaries, 3 without a title
const PIWOWAR_ORCID = '0000-0003-1613-5981';
const T1 = '2026-11-01T02:00:00.000Z';
const T2 = '2026-12-01T02:00:00.000Z';

const openAlexPages = ['works-page-1', 'works-page-2', 'works-page-3'].map((n) => loadFixture('openalex', n));
const html200 = () => new Response('<!DOCTYPE html><html>Just a moment...</html>', { status: 200, headers: { 'content-type': 'text/html' } });

/** Source clients replaying recorded responses; `overrides` inject failures by request URL. */
function syncClients(overrides: Record<string, Route> = {}): SyncClients {
  const recorded = [
    loadFixture('openalex', 'author-valid'),
    ...openAlexPages,
    ...['identity-person', 'records-person', 'authors-person'].map((n) => loadFixture('dblp', n)),
    ...['works-vardi', 'works-piwowar', 'works-not-found', 'works-deactivated'].map((n) => loadFixture('orcid', n)),
  ];
  const deps = { fetchImpl: replayFetch(recorded, overrides).fetchImpl, sleep: noSleep };
  return {
    openAlex: new OpenAlexClient({ perPage: 25, deps, http: { maxRetries: 2 } }),
    dblp: new DblpClient({ deps, http: { maxRetries: 2 } }),
    orcid: new OrcidClient({ deps, http: { maxRetries: 2 } }),
  };
}

async function world() {
  const a = await prisma.professor.create({ data: { name: 'Prof A' } });
  const inactiveProf = await prisma.professor.create({ data: { name: 'Prof Inactive', isActive: false } });
  const openAlex = await prisma.externalIdentity.create({ data: { professorId: a.id, source: 'OPENALEX', externalId: PRIEM } });
  const orcid = await prisma.externalIdentity.create({ data: { professorId: a.id, source: 'ORCID', externalId: VARDI_ORCID } });
  const inactiveIdentity = await prisma.externalIdentity.create({ data: { professorId: a.id, source: 'DBLP', externalId: 'v/MosheYVardi', isActive: false } });
  const ofInactiveProf = await prisma.externalIdentity.create({ data: { professorId: inactiveProf.id, source: 'ORCID', externalId: PIWOWAR_ORCID } });
  return { a, openAlex, orcid, inactiveIdentity, ofInactiveProf };
}

function service(overrides: Record<string, Route> = {}, now = testClock(T1).now, providers: ProviderConfiguration = allProvidersPresent()) {
  return new SyncService({ clients: syncClients(overrides), now, providers });
}

async function runToEnd(sync: SyncService, trigger: 'MANUAL' | 'SCHEDULED' = 'MANUAL', by: string | null = null) {
  const run = await sync.start(trigger, by);
  await sync.idle();
  return prisma.syncRun.findUniqueOrThrow({ where: { id: run.id }, include: { tasks: true } });
}

const taskOf = <T extends { identityId: string | null }>(run: { tasks: T[] }, identityId: string): T =>
  run.tasks.find((t) => t.identityId === identityId)!;

describe('a synchronization run', () => {
  it('synchronizes every active identity of active professors and records task and run outcomes', async () => {
    const { a, openAlex, orcid, inactiveIdentity, ofInactiveProf } = await world();
    const run = await runToEnd(service());

    // Scopus and WoS have credentials but no identities, so their access is unverified: never plain SUCCESS (#129, #130).
    expect(run).toMatchObject({ trigger: 'MANUAL', status: 'PARTIAL_SUCCESS', tasksTotal: 2, tasksSucceeded: 2, tasksFailed: 0, startedAt: new Date(T1), finishedAt: new Date(T1) });
    expect(run.tasks.map((t) => t.identityId).sort()).toEqual([openAlex.id, orcid.id].sort()); // not the inactive ones
    expect(run.tasks.some((t) => [inactiveIdentity.id, ofInactiveProf.id].includes(t.identityId!))).toBe(false);

    expect(taskOf(run, openAlex.id)).toMatchObject({ source: 'OPENALEX', status: 'SUCCESS', recordsFetched: 67, recordsNew: 67, errorMessage: null });
    expect(taskOf(run, orcid.id)).toMatchObject({ source: 'ORCID', status: 'SUCCESS', recordsFetched: 8, recordsNew: 5, warnings: 3 });
    for (const t of run.tasks) expect(t).toMatchObject({ startedAt: new Date(T1), finishedAt: new Date(T1) });
    for (const key of ['recordsFetched', 'recordsNew', 'recordsUpdated', 'linksCreated', 'candidatesCreated'] as const) {
      expect(run[key], key).toBe(run.tasks.reduce((n, t) => n + t[key], 0));
    }

    const links = await prisma.professorPublication.findMany({ where: { professorId: a.id } });
    expect(links.length).toBe(run.linksCreated);
    expect(links.every((l) => l.status === 'PENDING' && l.origin === 'DISCOVERED')).toBe(true);
    expect(await prisma.publicationSourceRecord.count({ where: { lastSeenAt: new Date(T1) } })).toBe(72);
  });

  it('a run with every DBLP, OpenAlex and ORCID source (recorded DBLP person included)', async () => {
    const { inactiveIdentity } = await world();
    await prisma.externalIdentity.update({ where: { id: inactiveIdentity.id }, data: { isActive: true } });
    const run = await runToEnd(service());
    expect(run).toMatchObject({ status: 'PARTIAL_SUCCESS', tasksTotal: 3, tasksSucceeded: 3 }); // Scopus/WoS not accessed
    expect(taskOf(run, inactiveIdentity.id)).toMatchObject({ source: 'DBLP', status: 'SUCCESS', recordsFetched: 830 });
  });

  it('with no active identities the run has zero tasks and, with no licensed provider accessed, is partial', async () => {
    const run = await runToEnd(service());
    expect(run).toMatchObject({ status: 'PARTIAL_SUCCESS', tasksTotal: 0, tasksSucceeded: 0, tasksFailed: 0, recordsFetched: 0 });
  });
});

describe('mandatory provider coverage (Phase 15.2, decision #117)', () => {
  it('Scopus and WoS without credentials keep a run without their identities from SUCCESS, and the snapshot is stored', async () => {
    await world();
    const run = await runToEnd(service({}, testClock(T1).now, noLicensedProviders()));
    expect(run).toMatchObject({ kind: 'PUBLICATION_DISCOVERY', status: 'PARTIAL_SUCCESS', tasksTotal: 2, tasksSucceeded: 2, tasksFailed: 0 });
    expect(run.providerCoverage).toEqual({
      version: 1,
      providers: {
        OPENALEX: { credentials: 'NOT_REQUIRED', identities: 1 },
        DBLP: { credentials: 'NOT_REQUIRED', identities: 0 },
        ORCID: { credentials: 'NOT_REQUIRED', identities: 1 },
        SCOPUS: { credentials: 'NOT_CONFIGURED', identities: 0 },
        WOS: { credentials: 'NOT_CONFIGURED', identities: 0 },
      },
    });
  });

  it('an identity of an unconfigured provider gets a NOT_CONFIGURED task that never runs', async () => {
    const { a } = await world();
    const wos = await prisma.externalIdentity.create({ data: { professorId: a.id, source: 'WOS', externalId: 'A-1009-2008' } });
    const run = await runToEnd(service({}, testClock(T1).now, noLicensedProviders()));
    expect(run).toMatchObject({ status: 'PARTIAL_SUCCESS', tasksTotal: 3, tasksSucceeded: 2, tasksFailed: 0 });
    expect(taskOf(run, wos.id)).toMatchObject({
      kind: 'IDENTITY_DISCOVERY',
      source: 'WOS',
      status: 'NOT_CONFIGURED',
      errorMessage: 'Web of Science is not configured: no API credentials are set',
      recordsFetched: 0,
    });
    expect(await prisma.publicationSourceRecord.count({ where: { source: 'WOS' } })).toBe(0);
  });

  it('Scopus and WoS credentials present without identities: stored as PRESENT, access unverified, run partial', async () => {
    await world();
    const sync = service();
    const run = await runToEnd(sync);
    expect(run.status).toBe('PARTIAL_SUCCESS');
    // WoS credentials are present, but the Clarivate gate (§22.6) blocks it in this version (#141).
    expect(run.providerCoverage).toMatchObject({ providers: { SCOPUS: { credentials: 'PRESENT', identities: 0 }, WOS: { credentials: 'PRESENT', identities: 0, blocked: true } } });
    const server = createApp({ mailer: null, sync });
    const detail = await request(server).get(`/api/admin/sync/runs/${run.id}`).set('Cookie', await adminCookie(server));
    const licensed = detail.body.run.coverage.filter((c: { provider: string }) => ['SCOPUS', 'WOS'].includes(c.provider));
    expect(licensed).toEqual([
      expect.objectContaining({ provider: 'SCOPUS', credentials: 'PRESENT', available: true, accessConfirmed: false, complete: false }),
      expect.objectContaining({ provider: 'WOS', credentials: 'PRESENT', available: false, blocked: true, accessConfirmed: false, complete: false }),
    ]);
  });

  it('the run detail reports coverage of all five providers from the stored snapshot', async () => {
    await world();
    const sync = service({}, testClock(T1).now, noLicensedProviders());
    const run = await runToEnd(sync);
    const server = createApp({ mailer: null, sync });
    const admin = await adminCookie(server);
    const detail = await request(server).get(`/api/admin/sync/runs/${run.id}`).set('Cookie', admin);
    expect(detail.body.run.providerCoverage).toBeUndefined();
    expect(detail.body.run.coverage.map((c: { provider: string; available: boolean }) => [c.provider, c.available])).toEqual([
      ['OPENALEX', true],
      ['DBLP', true],
      ['ORCID', true],
      ['SCOPUS', false],
      ['WOS', false],
    ]);
  });
});

describe('reruns', () => {
  it('are idempotent: nothing new, last_seen_at advances, decisions and suppressions are preserved', async () => {
    const { a } = await world();
    const clock = testClock(T1);
    const sync = service({}, clock.now);
    await runToEnd(sync);

    const links = await prisma.professorPublication.findMany({ where: { professorId: a.id }, orderBy: { id: 'asc' } });
    await prisma.professorPublication.update({ where: { id: links[0].id }, data: { status: 'APPROVED', decidedAt: new Date(T1) } });
    await prisma.professorPublication.update({ where: { id: links[1].id }, data: { status: 'REJECTED', decidedAt: new Date(T1) } });
    // An administrator suppressed a publication and removed its pending link.
    await prisma.professorPublication.delete({ where: { id: links[2].id } });
    await prisma.publication.update({ where: { id: links[2].publicationId }, data: { status: 'SUPPRESSED' } });
    const relationships = await prisma.professorPublication.findMany({ orderBy: { id: 'asc' } });
    const before = await tableCounts();

    clock.advance(new Date(T2).getTime() - new Date(T1).getTime());
    const rerun = await runToEnd(sync);
    expect(rerun).toMatchObject({ status: 'PARTIAL_SUCCESS', recordsNew: 0, linksCreated: 0, candidatesCreated: 0 });
    expect(rerun.recordsUpdated).toBe(72);
    expect(await tableCounts()).toEqual({ ...before, syncRuns: before.syncRuns + 1, syncTasks: before.syncTasks + 2 });
    expect(await prisma.professorPublication.findMany({ orderBy: { id: 'asc' } })).toEqual(relationships); // incl. no link to the suppressed one
    expect(await prisma.publicationSourceRecord.count({ where: { lastSeenAt: new Date(T2) } })).toBe(72);
  });
});

describe('failures are contained and never destructive', () => {
  async function afterFirstRun() {
    const ids = await world();
    await runToEnd(service());
    return { ...ids, counts: await tableCounts(), relationships: await prisma.professorPublication.findMany({ orderBy: { id: 'asc' } }) };
  }

  it('an HTML page served with 200 fails only that task; its data and last_seen_at stay as they were', async () => {
    const { openAlex, orcid, counts, relationships } = await afterFirstRun();
    const run = await runToEnd(service({ [openAlexPages[1].request]: html200 }, testClock(T2).now));

    expect(run).toMatchObject({ status: 'PARTIAL_SUCCESS', tasksSucceeded: 1, tasksFailed: 1 });
    expect(taskOf(run, openAlex.id)).toMatchObject({ status: 'FAILED', recordsFetched: 0, finishedAt: new Date(T2) });
    expect(taskOf(run, openAlex.id).errorMessage).toMatch(/^CONTENT_TYPE: OpenAlex: expected JSON/);
    expect(taskOf(run, orcid.id).status).toBe('SUCCESS');
    expect(await tableCounts()).toEqual({ ...counts, syncRuns: counts.syncRuns + 1, syncTasks: counts.syncTasks + 2 });
    expect(await prisma.professorPublication.findMany({ orderBy: { id: 'asc' } })).toEqual(relationships);
    expect(await prisma.publicationSourceRecord.count({ where: { source: 'OPENALEX', lastSeenAt: new Date(T1) } })).toBe(67);
    expect(await prisma.publicationSourceRecord.count({ where: { source: 'ORCID', lastSeenAt: new Date(T2) } })).toBe(5);
  });

  it('an incomplete fetch (a repeated work hiding a missing one) fails its task without writes', async () => {
    const { openAlex } = await afterFirstRun();
    const repeated = structuredClone(openAlexPages[2]);
    (repeated.body as { results: unknown[] }).results[0] = (openAlexPages[0].body as { results: unknown[] }).results[0];
    const run = await runToEnd(service({ [openAlexPages[2].request]: () => toResponse(repeated) }, testClock(T2).now));
    expect(taskOf(run, openAlex.id)).toMatchObject({ status: 'FAILED' });
    expect(taskOf(run, openAlex.id).errorMessage).toMatch(/^INCOMPLETE:/);
    expect(await prisma.publicationSourceRecord.count({ where: { source: 'OPENALEX', lastSeenAt: new Date(T2) } })).toBe(0);
  });

  it('invalid identities fail their tasks and are never read as "no publications"; all failed → FAILED run', async () => {
    const prof = await prisma.professor.create({ data: { name: 'P' } });
    const missing = await prisma.externalIdentity.create({ data: { professorId: prof.id, source: 'ORCID', externalId: '0000-0001-2345-6789' } });
    const deactivated = await prisma.externalIdentity.create({ data: { professorId: prof.id, source: 'ORCID', externalId: '0000-0002-0155-3227' } });
    // An earlier relationship discovered through one of them stays untouched.
    const pub = await prisma.publication.create({ data: { title: 'Earlier', normalizedTitle: 'earlier', typeFamily: 'JOURNAL' } });
    const earlier = await prisma.professorPublication.create({ data: { professorId: prof.id, publicationId: pub.id, status: 'PENDING', origin: 'DISCOVERED', discoveredViaIdentityId: missing.id } });

    const run = await runToEnd(service());
    expect(run).toMatchObject({ status: 'FAILED', tasksSucceeded: 0, tasksFailed: 2 });
    expect(taskOf(run, missing.id).errorMessage).toMatch(/^IDENTITY_NOT_FOUND:/);
    expect(taskOf(run, deactivated.id).errorMessage).toMatch(/^IDENTITY_INVALID: .*9044/);
    expect(await prisma.professorPublication.findUniqueOrThrow({ where: { id: earlier.id } })).toEqual(earlier);
  });

  it('transient errors are retried by the source client; exhausted retries fail the task', async () => {
    const { openAlex } = await world();
    let calls = 0;
    const authorUrl = `${OPENALEX_BASE_URL}/authors/${PRIEM}?select=id,display_name,orcid,works_count`;
    const flaky: Route = () => (++calls === 1 ? new Response('', { status: 503 }) : toResponse(loadFixture('openalex', 'author-valid')));
    const recovered = await runToEnd(service({ [authorUrl]: flaky }));
    expect(taskOf(recovered, openAlex.id).status).toBe('SUCCESS');
    expect(calls).toBe(2);

    await resetDatabase();
    const again = await world();
    const down = await runToEnd(service({ [authorUrl]: () => new Response('', { status: 503 }) }));
    expect(taskOf(down, again.openAlex.id)).toMatchObject({ status: 'FAILED', errorMessage: expect.stringMatching(/^HTTP_STATUS: OpenAlex: HTTP 503/) });
  });

  it('a database error fails the task with a safe message; records written before it keep their last_seen_at', async () => {
    const { orcid } = await world();
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const fn = 'phase12_test_block_record';
    const [{ current_database: db }] = await prisma.$queryRaw<{ current_database: string }[]>`SELECT current_database()`;
    expect(db.endsWith('_test')).toBe(true);
    await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS ${fn} ON publication_source_records`);
    await prisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS ${fn}()`);
    try {
      await prisma.$executeRawUnsafe(
        `CREATE FUNCTION ${fn}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.external_id = '${VARDI_ORCID}:5160613' THEN RAISE EXCEPTION 'phase12 test: insert blocked'; END IF; RETURN NEW; END $$`,
      );
      await prisma.$executeRawUnsafe(`CREATE TRIGGER ${fn} BEFORE INSERT ON publication_source_records FOR EACH ROW EXECUTE FUNCTION ${fn}()`);
      const run = await runToEnd(service());
      const task = taskOf(run, orcid.id);
      expect(task).toMatchObject({ status: 'FAILED', errorMessage: 'Database error while writing records' });
      expect(run.status).toBe('PARTIAL_SUCCESS');
      const kept = await prisma.publicationSourceRecord.count({ where: { source: 'ORCID', lastSeenAt: new Date(T1) } });
      expect(kept).toBeGreaterThan(0);
      expect(kept).toBeLessThan(5);
      expect(await prisma.publicationSourceRecord.count({ where: { externalId: `${VARDI_ORCID}:5160613` } })).toBe(0);
    } finally {
      await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS ${fn} ON publication_source_records`);
      await prisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS ${fn}()`);
    }
  });
});

describe('identities changing during a run', () => {
  it('an identity deactivated while its task runs keeps no PENDING links (§12.4 holds)', async () => {
    const { orcid } = await world();
    const worksUrl = `${ORCID_API_BASE_URL}/${VARDI_ORCID}/works`;
    const deactivateDuringFetch: Route = async () => {
      await prisma.externalIdentity.update({ where: { id: orcid.id }, data: { isActive: false } });
      return toResponse(loadFixture('orcid', 'works-vardi'));
    };
    const run = await runToEnd(service({ [worksUrl]: deactivateDuringFetch }));
    expect(taskOf(run, orcid.id).status).toBe('SUCCESS');
    expect(await prisma.professorPublication.count({ where: { discoveredViaIdentityId: orcid.id, status: 'PENDING' } })).toBe(0);
  });

  it('an identity removed before its task runs fails that task only', async () => {
    const { openAlex, orcid } = await world();
    const authorUrl = `${OPENALEX_BASE_URL}/authors/${PRIEM}?select=id,display_name,orcid,works_count`;
    const removeOrcidFirst: Route = async () => {
      await prisma.externalIdentity.delete({ where: { id: orcid.id } });
      return toResponse(loadFixture('openalex', 'author-valid'));
    };
    const run = await runToEnd(service({ [authorUrl]: removeOrcidFirst }));
    expect(run).toMatchObject({ status: 'PARTIAL_SUCCESS', tasksSucceeded: 1, tasksFailed: 1 });
    expect(taskOf(run, openAlex.id).status).toBe('SUCCESS');
    const orphan = run.tasks.find((t) => t.identityId === null)!;
    expect(orphan).toMatchObject({ source: 'ORCID', status: 'FAILED' });
    expect(orphan.errorMessage).toMatch(/removed|not found/);
  });
});

describe('single-run guard and startup recovery', () => {
  it('refuses a second run while one is in progress (also when started at the same moment)', async () => {
    await world();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const authorUrl = `${OPENALEX_BASE_URL}/authors/${PRIEM}?select=id,display_name,orcid,works_count`;
    const sync = service({ [authorUrl]: async () => (await gate, toResponse(loadFixture('openalex', 'author-valid'))) });

    const [first, second] = await Promise.allSettled([sync.start('MANUAL'), sync.start('SCHEDULED')]);
    expect(first.status).toBe('fulfilled');
    expect(second).toMatchObject({ status: 'rejected', reason: { code: 'SYNC_ALREADY_RUNNING', status: 409 } });
    expect(sync.running).toBe(true);
    await expect(sync.start('MANUAL')).rejects.toMatchObject({ code: 'SYNC_ALREADY_RUNNING' });

    release();
    await sync.idle();
    expect(sync.running).toBe(false);
    expect(await prisma.syncRun.count()).toBe(1);
    expect((await runToEnd(sync)).status).toBe('PARTIAL_SUCCESS'); // a new run is possible afterwards (partial: Scopus/WoS not accessed)
  });

  it('a RUNNING run recorded by another process blocks a new run', async () => {
    await prisma.syncRun.create({ data: { trigger: 'MANUAL', status: 'RUNNING' } });
    await expect(service().start('MANUAL')).rejects.toMatchObject({ code: 'SYNC_ALREADY_RUNNING' });
    expect(await prisma.syncRun.count()).toBe(1);
  });

  it('runs left RUNNING by a crash are marked FAILED at startup with their unfinished tasks', async () => {
    const done = await prisma.syncRun.create({ data: { trigger: 'MANUAL', status: 'SUCCESS', finishedAt: new Date(T1) } });
    const crashed = await prisma.syncRun.create({
      data: {
        trigger: 'SCHEDULED',
        status: 'RUNNING',
        tasks: { create: [{ source: 'ORCID', status: 'SUCCESS' }, { source: 'DBLP', status: 'RUNNING' }, { source: 'OPENALEX', status: 'PENDING' }] },
      },
    });
    expect(await recoverInterruptedRuns(new Date(T2))).toBe(1);
    expect(await prisma.syncRun.findUniqueOrThrow({ where: { id: crashed.id } })).toMatchObject({ status: 'FAILED', tasksSucceeded: 1, tasksFailed: 2, recordsFetched: 0, finishedAt: new Date(T2) });
    const tasks = await prisma.syncTask.findMany({ where: { syncRunId: crashed.id } });
    expect(tasks.filter((t) => t.status === 'FAILED').every((t) => t.errorMessage?.startsWith('Interrupted'))).toBe(true);
    expect(tasks.filter((t) => t.status === 'SUCCESS')).toHaveLength(1);
    expect(await prisma.syncRun.findUniqueOrThrow({ where: { id: done.id } })).toMatchObject({ status: 'SUCCESS' });
    expect(await recoverInterruptedRuns(new Date(T2))).toBe(0);
  });
});

describe('a run that stops unexpectedly (L1)', () => {
  /** Temporary triggers confined to the *_test database, always removed. */
  async function withTriggers(sql: Array<[name: string, table: string, body: string]>, run: () => Promise<void>) {
    const [{ current_database: db }] = await prisma.$queryRaw<{ current_database: string }[]>`SELECT current_database()`;
    expect(db.endsWith('_test')).toBe(true);
    const drop = async () => {
      for (const [name, table] of sql) {
        await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS ${name} ON ${table}`);
        await prisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS ${name}()`);
      }
    };
    await drop();
    try {
      for (const [name, table, body] of sql) {
        await prisma.$executeRawUnsafe(`CREATE FUNCTION ${name}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN ${body} RETURN NEW; END $$`);
        await prisma.$executeRawUnsafe(`CREATE TRIGGER ${name} BEFORE UPDATE ON ${table} FOR EACH ROW EXECUTE FUNCTION ${name}()`);
      }
      await run();
    } finally {
      await drop();
    }
  }

  // Fails the ORCID task's PENDING → RUNNING update, which is outside the per-task error handling.
  const blockOrcidStart: [string, string, string] = [
    'phase12_test_block_task_start',
    'sync_tasks',
    `IF NEW.status = 'RUNNING' AND NEW.source = 'ORCID' THEN RAISE EXCEPTION 'phase12 test: task update blocked'; END IF;`,
  ];

  it('marks every unfinished task FAILED and recomputes the run counters, leaving completed tasks and data alone', async () => {
    const { openAlex, orcid } = await world();
    const logged: string[] = [];
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => void logged.push(args.map(String).join(' ')));
    const sync = service();

    await withTriggers([blockOrcidStart], async () => {
      await sync.start('MANUAL');
      await sync.idle();
    });

    const run = await prisma.syncRun.findFirstOrThrow({ include: { tasks: true } });
    const done = taskOf(run, openAlex.id);
    const stopped = taskOf(run, orcid.id);
    expect(done).toMatchObject({ status: 'SUCCESS', recordsFetched: 67, recordsNew: 67, errorMessage: null }); // untouched
    expect(stopped).toMatchObject({ status: 'FAILED', recordsFetched: 0, errorMessage: 'Not completed: the synchronization run stopped unexpectedly', finishedAt: new Date(T1) });
    expect(run).toMatchObject({
      status: 'FAILED',
      tasksTotal: 2,
      tasksSucceeded: 1,
      tasksFailed: 1,
      recordsFetched: 67,
      recordsNew: 67,
      recordsUpdated: 0,
      linksCreated: done.linksCreated,
      candidatesCreated: done.candidatesCreated,
      finishedAt: new Date(T1),
    });
    expect(await prisma.publicationSourceRecord.count({ where: { source: 'OPENALEX' } })).toBe(67); // completed work kept
    expect(logged[0]).toMatch(/^Synchronization run .* stopped unexpectedly \(Database error while writing records/);
    expect(sync.running).toBe(false);
    expect((await runToEnd(sync)).status).toBe('PARTIAL_SUCCESS'); // the guard was released; nothing blocks now
  });

  it('if recording the failure also fails, the original error is still logged and startup recovery closes the run', async () => {
    const { openAlex, orcid } = await world();
    const logged: string[] = [];
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => void logged.push(args.map(String).join(' ')));
    const sync = service();
    const blockRunClose: [string, string, string] = [
      'phase12_test_block_run_close',
      'sync_runs',
      `IF NEW.status = 'FAILED' THEN RAISE EXCEPTION 'phase12 test: run update blocked'; END IF;`,
    ];

    await withTriggers([blockOrcidStart, blockRunClose], async () => {
      await sync.start('MANUAL');
      await sync.idle();
      expect(sync.running).toBe(false);
      // The closing transaction rolled back as a whole: the run is still RUNNING, the task PENDING.
      const run = await prisma.syncRun.findFirstOrThrow({ include: { tasks: true } });
      expect(run.status).toBe('RUNNING');
      expect(taskOf(run, orcid.id).status).toBe('PENDING');
    });
    expect(logged).toHaveLength(2);
    expect(logged[0]).toMatch(/stopped unexpectedly/); // the original error first, not replaced
    expect(logged[1]).toMatch(/could not be marked FAILED/);

    expect(await recoverInterruptedRuns(new Date(T2))).toBe(1);
    const run = await prisma.syncRun.findFirstOrThrow({ include: { tasks: true } });
    expect(run).toMatchObject({ status: 'FAILED', tasksSucceeded: 1, tasksFailed: 1, recordsFetched: 67, recordsNew: 67, finishedAt: new Date(T2) });
    expect(taskOf(run, openAlex.id).status).toBe('SUCCESS');
    expect(taskOf(run, orcid.id)).toMatchObject({ status: 'FAILED', errorMessage: 'Interrupted: the backend stopped before this task finished' });
  });
});

describe('scheduling (node-cron)', () => {
  it('schedules the same engine monthly in the configured time zone; a tick starts a SCHEDULED run', async () => {
    await world();
    const sync = service();
    let tick: (() => unknown) | undefined;
    const schedule = vi.fn((expression: string, fn: () => unknown, options: unknown) => {
      tick = fn;
      void expression;
      void options;
      return { stop: vi.fn() };
    });
    const scheduler = startSyncScheduler(sync, { cronExpression: DEFAULT_SYNC_CRON, timezone: DEFAULT_SYNC_TIMEZONE, schedule: schedule as never });
    expect(schedule).toHaveBeenCalledWith('0 2 1 * *', expect.any(Function), { name: 'monthly-synchronization', timezone: 'Asia/Kolkata', noOverlap: true });
    expect(cron.validate(DEFAULT_SYNC_CRON)).toBe(true);

    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    await tick!();
    await sync.idle();
    expect(await prisma.syncRun.findFirstOrThrow()).toMatchObject({ trigger: 'SCHEDULED', triggeredByUserId: null, status: 'PARTIAL_SUCCESS' });
    await scheduler.stop();
  });

  it('a tick while a run is in progress is skipped, not failed', async () => {
    await world();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const authorUrl = `${OPENALEX_BASE_URL}/authors/${PRIEM}?select=id,display_name,orcid,works_count`;
    const sync = service({ [authorUrl]: async () => (await gate, toResponse(loadFixture('openalex', 'author-valid'))) });
    await sync.start('MANUAL');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(await runScheduledSync(sync)).toBe('skipped');
    expect(warn).toHaveBeenCalledWith('Scheduled synchronization skipped: a run is already in progress');
    release();
    await sync.idle();
    expect(await prisma.syncRun.count()).toBe(1);
  });

  it('the real node-cron scheduler starts and stops without running anything immediately', async () => {
    const sync = service();
    const scheduler = startSyncScheduler(sync, { cronExpression: DEFAULT_SYNC_CRON, timezone: DEFAULT_SYNC_TIMEZONE });
    await scheduler.stop();
    expect(await prisma.syncRun.count()).toBe(0);
  });
});

describe('admin routes', () => {
  function appWith(sync: SyncService) {
    return createApp({ mailer: null, sync });
  }

  it('require an administrator session (and the allowed origin for the trigger)', async () => {
    const sync = service();
    const server = appWith(sync);
    await createUser({ email: 'prof@example.org', professor: 'active' });
    await createUser({ email: 'temp-admin@example.org', role: 'ADMIN', mustChangePassword: true });
    const prof = cookiePair(await request(server).post('/api/auth/login').send({ email: 'prof@example.org', password: PASSWORD }), 'cse_session');
    const temp = cookiePair(await request(server).post('/api/auth/login').send({ email: 'temp-admin@example.org', password: PASSWORD }), 'cse_session');
    const admin = await adminCookie(server);

    for (const [method, path] of [['post', '/api/admin/sync'], ['get', '/api/admin/sync/runs'], ['get', '/api/admin/sync/runs/00000000-0000-4000-8000-000000000001']] as const) {
      expect((await request(server)[method](path)).status).toBe(401);
      expect((await request(server)[method](path).set('Cookie', prof)).body.error.code).toBe('FORBIDDEN');
      expect((await request(server)[method](path).set('Cookie', temp)).body.error.code).toBe('PASSWORD_CHANGE_REQUIRED');
    }
    expect((await request(server).post('/api/admin/sync').set('Cookie', admin).set('Origin', 'https://evil.example')).body.error.code).toBe('ORIGIN_NOT_ALLOWED');
    expect(await prisma.syncRun.count()).toBe(0);
  });

  it('POST starts a manual run (202) attributed to the admin; a second POST while it runs answers 409', async () => {
    await world();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const authorUrl = `${OPENALEX_BASE_URL}/authors/${PRIEM}?select=id,display_name,orcid,works_count`;
    const sync = service({ [authorUrl]: async () => (await gate, toResponse(loadFixture('openalex', 'author-valid'))) });
    const server = appWith(sync);
    const admin = await adminCookie(server);
    const adminUser = await prisma.user.findUniqueOrThrow({ where: { email: 'admin@example.org' } });

    const started = await request(server).post('/api/admin/sync').set('Cookie', admin);
    expect(started.status).toBe(202);
    expect(started.body.run).toMatchObject({ trigger: 'MANUAL', status: 'RUNNING', tasksTotal: 2, triggeredByUserId: adminUser.id });
    const again = await request(server).post('/api/admin/sync').set('Cookie', admin);
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('SYNC_ALREADY_RUNNING');
    expect((await request(server).get('/api/admin/sync/runs').set('Cookie', admin)).body.running).toBe(true);

    release();
    await sync.idle();
    const detail = await request(server).get(`/api/admin/sync/runs/${started.body.run.id}`).set('Cookie', admin);
    expect(detail.body.run).toMatchObject({ status: 'PARTIAL_SUCCESS', tasksSucceeded: 2 });
    expect(detail.body.run.tasks).toHaveLength(2);
    expect(detail.body.run.tasks[0]).toMatchObject({ status: 'SUCCESS', identity: { externalId: expect.any(String), professor: { name: 'Prof A' } } });
  });

  it('GET lists runs newest first with paging; unknown, malformed and invalid queries are refused', async () => {
    const sync = service();
    const server = appWith(sync);
    const admin = await adminCookie(server);
    const old = await prisma.syncRun.create({ data: { trigger: 'SCHEDULED', status: 'SUCCESS', startedAt: new Date(T1), finishedAt: new Date(T1) } });
    const newer = await prisma.syncRun.create({ data: { trigger: 'MANUAL', status: 'FAILED', startedAt: new Date(T2), finishedAt: new Date(T2) } });

    const list = await request(server).get('/api/admin/sync/runs').set('Cookie', admin);
    expect(list.body).toMatchObject({ total: 2, limit: 20, offset: 0, running: false });
    expect(list.body.runs.map((r: { id: string }) => r.id)).toEqual([newer.id, old.id]);
    expect((await request(server).get('/api/admin/sync/runs?limit=1&offset=1').set('Cookie', admin)).body.runs.map((r: { id: string }) => r.id)).toEqual([old.id]);
    for (const q of ['?limit=0', '?limit=101', '?offset=-1', '?status=x']) {
      expect((await request(server).get(`/api/admin/sync/runs${q}`).set('Cookie', admin)).status).toBe(400);
    }
    expect((await request(server).get('/api/admin/sync/runs/00000000-0000-4000-8000-000000000099').set('Cookie', admin)).body.error.code).toBe('SYNC_RUN_NOT_FOUND');
    expect((await request(server).get('/api/admin/sync/runs/not-a-uuid').set('Cookie', admin)).body.error.code).toBe('SYNC_RUN_NOT_FOUND');
  });
});

describe('manual entries and synchronization share the per-title serialization (Phase 11 open item)', () => {
  it('concurrent manual entries and sync ingestion of the same DOI-less papers never create duplicates', async () => {
    const prof = await prisma.professor.create({ data: { name: 'Racer' } });
    const user = await createUser({ email: 'racer@example.org' });
    await prisma.professor.update({ where: { id: prof.id }, data: { userId: user.id } });
    const titles = Array.from({ length: 12 }, (_, i) => `A Shared DOI-less Study Number ${i + 1}`);
    // One identity per title, so every sync ingestion runs at the same moment as its manual twin.
    const identities = await Promise.all(
      titles.map((_, i) => prisma.externalIdentity.create({ data: { professorId: prof.id, source: 'DBLP', externalId: `x/race${i}` } })),
    );

    await Promise.all(
      titles.flatMap((title, i) => [
        ingestDiscoveredRecords(
          { id: identities[i].id, professorId: prof.id },
          [{ source: 'DBLP', externalId: `journals/race/R${i}`, title, year: 2024, typeFamily: 'JOURNAL' }],
          { seenAt: new Date(T1) },
        ),
        addManualPublication(prof.id, user.id, { title, typeFamily: 'JOURNAL', year: 2024 }, new Date(T1)),
      ]),
    );

    expect(await prisma.publication.count()).toBe(titles.length); // one per paper
    expect(await prisma.publicationSourceRecord.count({ where: { source: 'MANUAL' } })).toBe(titles.length);
    expect(await prisma.publicationSourceRecord.count({ where: { source: 'DBLP' } })).toBe(titles.length);
    expect(await prisma.professorPublication.count()).toBe(titles.length);
    expect(await prisma.professorPublication.count({ where: { status: 'APPROVED', origin: 'MANUAL' } })).toBe(titles.length);
  });

  it('a full sync run racing manual entries of recorded DOI-less ORCID works keeps one publication per paper', async () => {
    const prof = await prisma.professor.create({ data: { name: 'Moshe Y. Vardi' } });
    const user = await createUser({ email: 'vardi@example.org' });
    await prisma.professor.update({ where: { id: prof.id }, data: { userId: user.id } });
    await prisma.externalIdentity.create({ data: { professorId: prof.id, source: 'ORCID', externalId: VARDI_ORCID } });
    const sync = service();

    const manual = [
      { title: 'Endmarkers can make a difference', typeFamily: 'JOURNAL' as const, year: 1990 },
      { title: 'Module Checking', typeFamily: 'JOURNAL' as const, year: 2001 },
    ];
    await Promise.all([sync.start('MANUAL').then(() => sync.idle()), ...manual.map((m) => addManualPublication(prof.id, user.id, m, new Date(T1)))]);

    for (const m of manual) {
      expect(await prisma.publication.count({ where: { normalizedTitle: m.title.toLowerCase() } })).toBe(1);
    }
    expect(await prisma.duplicateCandidate.count()).toBe(0);
  });
});
