import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../../src/app';
import { prisma } from '../../src/config/database';
import { DblpClient } from '../../src/integrations/dblp/client';
import { OpenAlexClient } from '../../src/integrations/openalex/client';
import { OrcidClient } from '../../src/integrations/orcid/client';
import { ScopusClient } from '../../src/integrations/scopus/client';
import { providerConfiguration, type ProviderConfiguration } from '../../src/services/providers/providerStatus';
import { SyncClients, SyncService } from '../../src/services/sync/syncService';
import { testClock } from '../auth/helpers';
import { resetDatabase } from '../helpers/database';
import { loadFixture, noSleep, replayFetch, Route } from '../helpers/fixtures';
import { allProvidersPresent } from '../helpers/providers';
import { adminCookie } from '../professors/helpers';
import { API_KEY, AUTHOR, authorFound, authorUrl, cursorPage, scopusEntry, searchPage, searchUrl, status, threeDocumentPages } from '../fixtures/scopus/synthetic';

/* Scopus in the synchronization engine (stage 15.3) — synthetic Scopus responses, no network. */

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

function clients(
  scopusOverrides: Record<string, Route> = {},
  withScopus = true,
  scopusRecorded = [authorFound(), ...threeDocumentPages()],
  offsetLimit?: number,
): SyncClients {
  const open = { fetchImpl: replayFetch([loadFixture('orcid', 'works-vardi')]).fetchImpl, sleep: noSleep };
  const scopus = replayFetch(scopusRecorded, scopusOverrides);
  return {
    openAlex: new OpenAlexClient({ deps: open, http: { maxRetries: 0 } }),
    dblp: new DblpClient({ deps: open, http: { maxRetries: 0 } }),
    orcid: new OrcidClient({ deps: open, http: { maxRetries: 0 } }),
    scopus: withScopus ? new ScopusClient({ apiKey: API_KEY, perPage: 2, offsetLimit, http: { maxRetries: 0 }, deps: { fetchImpl: scopus.fetchImpl, sleep: noSleep } }) : null,
  };
}

async function world() {
  const professor = await prisma.professor.create({ data: { name: 'Prof Five Sources' } });
  const orcid = await prisma.externalIdentity.create({ data: { professorId: professor.id, source: 'ORCID', externalId: VARDI_ORCID } });
  const scopus = await prisma.externalIdentity.create({ data: { professorId: professor.id, source: 'SCOPUS', externalId: AUTHOR } });
  return { professor, orcid, scopus };
}

async function run(sync: SyncService) {
  const started = await sync.start('MANUAL');
  await sync.idle();
  return prisma.syncRun.findUniqueOrThrow({ where: { id: started.id }, include: { tasks: true } });
}

const service = (c: SyncClients, providers: ProviderConfiguration = allProvidersPresent()) =>
  new SyncService({ clients: c, now: testClock(T1).now, providers });

describe('Scopus in a discovery run', () => {
  it('a successful Scopus task writes records and observations linked to its task, and confirms access', async () => {
    const { scopus } = await world();
    const sync = service(clients());
    const result = await run(sync);

    const task = result.tasks.find((t) => t.identityId === scopus.id)!;
    expect(task).toMatchObject({ kind: 'IDENTITY_DISCOVERY', source: 'SCOPUS', status: 'SUCCESS', recordsFetched: 3, recordsNew: 3, errorMessage: null });
    expect(await prisma.citationObservation.count({ where: { syncTaskId: task.id, provider: 'SCOPUS' } })).toBe(3);
    // WoS credentials are present but WoS was not accessed: the run stays partial (#130).
    expect(result.status).toBe('PARTIAL_SUCCESS');

    const server = createApp({ mailer: null, sync });
    const detail = await request(server).get(`/api/admin/sync/runs/${result.id}`).set('Cookie', await adminCookie(server));
    const coverage = Object.fromEntries(detail.body.run.coverage.map((c: { provider: string }) => [c.provider, c]));
    expect(coverage.SCOPUS).toMatchObject({ credentials: 'PRESENT', identities: 1, succeeded: 1, accessConfirmed: true, complete: true });
    expect(coverage.WOS).toMatchObject({ credentials: 'PRESENT', identities: 0, accessConfirmed: false, complete: false });
    expect(JSON.stringify(detail.body)).not.toContain(API_KEY);
  });

  it('a Scopus credential failure fails only its task; the other providers continue', async () => {
    const { orcid, scopus } = await world();
    const result = await run(service(clients({ [authorUrl()]: status(401) })));

    expect(result.tasks.find((t) => t.identityId === orcid.id)).toMatchObject({ status: 'SUCCESS' });
    const failed = result.tasks.find((t) => t.identityId === scopus.id)!;
    expect(failed).toMatchObject({ status: 'FAILED', recordsFetched: 0 });
    expect(failed.errorMessage).toBe('AUTH_FAILED: Scopus: HTTP 401 (the API key or institutional token was refused; check SCOPUS_API_KEY and SCOPUS_INST_TOKEN)');
    expect(failed.errorMessage).not.toContain(API_KEY);
    expect(result.status).toBe('PARTIAL_SUCCESS');
    expect(await prisma.publicationSourceRecord.count({ where: { source: 'SCOPUS' } })).toBe(0);
    expect(await prisma.citationObservation.count()).toBe(0);
  });

  it('no Scopus response text reaches the persisted task error', async () => {
    const { scopus } = await world();
    const leak = 'SYNTHETIC-PROVIDER-TEXT-7f3a';
    const body = { message: leak, error: leak, 'service-error': { status: { statusCode: 'INVALID_INPUT', statusText: leak } } };
    const result = await run(service(clients({ [searchUrl(AUTHOR, 0, 2)]: status(400, { 'x-els-status': leak }, body) })));
    const failed = result.tasks.find((t) => t.identityId === scopus.id)!;
    expect(failed).toMatchObject({ status: 'FAILED', errorMessage: 'HTTP_STATUS: Scopus: HTTP 400 (request refused by Scopus)' });
    expect(JSON.stringify(result)).not.toContain(leak);
    expect(await prisma.publicationSourceRecord.count({ where: { source: 'SCOPUS' } })).toBe(0);
  });

  it('missing or incomplete Scopus credentials give a NOT_CONFIGURED task that is never executed', async () => {
    const { scopus } = await world();
    const configurations: [ProviderConfiguration, string][] = [
      [providerConfiguration({ scopus: null, wosStarter: null, wosJournals: null, issues: [] }), 'Scopus is not configured: no API credentials are set'],
      [
        providerConfiguration({ scopus: null, wosStarter: null, wosJournals: null, issues: [{ provider: 'SCOPUS', message: 'SCOPUS_INST_TOKEN is set but SCOPUS_API_KEY is not' }] }),
        'Scopus is incompletely configured: its credentials cannot be used',
      ],
    ];
    for (const [providers, message] of configurations) {
      const result = await run(service(clients({}, false), providers));
      expect(result.tasks.find((t) => t.identityId === scopus.id)).toMatchObject({ status: 'NOT_CONFIGURED', errorMessage: message, recordsFetched: 0 });
      expect(result.status).toBe('PARTIAL_SUCCESS');
    }
    expect(await prisma.publicationSourceRecord.count({ where: { source: 'SCOPUS' } })).toBe(0);
  });
});

