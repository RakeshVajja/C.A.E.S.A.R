import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../../src/app';
import { prisma } from '../../src/config/database';
import { DblpClient } from '../../src/integrations/dblp/client';
import { OpenAlexClient } from '../../src/integrations/openalex/client';
import { OrcidClient } from '../../src/integrations/orcid/client';
import { providerConfiguration, type ProviderConfiguration } from '../../src/services/providers/providerStatus';
import { runScheduledJournalMetrics } from '../../src/services/sync/scheduler';
import { recoverInterruptedRuns, SyncClients, SyncService } from '../../src/services/sync/syncService';
import { testClock } from '../auth/helpers';
import { resetDatabase } from '../helpers/database';
import { loadFixture, noSleep, replayFetch, type Route } from '../helpers/fixtures';
import { allProvidersPresent } from '../helpers/providers';
import { adminCookie } from '../professors/helpers';
import * as jcr from '../fixtures/jcr/synthetic';
import { ISSN, jcrClient, jcrResponses, publication, publications } from './jcrWorld';

/* Journal-metrics (JCR) runs (stage 15.6, decisions #122, #123) — synthetic JCR responses, isolated test database. */

vi.setConfig({ testTimeout: 60_000 });

const T1 = '2026-11-15T03:00:00.000Z';

beforeEach(async () => {
  await resetDatabase();
});

afterAll(async () => {
  await resetDatabase();
  await prisma.$disconnect();
});

/** Discovery clients (ORCID replays a fixture; nothing else is requested) and a synthetic JCR client. */
function clients(jcrOverrides: Record<string, Route> = {}, withJcr = true) {
  const open = { fetchImpl: replayFetch([loadFixture('orcid', 'works-vardi')]).fetchImpl, sleep: noSleep };
  const journals = jcrClient(jcrResponses(), jcrOverrides);
  const c: SyncClients = {
    openAlex: new OpenAlexClient({ deps: open, http: { maxRetries: 0 } }),
    dblp: new DblpClient({ deps: open, http: { maxRetries: 0 } }),
    orcid: new OrcidClient({ deps: open, http: { maxRetries: 0 } }),
    jcr: withJcr ? journals.client : null,
  };
  return { clients: c, jcrCalls: journals.calls };
}

const service = (c: SyncClients, providers: ProviderConfiguration = allProvidersPresent(), extra: { journalMetricsAfterDiscovery?: boolean } = {}) =>
  new SyncService({ clients: c, now: testClock(T1).now, providers, ...extra });

async function journalRun(sync: SyncService) {
  const started = await sync.startJournalMetrics('MANUAL');
  await sync.idle();
  return prisma.syncRun.findUniqueOrThrow({ where: { id: started.id }, include: { tasks: { include: { journal: true } } } });
}

const withoutJcr = () => providerConfiguration({ scopus: { apiKey: 'p', instToken: null }, wosStarter: { apiKey: 'p' }, wosJournals: null, issues: [] });

