import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../../src/app';
import { loadEnv } from '../../src/config/env';
import { prisma } from '../../src/config/database';
import { DblpClient } from '../../src/integrations/dblp/client';
import { OpenAlexClient } from '../../src/integrations/openalex/client';
import { OrcidClient } from '../../src/integrations/orcid/client';
import { ScopusClient } from '../../src/integrations/scopus/client';
import { WosStarterClient } from '../../src/integrations/wos/client';
import { providerConfiguration, type ProviderConfiguration } from '../../src/services/providers/providerStatus';
import { SyncClients, SyncService } from '../../src/services/sync/syncService';
import { testClock } from '../auth/helpers';
import { resetDatabase } from '../helpers/database';
import { loadFixture, noSleep, replayFetch, Route } from '../helpers/fixtures';
import { allProvidersPresent, OPEN_CLARIVATE_GATE } from '../helpers/providers';
import { adminCookie } from '../professors/helpers';
import * as scopusFixtures from '../fixtures/scopus/synthetic';
import { API_KEY, RID, searchUrl, status, threeDocumentPages } from '../fixtures/wos/synthetic';

/* Web of Science in the synchronization engine (stage 15.4) — synthetic WoS responses, no network. */

vi.setConfig({ testTimeout: 60_000 });

const T1 = '2026-11-01T02:00:00.000Z';
const VARDI_ORCID = '0000-0002-0661-5773'; // existing ORCID fixture: 8 summaries

beforeEach(async () => {
  await resetDatabase();
});

afterAll(async () => {
  await resetDatabase();
  await prisma.$disconnect();
});

function clients(wosOverrides: Record<string, Route> = {}, options: { withWos?: boolean; withScopus?: boolean } = {}): SyncClients {
  const open = { fetchImpl: replayFetch([loadFixture('orcid', 'works-vardi')]).fetchImpl, sleep: noSleep };
  const wos = replayFetch(threeDocumentPages(), wosOverrides);
  const scopus = replayFetch([scopusFixtures.authorFound(), ...scopusFixtures.threeDocumentPages()]);
  return {
    openAlex: new OpenAlexClient({ deps: open, http: { maxRetries: 0 } }),
    dblp: new DblpClient({ deps: open, http: { maxRetries: 0 } }),
    orcid: new OrcidClient({ deps: open, http: { maxRetries: 0 } }),
    scopus: options.withScopus ? new ScopusClient({ apiKey: scopusFixtures.API_KEY, perPage: 2, http: { maxRetries: 0 }, deps: { fetchImpl: scopus.fetchImpl, sleep: noSleep } }) : null,
    wos: options.withWos === false ? null : new WosStarterClient({ gate: OPEN_CLARIVATE_GATE, apiKey: API_KEY, perPage: 2, http: { maxRetries: 0 }, deps: { fetchImpl: wos.fetchImpl, sleep: noSleep } }),
  };
}

async function world(withScopus = false) {
  const professor = await prisma.professor.create({ data: { name: 'Prof Five Sources' } });
  const orcid = await prisma.externalIdentity.create({ data: { professorId: professor.id, source: 'ORCID', externalId: VARDI_ORCID } });
  const wos = await prisma.externalIdentity.create({ data: { professorId: professor.id, source: 'WOS', externalId: RID } });
  const scopus = withScopus ? await prisma.externalIdentity.create({ data: { professorId: professor.id, source: 'SCOPUS', externalId: scopusFixtures.AUTHOR } }) : null;
  return { professor, orcid, wos, scopus };
}

async function run(sync: SyncService) {
  const started = await sync.start('MANUAL');
  await sync.idle();
  return prisma.syncRun.findUniqueOrThrow({ where: { id: started.id }, include: { tasks: true } });
}

const service = (c: SyncClients, providers: ProviderConfiguration = allProvidersPresent()) => new SyncService({ clients: c, now: testClock(T1).now, providers, clarivateGate: OPEN_CLARIVATE_GATE });