describe('Scopus cursor pagination in a run', () => {
  // Five documents with an offset limit of 4 (standing in for 5,000): fetched by cursor.
  const docs = [1, 2, 3, 4, 5].map((n) => scopusEntry(n));
  const recorded = (last = cursorPage(AUTHOR, 'c3', 2, 5, docs.slice(4), null)) => [
    authorFound(AUTHOR, { documents: 5 }),
    searchPage(AUTHOR, 0, 2, 5, docs.slice(0, 2)),
    cursorPage(AUTHOR, '*', 2, 5, docs.slice(0, 2), { cursor: 'c2' }),
    cursorPage(AUTHOR, 'c2', 2, 5, docs.slice(2, 4), { cursor: 'c3' }),
    last,
  ];

  it('writes every record and citation observation once the last cursor page is complete', async () => {
    const { scopus } = await world();
    const result = await run(service(clients({}, true, recorded(), 4)));
    const task = result.tasks.find((t) => t.identityId === scopus.id)!;
    expect(task).toMatchObject({ status: 'SUCCESS', recordsFetched: 5, recordsNew: 5 });
    expect(await prisma.publicationSourceRecord.count({ where: { source: 'SCOPUS' } })).toBe(5);
    expect(await prisma.citationObservation.count({ where: { syncTaskId: task.id } })).toBe(5);
  });

  it('a cursor fetch that ends early persists nothing: no records, no observations', async () => {
    const { scopus } = await world();
    const early = cursorPage(AUTHOR, 'c3', 2, 5, [], { cursor: 'c4' });
    const result = await run(service(clients({}, true, recorded(early), 4)));
    const task = result.tasks.find((t) => t.identityId === scopus.id)!;
    expect(task).toMatchObject({ status: 'FAILED', recordsFetched: 0 });
    expect(task.errorMessage).toMatch(/^INCOMPLETE: Scopus cursor page 3 for author \d+ had no entries after 4 of 5 documents$/);
    expect(await prisma.publicationSourceRecord.count({ where: { source: 'SCOPUS' } })).toBe(0);
    expect(await prisma.citationObservation.count()).toBe(0);
  });

  it('a refused cursor request fails the task with the offset fail-safe and persists nothing', async () => {
    const { scopus } = await world();
    const result = await run(service(clients({ [cursorPage(AUTHOR, '*', 2, 5, [], null).request]: status(403) }, true, recorded(), 4)));
    const task = result.tasks.find((t) => t.identityId === scopus.id)!;
    expect(task.status).toBe('FAILED');
    expect(task.errorMessage).toContain('cursor pagination was refused by Scopus (HTTP 403; Elsevier offers cursor pagination to Scopus subscribers only)');
    expect(await prisma.publicationSourceRecord.count({ where: { source: 'SCOPUS' } })).toBe(0);
    expect(await prisma.citationObservation.count()).toBe(0);
  });
});
