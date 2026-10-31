import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../../src/app';
import { prisma } from '../../src/config/database';
import { DblpClient } from '../../src/integrations/dblp/client';
import { FetchError } from '../../src/integrations/http/httpClient';
import { JcrClient } from '../../src/integrations/jcr/client';
import { OpenAlexClient } from '../../src/integrations/openalex/client';
import { OrcidClient } from '../../src/integrations/orcid/client';
import { WosStarterClient } from '../../src/integrations/wos/client';
import { CLARIVATE_GATE, CLARIVATE_GATE_MESSAGE, isClarivateGateOpen } from '../../src/services/providers/clarivateGate';
import { runScheduledJournalMetrics } from '../../src/services/sync/scheduler';
import { coverageSnapshot, parseCoverageSnapshot, providerCoverage } from '../../src/services/sync/runOutcome';
import { ClarivateGateClosedError, SyncClients, SyncService } from '../../src/services/sync/syncService';
import { noLicensedProviders } from '../helpers/providers';
import { testClock } from '../auth/helpers';
import { resetDatabase } from '../helpers/database';
import { loadFixture, noSleep, replayFetch } from '../helpers/fixtures';
import { allProvidersPresent, OPEN_CLARIVATE_GATE } from '../helpers/providers';
import { adminCookie, replayIdentityClients } from '../professors/helpers';
import { RID } from '../fixtures/wos/synthetic';

/*
 * The Clarivate ingestion gate (§22.6, stage 15.7 safety audit; #148): while it is closed — as it is in
 * this version, with the removal tooling complete but no written Clarivate confirmation on record — no
 * Web of Science or JCR request can be made by any path. Every Clarivate client below
 * records any attempted request; none may occur.
 */

vi.setConfig({ testTimeout: 60_000 });

const T1 = '2026-11-01T02:00:00.000Z';

beforeEach(async () => {
  await resetDatabase();
});

afterAll(async () => {
  await resetDatabase();
  await prisma.$disconnect();
});

/** A fetch that records every Clarivate request attempted (and would fail it). */
function spyFetch() {
  const urls: string[] = [];
  const fetchImpl = (async (input: string | URL | Request) => {
    urls.push(String(input));
    throw new Error('A Clarivate request was attempted');
  }) as typeof fetch;
  return { urls, deps: { fetchImpl, sleep: noSleep } };
}

/** Clarivate clients whose own gate is OPEN, so only the engine's gate can stop them. */
function clients(spy = spyFetch()) {
  const open = { fetchImpl: replayFetch([loadFixture('orcid', 'works-vardi')]).fetchImpl, sleep: noSleep };
  const c: SyncClients = {
    openAlex: new OpenAlexClient({ deps: open, http: { maxRetries: 0 } }),
    dblp: new DblpClient({ deps: open, http: { maxRetries: 0 } }),
    orcid: new OrcidClient({ deps: open, http: { maxRetries: 0 } }),
    wos: new WosStarterClient({ apiKey: 'synthetic', gate: OPEN_CLARIVATE_GATE, deps: spy.deps, http: { maxRetries: 0 } }),
    jcr: new JcrClient({ apiKey: 'synthetic', gate: OPEN_CLARIVATE_GATE, deps: spy.deps, http: { maxRetries: 0 } }),
  };
  return { clients: c, spy };
}

/** The engine with Web of Science and JCR credentials PRESENT and its default (closed) gate. */
const engine = (c: SyncClients, extra: { journalMetricsAfterDiscovery?: boolean } = {}) => new SyncService({ clients: c, now: testClock(T1).now, providers: allProvidersPresent(), ...extra });