describe('a journal-metrics run', () => {
  it('identifies journals, links publications, runs one task per journal and records its own counters', async () => {
    await publications();
    const { clients: c } = clients();
    const run = await journalRun(service(c));

    expect(run).toMatchObject({
      kind: 'JOURNAL_METRICS',
      status: 'SUCCESS',
      tasksTotal: 1,
      tasksSucceeded: 1,
      tasksFailed: 0,
      journalsChecked: 1,
      snapshotsAdded: 3,
      recordsFetched: 3,
      providerCoverage: null,
      jcrDataUpdate: new Date('2026-06-18T00:00:00.000Z'),
    });
    // Only journal A has linked publications; B and C (ambiguous ISSN) get no task.
    expect(run.tasks.map((t) => [t.kind, t.source, t.identityId, t.journal?.jcrId, t.status, t.snapshotsAdded])).toEqual([['JOURNAL_METRICS', null, null, 'SYNTH_A', 'SUCCESS', 3]]);
    expect(await prisma.journalMetricSnapshot.count({ where: { syncTaskId: run.tasks[0].id } })).toBe(3);
    expect(await prisma.journal.count()).toBe(3);

    // A second run adds no snapshot: the reports are unchanged.
    const again = await journalRun(service(clients().clients));
    expect(again).toMatchObject({ status: 'SUCCESS', journalsChecked: 1, snapshotsAdded: 0 });
    expect(await prisma.journalMetricSnapshot.count()).toBe(3);
  });

  it('without JCR credentials: NOT_CONFIGURED tasks for the known journals, never executed, run PARTIAL_SUCCESS', async () => {
    await publications();
    await journalRun(service(clients().clients)); // journals known from an earlier configured run
    const { clients: c, jcrCalls } = clients({}, false);
    const run = await journalRun(service(c, withoutJcr()));
    expect(run).toMatchObject({ status: 'PARTIAL_SUCCESS', tasksTotal: 1, tasksSucceeded: 0, tasksFailed: 0, journalsChecked: 0, snapshotsAdded: 0, jcrDataUpdate: null });
    expect(run.tasks.map((t) => [t.journal?.jcrId, t.status, t.errorMessage])).toEqual([['SYNTH_A', 'NOT_CONFIGURED', 'Journal Citation Reports is not configured: no API credentials are set']]);
    expect(jcrCalls).toHaveLength(0);

    await resetDatabase();
    const empty = await journalRun(service(clients({}, false).clients, withoutJcr()));
    expect(empty).toMatchObject({ status: 'PARTIAL_SUCCESS', tasksTotal: 0 }); // never reported as plain success
  });

  it('refused credentials: identification stops, the known journals’ tasks fail with the reason, run FAILED', async () => {
    await publications();
    await journalRun(service(clients().clients));
    const denied = clients({ [jcr.lastUpdatedUrl()]: jcr.status(401), [jcr.journalUrl('SYNTH_A')]: jcr.status(401) });
    const run = await journalRun(service(denied.clients));
    expect(run).toMatchObject({ status: 'FAILED', tasksTotal: 1, tasksFailed: 1, snapshotsAdded: 0, jcrDataUpdate: null });
    expect(run.tasks[0].errorMessage).toBe('AUTH_FAILED: JCR: HTTP 401 (the API key was refused; check WOS_JOURNALS_API_KEY)');
    expect(denied.jcrCalls.some((c) => c.url.includes('/journals?q='))).toBe(false); // nothing searched
  });

  it('a failing ISSN search or journal task makes the run PARTIAL_SUCCESS; other journals still refresh', async () => {
    await publications();
    const partial = await journalRun(service(clients({ [jcr.searchUrl(ISSN.NOT_IN_JCR)]: jcr.status(500) }).clients));
    expect(partial).toMatchObject({ status: 'PARTIAL_SUCCESS', tasksSucceeded: 1, snapshotsAdded: 3 });

    await resetDatabase();
    await publications();
    const failedTask = await journalRun(service(clients({ [jcr.reportUrl('SYNTH_A', 2022)]: jcr.status(500) }).clients));
    expect(failedTask).toMatchObject({ status: 'FAILED', tasksFailed: 1, snapshotsAdded: 0 });
    expect(failedTask.tasks[0].errorMessage).toBe('HTTP_STATUS: JCR: HTTP 500 (JCR service error, after retries; refresh again later)');
    expect(await prisma.journalMetricSnapshot.count()).toBe(0);
  });

  it('JCR runs never touch publication discovery: no coverage snapshot, no discovery tasks, separate reporting', async () => {
    await publications();
    const sync = service(clients().clients);
    const jcrRun = await journalRun(sync);
    const discovery = await sync.start('MANUAL');
    await sync.idle();

    const discoveryRun = await prisma.syncRun.findUniqueOrThrow({ where: { id: discovery.id }, include: { tasks: true } });
    expect(discoveryRun.kind).toBe('PUBLICATION_DISCOVERY');
    // The five mandatory discovery providers, and no JCR entry (jsonb keeps no key order).
    expect(Object.keys((discoveryRun.providerCoverage as { providers: object }).providers).sort()).toEqual(['DBLP', 'OPENALEX', 'ORCID', 'SCOPUS', 'WOS']);
    expect(discoveryRun.tasks.every((t) => t.kind === 'IDENTITY_DISCOVERY')).toBe(true);

    const server = createApp({ mailer: null, sync });
    const cookie = await adminCookie(server);
    const discoveryList = await request(server).get('/api/admin/sync/runs').set('Cookie', cookie);
    expect(discoveryList.body.runs.map((r: { id: string }) => r.id)).toEqual([discovery.id]);
    expect((await request(server).get(`/api/admin/sync/runs/${jcrRun.id}`).set('Cookie', cookie)).status).toBe(404);
    const jcrList = await request(server).get('/api/admin/sync/journal-metrics/runs').set('Cookie', cookie);
    expect(jcrList.body).toMatchObject({ total: 1, runs: [{ id: jcrRun.id, status: 'SUCCESS', journalsChecked: 1, snapshotsAdded: 3 }] });
    expect((await request(server).get(`/api/admin/sync/journal-metrics/runs/${discovery.id}`).set('Cookie', cookie)).status).toBe(404);
  });
});