describe('Web of Science in a discovery run', () => {
  it('a successful WoS task writes records and observations linked to its task, and confirms WoS access', async () => {
    const { wos } = await world();
    const sync = service(clients());
    const result = await run(sync);

    const task = result.tasks.find((t) => t.identityId === wos.id)!;
    expect(task).toMatchObject({ kind: 'IDENTITY_DISCOVERY', source: 'WOS', status: 'SUCCESS', recordsFetched: 3, recordsNew: 3, errorMessage: null });
    expect(await prisma.citationObservation.count({ where: { syncTaskId: task.id, provider: 'WOS', database: 'WOS' } })).toBe(3);
    // Scopus credentials are present but Scopus was not accessed: the run stays partial (#130).
    expect(result.status).toBe('PARTIAL_SUCCESS');

    const server = createApp({ mailer: null, sync });
    const detail = await request(server).get(`/api/admin/sync/runs/${result.id}`).set('Cookie', await adminCookie(server));
    const coverage = Object.fromEntries(detail.body.run.coverage.map((c: { provider: string }) => [c.provider, c]));
    expect(coverage.WOS).toMatchObject({ credentials: 'PRESENT', identities: 1, succeeded: 1, accessConfirmed: true, complete: true });
    expect(coverage.SCOPUS).toMatchObject({ credentials: 'PRESENT', identities: 0, accessConfirmed: false, complete: false });
    expect(JSON.stringify(detail.body)).not.toContain(API_KEY);
  });

  it('with every provider succeeding — Scopus and WoS included — the run is SUCCESS', async () => {
    await world(true);
    const result = await run(service(clients({}, { withScopus: true })));
    expect(result.tasks.map((t) => [t.source, t.status]).sort()).toEqual([
      ['ORCID', 'SUCCESS'],
      ['SCOPUS', 'SUCCESS'],
      ['WOS', 'SUCCESS'],
    ]);
    expect(result.status).toBe('SUCCESS');
    expect(await prisma.citationObservation.groupBy({ by: ['provider'], _count: true, orderBy: { provider: 'asc' } })).toEqual([
      { provider: 'SCOPUS', _count: 3 },
      { provider: 'WOS', _count: 3 },
    ]);
  });

  it('a WoS credential failure fails only its task; the other providers continue and access stays unconfirmed', async () => {
    const { orcid, wos } = await world();
    const sync = service(clients({ [searchUrl(RID, 1, 2)]: status(401) }));
    const result = await run(sync);

    expect(result.tasks.find((t) => t.identityId === orcid.id)).toMatchObject({ status: 'SUCCESS' });
    const failed = result.tasks.find((t) => t.identityId === wos.id)!;
    expect(failed).toMatchObject({ status: 'FAILED', recordsFetched: 0, errorMessage: 'AUTH_FAILED: Web of Science: HTTP 401 (the API key was refused; check WOS_STARTER_API_KEY)' });
    expect(result.status).toBe('PARTIAL_SUCCESS');
    expect(await prisma.publicationSourceRecord.count({ where: { source: 'WOS' } })).toBe(0);
    expect(await prisma.citationObservation.count()).toBe(0);

    const server = createApp({ mailer: null, sync });
    const detail = await request(server).get(`/api/admin/sync/runs/${result.id}`).set('Cookie', await adminCookie(server));
    expect(detail.body.run.coverage.find((c: { provider: string }) => c.provider === 'WOS')).toMatchObject({ credentials: 'PRESENT', failed: 1, accessConfirmed: false, complete: false });
  });

  it('a later-page failure persists nothing for WoS, and no Web of Science response text reaches the task error', async () => {
    const { wos } = await world();
    const LEAK = 'SYNTHETIC-PROVIDER-TEXT-7f3a';
    const body = { error: { status: 400, title: LEAK, details: LEAK }, message: LEAK };
    const result = await run(service(clients({ [searchUrl(RID, 2, 2)]: status(400, { 'x-error': LEAK }, body) })));
    const failed = result.tasks.find((t) => t.identityId === wos.id)!;
    expect(failed).toMatchObject({ status: 'FAILED', errorMessage: 'HTTP_STATUS: Web of Science: HTTP 400 (request refused by Web of Science)' });
    expect(JSON.stringify(result)).not.toContain(LEAK);
    expect(await prisma.publicationSourceRecord.count({ where: { source: 'WOS' } })).toBe(0);
    expect(await prisma.citationObservation.count()).toBe(0);
  });

  it('missing WoS credentials (even with the JCR key set) give a NOT_CONFIGURED task that is never executed', async () => {
    const { wos } = await world();
    // A placeholder value (no real credential): only the JCR variable is set, not the Starter key.
    const env = loadEnv({ DATABASE_URL: 'postgresql://localhost:5432/x_test', JWT_SECRET: 'x'.repeat(32), WOS_JOURNALS_API_KEY: 'jcr-only-placeholder' });
    expect(env.providerCredentials.wosStarter).toBeNull();
    const result = await run(service(clients({}, { withWos: false }), providerConfiguration(env.providerCredentials)));
    expect(result.tasks.find((t) => t.identityId === wos.id)).toMatchObject({ status: 'NOT_CONFIGURED', errorMessage: 'Web of Science is not configured: no API credentials are set', recordsFetched: 0 });
    expect(result.status).toBe('PARTIAL_SUCCESS');
    expect(result.providerCoverage).toMatchObject({ providers: { WOS: { credentials: 'NOT_CONFIGURED', identities: 1 } } });
    expect(await prisma.publicationSourceRecord.count({ where: { source: 'WOS' } })).toBe(0);
  });
});