describe('the gate itself', () => {
  it('is closed in this version — removal tooling complete, written confirmations not on record — and opens only when both hold', () => {
    expect(CLARIVATE_GATE).toEqual({ removalToolingComplete: true, writtenConfirmationsOnRecord: false });
    expect(Object.isFrozen(CLARIVATE_GATE)).toBe(true);
    expect(isClarivateGateOpen()).toBe(false);
    expect(isClarivateGateOpen({ removalToolingComplete: true, writtenConfirmationsOnRecord: false })).toBe(false);
    expect(isClarivateGateOpen({ removalToolingComplete: false, writtenConfirmationsOnRecord: true })).toBe(false);
    expect(isClarivateGateOpen({ removalToolingComplete: true, writtenConfirmationsOnRecord: true })).toBe(true);
  });

  it('names the outstanding condition: written confirmations, not the completed removal tool', () => {
    expect(CLARIVATE_GATE_MESSAGE).toMatch(/until Clarivate's written confirmations on retention, deletion, backups and display are on record/);
    expect(CLARIVATE_GATE_MESSAGE).toMatch(/stage 15\.8, is complete/);
  });

  it('is not opened by the environment: credentials present leave it closed', () => {
    const sync = engine(clients().clients);
    expect(sync.providerConfiguration.WOS.credentials).toBe('PRESENT');
    expect(sync.providerConfiguration.JCR.credentials).toBe('PRESENT');
    expect(sync.clarivateGateOpen).toBe(false);
  });
});

describe('the Clarivate clients refuse every request while closed (any path)', () => {
  it('Web of Science: search and preview fail with BLOCKED before reaching the network', async () => {
    const spy = spyFetch();
    // The default gate (removal tooling complete, confirmations missing) and the other closed states.
    for (const gate of [undefined, CLARIVATE_GATE, { removalToolingComplete: false, writtenConfirmationsOnRecord: true }]) {
      const wos = new WosStarterClient({ apiKey: 'synthetic', gate, deps: spy.deps });
      for (const call of [() => wos.fetchResearcherDocuments(RID), () => wos.previewResearcher(RID)]) {
        const error = await call().catch((e: unknown) => e);
        expect(error).toBeInstanceOf(FetchError);
        expect(error).toMatchObject({ kind: 'BLOCKED', message: `Web of Science: ${CLARIVATE_GATE_MESSAGE}` });
      }
    }
    expect(spy.urls).toEqual([]);
  });

  it('JCR: every endpoint fails with BLOCKED before reaching the network', async () => {
    const spy = spyFetch();
    for (const gate of [undefined, CLARIVATE_GATE, { removalToolingComplete: false, writtenConfirmationsOnRecord: true }]) {
      const jcr = new JcrClient({ apiKey: 'synthetic', gate, deps: spy.deps });
      const calls = [() => jcr.lastUpdated(), () => jcr.searchByIssn('9999-0016'), () => jcr.journal('SYNTH_A'), () => jcr.history('SYNTH_A'), () => jcr.report('SYNTH_A', 2021)];
      for (const call of calls) await expect(call()).rejects.toMatchObject({ kind: 'BLOCKED', message: `JCR: ${CLARIVATE_GATE_MESSAGE}` });
    }
    expect(spy.urls).toEqual([]);
  });
});

describe('the engine never starts JCR work while closed', () => {
  it('admin start: refused with CLARIVATE_GATE_CLOSED, no run created, engine left free', async () => {
    const { clients: c, spy } = clients();
    const sync = engine(c);
    await expect(sync.startJournalMetrics('MANUAL')).rejects.toBeInstanceOf(ClarivateGateClosedError);
    expect(await prisma.syncRun.count()).toBe(0);
    expect(sync.running).toBe(false);
    await sync.start('MANUAL'); // discovery still works
    await sync.idle();
    expect(spy.urls).toEqual([]);
  });

  it('scheduled tick: skipped, no run, no request', async () => {
    const { clients: c, spy } = clients();
    expect(await runScheduledJournalMetrics(engine(c))).toBe('skipped');
    expect(await prisma.syncRun.count()).toBe(0);
    expect(spy.urls).toEqual([]);
  });

  it('after a discovery run that added records: no JCR run is started', async () => {
    const professor = await prisma.professor.create({ data: { name: 'Prof ORCID' } });
    await prisma.externalIdentity.create({ data: { professorId: professor.id, source: 'ORCID', externalId: '0000-0002-0661-5773' } });
    const { clients: c, spy } = clients();
    const sync = engine(c, { journalMetricsAfterDiscovery: true });
    await sync.start('MANUAL');
    await sync.idle();
    await new Promise((resolve) => setTimeout(resolve, 100));
    await sync.idle();
    expect((await prisma.syncRun.findFirstOrThrow()).recordsNew).toBeGreaterThan(0);
    expect(await prisma.syncRun.count({ where: { kind: 'JOURNAL_METRICS' } })).toBe(0);
    expect(spy.urls).toEqual([]);
  });
});

describe('Web of Science discovery while closed', () => {
  it('a WoS identity gets a NOT_CONFIGURED task with the reason; nothing is requested or written', async () => {
    const professor = await prisma.professor.create({ data: { name: 'Prof WoS' } });
    const identity = await prisma.externalIdentity.create({ data: { professorId: professor.id, source: 'WOS', externalId: RID } });
    const { clients: c, spy } = clients();
    const sync = engine(c);
    const started = await sync.start('MANUAL');
    await sync.idle();
    const run = await prisma.syncRun.findUniqueOrThrow({ where: { id: started.id }, include: { tasks: true } });
    expect(run.tasks.find((t) => t.identityId === identity.id)).toMatchObject({ status: 'NOT_CONFIGURED', errorMessage: CLARIVATE_GATE_MESSAGE, recordsFetched: 0 });
    expect(run.status).toBe('PARTIAL_SUCCESS');
    expect(await prisma.publicationSourceRecord.count({ where: { source: 'WOS' } })).toBe(0);
    expect(spy.urls).toEqual([]);
  });

  it('defence in depth: an engine with an open gate still cannot reach Clarivate through a client whose gate is closed', async () => {
    const professor = await prisma.professor.create({ data: { name: 'Prof WoS' } });
    await prisma.externalIdentity.create({ data: { professorId: professor.id, source: 'WOS', externalId: RID } });
    const spy = spyFetch();
    const { clients: c } = clients(spy);
    c.wos = new WosStarterClient({ apiKey: 'synthetic', deps: spy.deps }); // default: closed
    const sync = new SyncService({ clients: c, now: testClock(T1).now, providers: allProvidersPresent(), clarivateGate: OPEN_CLARIVATE_GATE });
    const started = await sync.start('MANUAL');
    await sync.idle();
    const task = (await prisma.syncTask.findMany({ where: { syncRunId: started.id } })).find((t) => t.source === 'WOS')!;
    expect(task).toMatchObject({ status: 'FAILED', errorMessage: `BLOCKED: Web of Science: ${CLARIVATE_GATE_MESSAGE}` });
    expect(spy.urls).toEqual([]);
  });
});

describe('admin API and identity preview while closed', () => {
  it('POST /journal-metrics is 409 CLARIVATE_GATE_CLOSED and creates nothing; the status endpoint reports the gate', async () => {
    const { clients: c, spy } = clients();
    const sync = engine(c);
    const server = createApp({ mailer: null, sync });
    const cookie = await adminCookie(server);
    const refused = await request(server).post('/api/admin/sync/journal-metrics').set('Cookie', cookie);
    expect(refused.status).toBe(409);
    expect(refused.body.error).toMatchObject({ code: 'CLARIVATE_GATE_CLOSED', message: CLARIVATE_GATE_MESSAGE });
    expect(await prisma.syncRun.count()).toBe(0);
    const status = await request(server).get('/api/admin/sync/providers').set('Cookie', cookie);
    expect(status.body.clarivateGate).toEqual({ open: false, message: CLARIVATE_GATE_MESSAGE });
    expect(spy.urls).toEqual([]);
  });

  it('the WoS identity preview is refused (409 PROVIDER_BLOCKED) without a request; manual verification still works', async () => {
    const spy = spyFetch();
    const { clients: identityClients } = replayIdentityClients();
    const server = createApp({ mailer: null, now: testClock(T1).now, identityClients: { ...identityClients, wos: new WosStarterClient({ apiKey: 'synthetic', deps: spy.deps }) } });
    const cookie = await adminCookie(server);
    const professor = await prisma.professor.create({ data: { name: 'Prof WoS' } });
    const preview = await request(server).post(`/api/admin/professors/${professor.id}/identities/preview`).set('Cookie', cookie).send({ source: 'WOS', externalId: RID });
    expect(preview.status).toBe(409);
    expect(preview.body.error.code).toBe('PROVIDER_BLOCKED');
    expect(preview.body.error.message).toContain('verify it manually');
    const manual = await request(server)
      .post(`/api/admin/professors/${professor.id}/identities/manual`)
      .set('Cookie', cookie)
      .send({ source: 'WOS', externalId: RID, evidenceUrl: `https://www.webofscience.com/wos/author/record/${RID}` });
    expect(manual.status).toBe(201);
    expect(spy.urls).toEqual([]);
  });
});

describe('coverage tells a Clarivate policy block apart from missing credentials (#141)', () => {
  it('credentials present + gate closed: WoS is "blocked", not "not configured", and not available', async () => {
    const server = createApp({ mailer: null });
    const professor = await prisma.professor.create({ data: { name: 'Prof WoS' } });
    await prisma.externalIdentity.create({ data: { professorId: professor.id, source: 'WOS', externalId: RID } });
    const sync = engine(clients().clients);
    const started = await sync.start('MANUAL');
    await sync.idle();

    const run = await prisma.syncRun.findUniqueOrThrow({ where: { id: started.id } });
    expect((run.providerCoverage as { providers: { WOS: object } }).providers.WOS).toEqual({ credentials: 'PRESENT', identities: 1, blocked: true });
    const detail = await request(createApp({ mailer: null, sync })).get(`/api/admin/sync/runs/${run.id}`).set('Cookie', await adminCookie(server));
    expect(detail.body.run.coverage.find((c: { provider: string }) => c.provider === 'WOS')).toEqual({
      provider: 'WOS',
      credentials: 'PRESENT',
      available: false,
      blocked: true,
      identities: 1,
      succeeded: 0,
      failed: 0,
      notConfigured: 0,
      blockedTasks: 1,
      unfinished: 0,
      accessConfirmed: false,
      complete: false,
    });
  });

  it('missing credentials + gate closed: WoS stays "not configured" (never reported as blocked)', async () => {
    const professor = await prisma.professor.create({ data: { name: 'Prof WoS' } });
    const identity = await prisma.externalIdentity.create({ data: { professorId: professor.id, source: 'WOS', externalId: RID } });
    const { clients: c } = clients();
    const sync = new SyncService({ clients: { ...c, wos: null }, now: testClock(T1).now, providers: noLicensedProviders() });
    const started = await sync.start('MANUAL');
    await sync.idle();
    const run = await prisma.syncRun.findUniqueOrThrow({ where: { id: started.id }, include: { tasks: true } });
    expect((run.providerCoverage as { providers: { WOS: object } }).providers.WOS).toEqual({ credentials: 'NOT_CONFIGURED', identities: 1 });
    expect(run.tasks.find((t) => t.identityId === identity.id)?.errorMessage).toBe('Web of Science is not configured: no API credentials are set');
    const wos = providerCoverage(parseCoverageSnapshot(run.providerCoverage)!, run.tasks).find((x) => x.provider === 'WOS')!;
    expect(wos).toMatchObject({ credentials: 'NOT_CONFIGURED', available: false, blocked: false, notConfigured: 1, blockedTasks: 0 });
  });

  it('snapshots stored before the flag still parse, as not blocked; only WoS with usable credentials is ever flagged', () => {
    const old = { version: 1, providers: Object.fromEntries(['OPENALEX', 'DBLP', 'ORCID', 'SCOPUS', 'WOS'].map((p) => [p, { credentials: p === 'WOS' || p === 'SCOPUS' ? 'PRESENT' : 'NOT_REQUIRED', identities: 0 }])) };
    const parsed = parseCoverageSnapshot(old)!;
    expect(providerCoverage(parsed, []).find((c) => c.provider === 'WOS')).toMatchObject({ blocked: false, available: true });
    const flagged = coverageSnapshot(allProvidersPresent(), [], { clarivateBlocked: true });
    expect(Object.entries(flagged.providers).filter(([, e]) => 'blocked' in e).map(([p]) => p)).toEqual(['WOS']);
    expect(coverageSnapshot(noLicensedProviders(), [], { clarivateBlocked: true }).providers.WOS).toEqual({ credentials: 'NOT_CONFIGURED', identities: 0 });
    expect(parseCoverageSnapshot({ ...old, providers: { ...old.providers, WOS: { credentials: 'PRESENT', identities: 0, blocked: false } } })).toBeNull(); // only `true` is valid
  });
});