describe('run outcome when identification fails or there are no tasks', () => {
  it('a first run whose credentials are refused: nothing identified, no task, run FAILED', async () => {
    await publications();
    const denied = clients({ [jcr.lastUpdatedUrl()]: jcr.status(401) });
    const run = await journalRun(service(denied.clients));
    expect(run).toMatchObject({ status: 'FAILED', tasksTotal: 0, tasksSucceeded: 0, tasksFailed: 0, journalsChecked: 0, jcrDataUpdate: null });
    expect(denied.jcrCalls.map((c) => c.url)).toEqual([jcr.lastUpdatedUrl()]); // no search after an access failure
    expect(await prisma.journal.count()).toBe(0);
  });

  it('an unusable content date (server error or not a calendar date) does not stop identification; the run is PARTIAL_SUCCESS', async () => {
    for (const route of [jcr.status(500), jcr.status(200, { jcrDataUpdate: '2026-02-31' })]) {
      await resetDatabase();
      await publications();
      const run = await journalRun(service(clients({ [jcr.lastUpdatedUrl()]: route }).clients));
      expect(run).toMatchObject({ status: 'PARTIAL_SUCCESS', tasksTotal: 1, tasksSucceeded: 1, snapshotsAdded: 3, jcrDataUpdate: null });
      expect(await prisma.journalMetricSnapshot.count({ where: { jcrDataUpdate: null } })).toBe(3);
    }
  });

  it('identification failures with no journal to refresh: run FAILED with no task', async () => {
    await publication('OPENALEX', 'W1', { title: 'Synthetic paper with an ISSN JCR fails on', issns: [ISSN.NOT_IN_JCR] });
    const run = await journalRun(service(clients({ [jcr.searchUrl(ISSN.NOT_IN_JCR)]: jcr.status(500) }).clients));
    expect(run).toMatchObject({ status: 'FAILED', tasksTotal: 0 });
  });

  it('nothing to refresh (no journal linked) and nothing failed: SUCCESS with no task', async () => {
    await publication('OPENALEX', 'W1', { title: 'Synthetic paper outside JCR', issns: [ISSN.NOT_IN_JCR] });
    await publication('DBLP', 'journals/x/Y', { title: 'Synthetic paper without ISSN' });
    const run = await journalRun(service(clients().clients));
    expect(run).toMatchObject({ status: 'SUCCESS', tasksTotal: 0, journalsChecked: 0, snapshotsAdded: 0, jcrDataUpdate: new Date('2026-06-18T00:00:00.000Z') });
  });
});

describe('scheduling, guard and recovery', () => {
  it('one run at a time across both kinds', async () => {
    await publications();
    const sync = service(clients().clients);
    await sync.startJournalMetrics('MANUAL');
    await expect(sync.start('MANUAL')).rejects.toMatchObject({ code: 'SYNC_ALREADY_RUNNING' });
    await expect(sync.startJournalMetrics('MANUAL')).rejects.toMatchObject({ code: 'SYNC_ALREADY_RUNNING' });
    expect(await runScheduledJournalMetrics(sync)).toBe('skipped');
    await sync.idle();
    await sync.start('MANUAL');
    await expect(sync.startJournalMetrics('SCHEDULED')).rejects.toMatchObject({ code: 'SYNC_ALREADY_RUNNING' });
    await sync.idle();
    expect(await runScheduledJournalMetrics(sync)).toBe('started');
    await sync.idle();
    expect(await prisma.syncRun.groupBy({ by: ['kind', 'trigger'], _count: true, orderBy: [{ kind: 'asc' }, { trigger: 'asc' }] })).toEqual([
      { kind: 'PUBLICATION_DISCOVERY', trigger: 'MANUAL', _count: 1 },
      { kind: 'JOURNAL_METRICS', trigger: 'MANUAL', _count: 1 },
      { kind: 'JOURNAL_METRICS', trigger: 'SCHEDULED', _count: 1 },
    ]);
  });

  it('an interrupted JCR run is closed as FAILED at startup, with its unfinished tasks', async () => {
    const journal = await prisma.journal.create({ data: { jcrId: 'SYNTH_A', name: 'Synthetic Journal A' } });
    const run = await prisma.syncRun.create({
      data: { kind: 'JOURNAL_METRICS', trigger: 'SCHEDULED', status: 'RUNNING', tasksTotal: 1, tasks: { create: [{ kind: 'JOURNAL_METRICS', journalId: journal.id, status: 'RUNNING' }] } },
    });
    expect(await recoverInterruptedRuns(new Date(T1))).toBe(1);
    const closed = await prisma.syncRun.findUniqueOrThrow({ where: { id: run.id }, include: { tasks: true } });
    expect(closed).toMatchObject({ status: 'FAILED', tasksFailed: 1 });
    expect(closed.tasks[0]).toMatchObject({ status: 'FAILED', journalId: journal.id });
  });

  it('a discovery run that adds records starts a JCR refresh when enabled; never without the option or credentials', async () => {
    const professor = await prisma.professor.create({ data: { name: 'Prof ORCID' } });
    await prisma.externalIdentity.create({ data: { professorId: professor.id, source: 'ORCID', externalId: '0000-0002-0661-5773' } });

    const waitForRuns = async (count: number) => {
      for (let i = 0; i < 100 && (await prisma.syncRun.count()) < count; i++) await new Promise((r) => setTimeout(r, 20));
    };
    const chained = service(clients().clients, allProvidersPresent(), { journalMetricsAfterDiscovery: true });
    await chained.start('MANUAL');
    await chained.idle();
    await waitForRuns(2);
    await chained.idle();
    expect((await prisma.syncRun.findMany({ orderBy: { startedAt: 'asc' }, select: { kind: true, trigger: true } })).map((r) => r.kind).sort()).toEqual(['JOURNAL_METRICS', 'PUBLICATION_DISCOVERY']);

    await resetDatabase();
    const p2 = await prisma.professor.create({ data: { name: 'Prof ORCID' } });
    await prisma.externalIdentity.create({ data: { professorId: p2.id, source: 'ORCID', externalId: '0000-0002-0661-5773' } });
    for (const sync of [service(clients().clients), service(clients({}, false).clients, withoutJcr(), { journalMetricsAfterDiscovery: true })]) {
      await sync.start('MANUAL');
      await sync.idle();
      await new Promise((r) => setTimeout(r, 100));
      await sync.idle();
    }
    expect(await prisma.syncRun.count({ where: { kind: 'JOURNAL_METRICS' } })).toBe(0);
  });
});

describe('admin API', () => {
  it('starts a JCR run and reports status and counters only — never metric values', async () => {
    await publications();
    const sync = service(clients().clients);
    const server = createApp({ mailer: null, sync });
    const cookie = await adminCookie(server);

    const started = await request(server).post('/api/admin/sync/journal-metrics').set('Cookie', cookie);
    expect(started.status).toBe(202);
    expect(started.body.run).toMatchObject({ status: 'RUNNING', trigger: 'MANUAL' });
    expect((await request(server).post('/api/admin/sync/journal-metrics').set('Cookie', cookie)).body.error.code).toBe('SYNC_ALREADY_RUNNING');
    await sync.idle();

    const detail = await request(server).get(`/api/admin/sync/journal-metrics/runs/${started.body.run.id}`).set('Cookie', cookie);
    expect(detail.status).toBe(200);
    expect(detail.body.run).toMatchObject({ status: 'SUCCESS', journalsChecked: 1, snapshotsAdded: 3, jcrDataUpdate: '2026-06-18T00:00:00.000Z' });
    expect(detail.body.run.tasks).toEqual([
      expect.objectContaining({ status: 'SUCCESS', snapshotsAdded: 3, recordsFetched: 3, journal: expect.objectContaining({ jcrId: 'SYNTH_A', name: 'Synthetic Journal A' }) }),
    ]);
    expect(JSON.stringify(detail.body)).not.toMatch(/2\.345|jif|quartile|Q1|percentile|totalCites/i);
    expect(JSON.stringify(detail.body)).not.toContain(jcr.API_KEY);

    const anonymous = await request(server).post('/api/admin/sync/journal-metrics');
    expect(anonymous.status).toBe(401);
  });
});
