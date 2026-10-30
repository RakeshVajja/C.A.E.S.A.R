import { PublicationSource, TypeFamily, VerificationStatus } from '@prisma/client';
import request from 'supertest';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../../src/app';
import { prisma } from '../../src/config/database';
import { DblpClient } from '../../src/integrations/dblp/client';
import { OPENALEX_BASE_URL, OpenAlexClient } from '../../src/integrations/openalex/client';
import { OrcidClient } from '../../src/integrations/orcid/client';
import { overview } from '../../src/services/analytics/analytics';
import { addManualPublication } from '../../src/services/manual/manualPublications';
import { ingestPublication, recomputeCanonical, Tx } from '../../src/services/matching/engine';
import { buildNormalizedPublication } from '../../src/services/normalization/normalizedPublication';
import { SyncAlreadyRunningError, SyncService } from '../../src/services/sync/syncService';
import { cookiePair, createUser, PASSWORD, testClock } from '../auth/helpers';
import { resetDatabase } from '../helpers/database';
import { loadFixture, noSleep, replayFetch, Route, toResponse } from '../helpers/fixtures';
import { allProvidersPresent } from '../helpers/providers';
import { adminCookie } from '../professors/helpers';

/* Administrator publication and duplicate management (Project_plan.md §8.5, §15.1; Phase 13B, #90–#95). No network. */

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

const NOW = '2026-10-26T09:00:00.000Z';
const PRIEM = 'A5023888391';
const AUTHOR_URL = `${OPENALEX_BASE_URL}/authors/${PRIEM}?select=id,display_name,orcid,works_count`;

function syncService(overrides: Record<string, Route> = {}) {
  const recorded = [loadFixture('openalex', 'author-valid'), ...['works-page-1', 'works-page-2', 'works-page-3'].map((n) => loadFixture('openalex', n))];
  const deps = { fetchImpl: replayFetch(recorded, overrides).fetchImpl, sleep: noSleep };
  return new SyncService({
    clients: {
      openAlex: new OpenAlexClient({ perPage: 25, deps, http: { maxRetries: 0 } }),
      dblp: new DblpClient({ deps, http: { maxRetries: 0 } }),
      orcid: new OrcidClient({ deps, http: { maxRetries: 0 } }),
    },
    now: testClock(NOW).now,
    providers: allProvidersPresent(),
  });
}

async function setup(sync = syncService()) {
  const server = createApp({ mailer: null, sync, now: testClock(NOW).now });
  const admin = await adminCookie(server);
  const adminUser = await prisma.user.findUniqueOrThrow({ where: { email: 'admin@example.org' } });
  return { server, admin, adminUser, sync };
}

let seq = 0;
interface RecordSpec {
  source: PublicationSource;
  doi?: string | null;
  venue?: string | null;
  title?: string;
  year?: number | null;
}
async function publication(options: { title?: string; year?: number | null; type?: TypeFamily; doi?: string | null; status?: 'ACTIVE' | 'SUPPRESSED'; isCurated?: boolean; records?: RecordSpec[] } = {}) {
  const n = ++seq;
  const title = options.title ?? `Paper ${n}`;
  const typeFamily = options.type ?? 'JOURNAL';
  const records = options.records ?? [{ source: 'DBLP' }];
  return prisma.publication.create({
    data: {
      title,
      normalizedTitle: title.toLowerCase(),
      year: options.year === undefined ? 2020 : options.year,
      typeFamily,
      doi: options.doi === undefined ? `10.1000/p${n}` : options.doi,
      status: options.status ?? 'ACTIVE',
      isCurated: options.isCurated ?? false,
      sourceRecords: {
        create: records.map((r, i) => ({
          source: r.source,
          externalId: `${r.source}-${n}-${i}`,
          title: r.title ?? title,
          normalizedTitle: (r.title ?? title).toLowerCase(),
          doi: r.doi === undefined ? null : r.doi,
          year: r.year === undefined ? (options.year === undefined ? 2020 : options.year) : r.year,
          venue: r.venue ?? null,
          typeFamily,
          matchMethod: i === 0 ? 'NEW_PUBLICATION' : 'DOI',
          matchDetail: i === 0 ? 'No matching publication' : 'Matched on DOI',
          firstSeenAt: new Date(Date.UTC(2026, 0, 1 + i)),
          rawMetadata: { marker: 'raw-metadata-never-returned' },
        })),
      },
    },
  });
}

async function professor(name: string, isActive = true) {
  return prisma.professor.create({ data: { name, isActive } });
}

async function link(professorId: string, publicationId: string, status: VerificationStatus, extra: { decidedAt?: Date; decidedByUserId?: string } = {}) {
  return prisma.professorPublication.create({ data: { professorId, publicationId, status, origin: 'DISCOVERED', ...extra } });
}

async function candidate(x: string, y: string, status: 'OPEN' | 'DISMISSED' | 'MERGED' = 'OPEN', reason = 'Exact title match blocked: test') {
  const [publicationAId, publicationBId] = x < y ? [x, y] : [y, x];
  return prisma.duplicateCandidate.create({ data: { publicationAId, publicationBId, status, reason } });
}

/** Every row of the tables merge/detach touch, for "nothing changed" checks. */
async function snapshot() {
  return {
    publications: await prisma.publication.findMany({ orderBy: { id: 'asc' } }),
    records: await prisma.publicationSourceRecord.findMany({ orderBy: { id: 'asc' } }),
    relationships: await prisma.professorPublication.findMany({ orderBy: { id: 'asc' } }),
    candidates: await prisma.duplicateCandidate.findMany({ orderBy: { id: 'asc' } }),
  };
}

async function withTrigger(table: string, timing: string, body: string, run: () => Promise<void>) {
  const name = 'phase13b_test_trigger';
  const [{ current_database: db }] = await prisma.$queryRaw<{ current_database: string }[]>`SELECT current_database()`;
  expect(db.endsWith('_test')).toBe(true);
  const drop = async () => {
    await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS ${name} ON ${table}`);
    await prisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS ${name}()`);
  };
  await drop();
  try {
    await prisma.$executeRawUnsafe(`CREATE FUNCTION ${name}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN ${body} END $$`);
    await prisma.$executeRawUnsafe(`CREATE TRIGGER ${name} ${timing} ON ${table} FOR EACH ROW EXECUTE FUNCTION ${name}()`);
    await run();
  } finally {
    await drop();
  }
}

const PUB_ROUTES = (id: string) => [
  ['get', '/api/admin/publications'],
  ['get', `/api/admin/publications/${id}`],
  ['patch', `/api/admin/publications/${id}`],
  ['patch', `/api/admin/publications/${id}/status`],
  ['get', '/api/admin/duplicate-candidates'],
  ['post', `/api/admin/duplicate-candidates/${id}/dismiss`],
  ['post', `/api/admin/duplicate-candidates/${id}/merge`],
  ['post', `/api/admin/source-records/${id}/detach`],
] as const;

describe('authorization and request safety', () => {
  it('every endpoint requires an administrator session; state changes also the allowed origin', async () => {
    const { server, admin } = await setup();
    await createUser({ email: 'prof@example.org', professor: 'active' });
    await createUser({ email: 'temp-admin@example.org', role: 'ADMIN', mustChangePassword: true });
    const prof = cookiePair(await request(server).post('/api/auth/login').send({ email: 'prof@example.org', password: PASSWORD }), 'cse_session');
    const temp = cookiePair(await request(server).post('/api/auth/login').send({ email: 'temp-admin@example.org', password: PASSWORD }), 'cse_session');
    const p = await publication({ records: [{ source: 'DBLP' }, { source: 'ORCID' }] });
    const q = await publication();
    const c = await candidate(p.id, q.id);
    const before = await snapshot();

    for (const [method, path] of PUB_ROUTES(c.id)) {
      expect((await request(server)[method](path).send({})).status, path).toBe(401);
      expect((await request(server)[method](path).set('Cookie', prof).send({})).body.error.code, path).toBe('FORBIDDEN');
      expect((await request(server)[method](path).set('Cookie', temp).send({})).body.error.code, path).toBe('PASSWORD_CHANGE_REQUIRED');
      if (method !== 'get') {
        const foreign = await request(server)[method](path).set('Cookie', admin).set('Origin', 'https://evil.example').send({});
        expect(foreign.body.error.code, path).toBe('ORIGIN_NOT_ALLOWED');
      }
    }
    expect(await snapshot()).toEqual(before);
  });

  it('responses never contain raw metadata or user emails', async () => {
    const { server, admin } = await setup();
    const p = await publication({ records: [{ source: 'DBLP' }, { source: 'ORCID' }] });
    const q = await publication();
    const prof = await professor('Prof A');
    await link(prof.id, p.id, 'PENDING');
    const c = await candidate(p.id, q.id);
    const bodies = [
      await request(server).get('/api/admin/publications').set('Cookie', admin),
      await request(server).get(`/api/admin/publications/${p.id}`).set('Cookie', admin),
      await request(server).get('/api/admin/duplicate-candidates').set('Cookie', admin),
      await request(server).post(`/api/admin/duplicate-candidates/${c.id}/dismiss`).set('Cookie', admin),
    ].map((r) => JSON.stringify(r.body));
    for (const body of bodies) {
      expect(body).not.toContain('raw-metadata-never-returned');
      expect(body).not.toContain('rawMetadata');
      expect(body).not.toContain('admin@example.org');
    }
  });
});

describe('GET /api/admin/publications', () => {
  it('lists every publication, suppressed included, with filters, search and paging', async () => {
    const { server, admin } = await setup();
    const a = await publication({ title: 'Alpha graph theory', type: 'CONFERENCE', records: [{ source: 'OPENALEX' }, { source: 'DBLP' }] });
    const b = await publication({ title: 'Beta graph search', status: 'SUPPRESSED' });
    const c = await publication({ title: 'Gamma databases', isCurated: true, doi: '10.5555/gamma' });
    const prof = await professor('Prof A');
    await link(prof.id, a.id, 'APPROVED');
    await link((await professor('Prof B')).id, a.id, 'PENDING');

    const all = await request(server).get('/api/admin/publications').set('Cookie', admin);
    expect(all.status).toBe(200);
    expect(all.body).toMatchObject({ total: 3, limit: 50, offset: 0 });
    expect(all.body.publications.map((p: { id: string }) => p.id)).toEqual([a.id, b.id, c.id]); // by normalized title
    expect(all.body.publications[0]).toMatchObject({
      title: 'Alpha graph theory',
      sources: ['OPENALEX', 'DBLP'],
      sourceRecordCount: 2,
      relationshipCounts: { pending: 1, approved: 1, rejected: 0 },
      status: 'ACTIVE',
      isCurated: false,
    });

    const get = async (qs: string) => (await request(server).get(`/api/admin/publications?${qs}`).set('Cookie', admin)).body;
    expect((await get('status=SUPPRESSED')).publications.map((p: { id: string }) => p.id)).toEqual([b.id]);
    expect((await get('typeFamily=CONFERENCE')).publications.map((p: { id: string }) => p.id)).toEqual([a.id]);
    expect((await get('curated=true')).publications.map((p: { id: string }) => p.id)).toEqual([c.id]);
    expect((await get('q=GRAPH')).publications.map((p: { id: string }) => p.id)).toEqual([a.id, b.id]); // normalized title
    expect((await get(`q=${encodeURIComponent('https://doi.org/10.5555/GAMMA')}`)).publications.map((p: { id: string }) => p.id)).toEqual([c.id]);
    const page = await get('limit=1&offset=1');
    expect(page).toMatchObject({ total: 3, limit: 1, offset: 1 });
    expect(page.publications.map((p: { id: string }) => p.id)).toEqual([b.id]);
  });

  it('rejects invalid query parameters', async () => {
    const { server, admin } = await setup();
    for (const qs of ['limit=0', 'limit=201', 'offset=-1', 'status=DELETED', 'typeFamily=x', 'curated=yes', 'professorId=1', 'q=', 'q=%21%21%21']) {
      const res = await request(server).get(`/api/admin/publications?${qs}`).set('Cookie', admin);
      expect(res.status, qs).toBe(400);
      expect(res.body.error.code, qs).toBe('VALIDATION_ERROR');
    }
  });
});

describe('GET /api/admin/publications/:id', () => {
  it('returns source-record summaries, relationships and candidates; unknown and malformed IDs are 404', async () => {
    const { server, admin } = await setup();
    const p = await publication({ records: [{ source: 'OPENALEX', doi: '10.1000/x' }, { source: 'ORCID' }] });
    const other = await publication({ title: 'Other paper' });
    const prof = await professor('Prof A');
    const identity = await prisma.externalIdentity.create({ data: { professorId: prof.id, source: 'ORCID', externalId: '0000-0002-0661-5773' } });
    await prisma.professorPublication.create({ data: { professorId: prof.id, publicationId: p.id, status: 'PENDING', origin: 'DISCOVERED', discoveredViaIdentityId: identity.id } });
    const c = await candidate(p.id, other.id);

    const res = await request(server).get(`/api/admin/publications/${p.id}`).set('Cookie', admin);
    expect(res.status).toBe(200);
    const detail = res.body.publication;
    expect(detail).toMatchObject({ id: p.id, sources: ['OPENALEX', 'ORCID'], sourceRecordCount: 2 });
    expect(detail.sourceRecords).toHaveLength(2);
    expect(detail.sourceRecords[0]).toMatchObject({ source: 'OPENALEX', doi: '10.1000/x', matchMethod: 'NEW_PUBLICATION' });
    expect(detail.sourceRecords[0]).not.toHaveProperty('rawMetadata');
    expect(detail.relationships).toEqual([
      expect.objectContaining({ status: 'PENDING', origin: 'DISCOVERED', professor: { id: prof.id, name: 'Prof A', isActive: true }, discoveredViaIdentity: { id: identity.id, source: 'ORCID', externalId: '0000-0002-0661-5773' } }),
    ]);
    expect(detail.duplicateCandidates).toEqual([expect.objectContaining({ id: c.id, status: 'OPEN', otherPublication: expect.objectContaining({ id: other.id, title: 'Other paper' }) })]);

    expect((await request(server).get('/api/admin/publications/00000000-0000-4000-8000-000000000001').set('Cookie', admin)).body.error.code).toBe('PUBLICATION_NOT_FOUND');
    expect((await request(server).get('/api/admin/publications/not-a-uuid').set('Cookie', admin)).status).toBe(404);
  });
});

describe('PATCH /api/admin/publications/:id (edit and curate)', () => {
  it('edits canonical fields with the shared normalizers, marks the publication curated, and leaves records and decisions alone', async () => {
    const { server, admin } = await setup();
    const p = await publication({ title: 'Wrong title', records: [{ source: 'DBLP', doi: '10.1000/old' }] });
    const prof = await professor('Prof A');
    const rel = await link(prof.id, p.id, 'APPROVED', { decidedAt: new Date('2026-10-01T00:00:00Z') });
    const recordsBefore = await prisma.publicationSourceRecord.findMany({ where: { publicationId: p.id } });

    const res = await request(server)
      .patch(`/api/admin/publications/${p.id}`)
      .set('Cookie', admin)
      .send({ title: '  The Correct <i>Title</i>: Ünïcode ', year: 2019, venue: 'ICSE', typeFamily: 'CONFERENCE', authorNames: 'A. Author; B. Author', doi: 'https://doi.org/10.1145/ABC.123' });
    expect(res.status).toBe(200);
    expect(res.body.publication).toMatchObject({
      title: 'The Correct <i>Title</i>: Ünïcode',
      year: 2019,
      venue: 'ICSE',
      typeFamily: 'CONFERENCE',
      authorNamesDisplay: 'A. Author; B. Author',
      doi: '10.1145/abc.123',
      isCurated: true,
    });
    const stored = await prisma.publication.findUniqueOrThrow({ where: { id: p.id } });
    expect(stored.normalizedTitle).toBe('the correct title unicode');
    expect(await prisma.publicationSourceRecord.findMany({ where: { publicationId: p.id } })).toEqual(recordsBefore);
    expect(await prisma.professorPublication.findUniqueOrThrow({ where: { id: rel.id } })).toEqual(rel);

    // Clearing optional fields.
    const cleared = await request(server).patch(`/api/admin/publications/${p.id}`).set('Cookie', admin).send({ doi: null, venue: '', year: null });
    expect(cleared.body.publication).toMatchObject({ doi: null, venue: null, year: null, isCurated: true });
  });

  it('a curated edit survives later synchronization of its source records', async () => {
    const { server, admin } = await setup();
    const p = await publication({ title: 'Source title', records: [{ source: 'DBLP' }] });
    const record = await prisma.publicationSourceRecord.findFirstOrThrow({ where: { publicationId: p.id } });
    await request(server).patch(`/api/admin/publications/${p.id}`).set('Cookie', admin).send({ title: 'Curated title', year: 2001 }).expect(200);

    // The source reports the record again (rule 1: update in place) with different metadata.
    const again = buildNormalizedPublication({ source: 'DBLP', externalId: record.externalId, title: 'Source title, revised', year: 2020, typeFamily: 'JOURNAL', dois: ['10.1000/new'] });
    const result = await ingestPublication(again, { seenAt: new Date(NOW) });
    expect(result).toMatchObject({ outcome: 'UPDATED_EXISTING', publicationId: p.id });
    expect(await prisma.publication.findUniqueOrThrow({ where: { id: p.id } })).toMatchObject({ title: 'Curated title', year: 2001, isCurated: true });
    expect(await prisma.publicationSourceRecord.findUniqueOrThrow({ where: { id: record.id } })).toMatchObject({ title: 'Source title, revised', doi: '10.1000/new' });
  });

  it('an edit committed while a synchronization recompute is in flight is not overwritten (#90)', async () => {
    const p = await publication({ title: 'Source title', records: [{ source: 'DBLP' }] });
    await prisma.publicationSourceRecord.updateMany({ where: { publicationId: p.id }, data: { title: 'Source title v2', normalizedTitle: 'source title v2' } });
    await prisma.$transaction(async (tx) => {
      // The recompute reads the (not yet curated) publication; the administrator's edit then commits
      // on another connection before the recompute writes.
      const interleaved = new Proxy(tx, {
        get(target, key) {
          if (key !== 'publication') return Reflect.get(target, key);
          return new Proxy(target.publication, {
            get(model, method) {
              if (method !== 'findUniqueOrThrow') return Reflect.get(model, method);
              return async (args: Parameters<typeof model.findUniqueOrThrow>[0]) => {
                const row = await model.findUniqueOrThrow(args);
                await prisma.publication.update({ where: { id: p.id }, data: { title: 'Curated title', isCurated: true } });
                return row;
              };
            },
          });
        },
      }) as Tx;
      await recomputeCanonical(interleaved, p.id);
    });
    expect(await prisma.publication.findUniqueOrThrow({ where: { id: p.id } })).toMatchObject({ title: 'Curated title', isCurated: true });
  });

  it('refuses invalid input, a DOI owned by another publication, and unknown publications', async () => {
    const { server, admin } = await setup();
    const p = await publication();
    const owner = await publication({ doi: '10.1000/taken' });
    const before = await snapshot();
    const patch = (body: unknown, id = p.id) => request(server).patch(`/api/admin/publications/${id}`).set('Cookie', admin).send(body as object);

    expect((await patch({})).body.error.code).toBe('VALIDATION_ERROR');
    expect((await patch({ title: '   ' })).body.error.code).toBe('VALIDATION_ERROR');
    expect((await patch({ title: '!!!' })).body.error.code).toBe('INVALID_TITLE');
    expect((await patch({ doi: 'not a doi' })).body.error.code).toBe('INVALID_DOI');
    expect((await patch({ year: 999 })).body.error.code).toBe('VALIDATION_ERROR');
    expect((await patch({ typeFamily: 'THESIS' })).body.error.code).toBe('VALIDATION_ERROR');
    expect((await patch({ status: 'SUPPRESSED' })).body.error.code).toBe('VALIDATION_ERROR'); // not editable here
    expect((await patch({ isCurated: false })).body.error.code).toBe('VALIDATION_ERROR');
    const taken = await patch({ doi: 'DOI: 10.1000/TAKEN' });
    expect(taken.status).toBe(409);
    expect(taken.body.error).toMatchObject({ code: 'DOI_IN_USE', details: { publicationId: owner.id } });
    expect((await patch({ title: 'x' }, '00000000-0000-4000-8000-000000000001')).body.error.code).toBe('PUBLICATION_NOT_FOUND');
    expect(await snapshot()).toEqual(before);

    // Keeping its own DOI is not a conflict.
    expect((await patch({ doi: p.doi })).status).toBe(200);
  });
});

describe('PATCH /api/admin/publications/:id/status (suppress and restore)', () => {
  it('suppression keeps records and relationships and hides the publication from professors and analytics; restoring creates no relationship', async () => {
    const { server, admin } = await setup();
    const user = await createUser({ email: 'prof@example.org', professor: 'active' });
    const prof = await prisma.professor.findUniqueOrThrow({ where: { userId: user.id } });
    const profCookie = cookiePair(await request(server).post('/api/auth/login').send({ email: 'prof@example.org', password: PASSWORD }), 'cse_session');
    const p = await publication({ records: [{ source: 'DBLP' }, { source: 'ORCID' }] });
    await link(prof.id, p.id, 'APPROVED');
    await link((await professor('Prof B')).id, p.id, 'PENDING');
    const before = await snapshot();
    expect((await overview()).uniquePublications).toBe(1);

    const suppressed = await request(server).patch(`/api/admin/publications/${p.id}/status`).set('Cookie', admin).send({ status: 'SUPPRESSED', expectedStatus: 'ACTIVE' });
    expect(suppressed.status).toBe(200);
    expect(suppressed.body.publication).toMatchObject({ status: 'SUPPRESSED', sourceRecordCount: 2 });
    expect(await prisma.publicationSourceRecord.count({ where: { publicationId: p.id } })).toBe(2);
    expect(await prisma.professorPublication.count({ where: { publicationId: p.id } })).toBe(2);
    expect((await request(server).get('/api/me/publications').set('Cookie', profCookie)).body).toMatchObject({ items: [], total: 0 });
    expect(await overview()).toMatchObject({ uniquePublications: 0, pendingVerifications: 0 });
    // The administrator still finds it.
    expect((await request(server).get('/api/admin/publications?status=SUPPRESSED').set('Cookie', admin)).body.total).toBe(1);

    const restored = await request(server).patch(`/api/admin/publications/${p.id}/status`).set('Cookie', admin).send({ status: 'ACTIVE', expectedStatus: 'SUPPRESSED' });
    expect(restored.body.publication.status).toBe('ACTIVE');
    const after = await snapshot();
    expect(after.relationships).toEqual(before.relationships); // none created, none changed
    expect(after.records).toEqual(before.records);
    expect((await request(server).get('/api/me/publications').set('Cookie', profCookie)).body.total).toBe(1);
    expect(await overview()).toMatchObject({ uniquePublications: 1, pendingVerifications: 1 });
  });

  it('stale and redundant transitions conflict; unknown publications and invalid bodies are refused', async () => {
    const { server, admin } = await setup();
    const p = await publication({ status: 'SUPPRESSED' });
    const send = (body: unknown, id = p.id) => request(server).patch(`/api/admin/publications/${id}/status`).set('Cookie', admin).send(body as object);

    const stale = await send({ status: 'SUPPRESSED', expectedStatus: 'ACTIVE' });
    expect(stale.status).toBe(409);
    expect(stale.body.error).toMatchObject({ code: 'STATUS_CONFLICT', details: { currentStatus: 'SUPPRESSED' } });
    const staleRestore = await send({ status: 'ACTIVE', expectedStatus: 'ACTIVE' });
    expect(staleRestore.body.error).toMatchObject({ code: 'STATUS_CONFLICT', details: { currentStatus: 'SUPPRESSED' } });
    const redundant = await send({ status: 'SUPPRESSED', expectedStatus: 'SUPPRESSED' });
    expect(redundant.body.error).toMatchObject({ code: 'INVALID_TRANSITION', details: { currentStatus: 'SUPPRESSED' } });
    expect((await send({ status: 'DELETED', expectedStatus: 'ACTIVE' })).body.error.code).toBe('VALIDATION_ERROR');
    expect((await send({ status: 'ACTIVE' })).body.error.code).toBe('VALIDATION_ERROR');
    expect((await send({ status: 'ACTIVE', expectedStatus: 'SUPPRESSED' }, '00000000-0000-4000-8000-000000000001')).body.error.code).toBe('PUBLICATION_NOT_FOUND');
    expect((await prisma.publication.findUniqueOrThrow({ where: { id: p.id } })).status).toBe('SUPPRESSED');

    // Two concurrent identical suppressions of an active publication: one succeeds, one conflicts.
    const q = await publication();
    const results = await Promise.all([0, 1].map(() => send({ status: 'SUPPRESSED', expectedStatus: 'ACTIVE' }, q.id)));
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
  });
});

describe('duplicate candidates: listing and dismissal', () => {
  it('lists candidates by status with both publication summaries; dismisses only OPEN ones with attribution', async () => {
    const { server, admin, adminUser } = await setup();
    const a = await publication({ title: 'Same title', records: [{ source: 'OPENALEX' }] });
    const b = await publication({ title: 'Same title', records: [{ source: 'DBLP' }, { source: 'ORCID' }] });
    const c = await publication({ title: 'Other' });
    const open = await candidate(a.id, b.id);
    const dismissed = await candidate(a.id, c.id, 'DISMISSED');

    const list = await request(server).get('/api/admin/duplicate-candidates').set('Cookie', admin);
    expect(list.body).toMatchObject({ total: 1, limit: 50, offset: 0 });
    expect(list.body.candidates[0]).toMatchObject({ id: open.id, status: 'OPEN', reason: 'Exact title match blocked: test' });
    const sides = [list.body.candidates[0].publicationA, list.body.candidates[0].publicationB];
    expect(sides.map((s: { id: string }) => s.id).sort()).toEqual([a.id, b.id].sort());
    expect(sides.find((s: { id: string }) => s.id === b.id)).toMatchObject({ sources: ['DBLP', 'ORCID'], sourceRecordCount: 2 });
    expect((await request(server).get('/api/admin/duplicate-candidates?status=DISMISSED').set('Cookie', admin)).body.candidates.map((x: { id: string }) => x.id)).toEqual([dismissed.id]);
    for (const qs of ['status=CLOSED', 'limit=0', 'limit=201', 'foo=1']) {
      expect((await request(server).get(`/api/admin/duplicate-candidates?${qs}`).set('Cookie', admin)).status, qs).toBe(400);
    }

    const res = await request(server).post(`/api/admin/duplicate-candidates/${open.id}/dismiss`).set('Cookie', admin);
    expect(res.status).toBe(200);
    expect(res.body.candidate).toMatchObject({ id: open.id, status: 'DISMISSED', resolvedAt: NOW });
    expect(await prisma.duplicateCandidate.findUniqueOrThrow({ where: { id: open.id } })).toMatchObject({ resolvedByUserId: adminUser.id });
    expect(await prisma.publication.count()).toBe(3); // both publications stay

    const again = await request(server).post(`/api/admin/duplicate-candidates/${open.id}/dismiss`).set('Cookie', admin);
    expect(again.status).toBe(409);
    expect(again.body.error).toMatchObject({ code: 'CANDIDATE_NOT_OPEN', details: { currentStatus: 'DISMISSED' } });
    expect((await request(server).post('/api/admin/duplicate-candidates/00000000-0000-4000-8000-000000000001/dismiss').set('Cookie', admin)).body.error.code).toBe('CANDIDATE_NOT_FOUND');
    expect((await request(server).post('/api/admin/duplicate-candidates/x/dismiss').set('Cookie', admin)).status).toBe(404);
  });
});

describe('POST /api/admin/duplicate-candidates/:id/merge', () => {
  async function mergeWorld() {
    const keep = await publication({ title: 'Model checking', doi: null, records: [{ source: 'OPENALEX', doi: null, venue: null }] });
    const remove = await publication({ title: 'Model checking', doi: '10.1000/merged', records: [{ source: 'DBLP', doi: '10.1000/merged', venue: 'CAV' }, { source: 'ORCID' }] });
    return { keep, remove, c: await candidate(keep.id, remove.id) };
  }

  it('moves source records, recomputes the survivor, removes the other publication and records the merge', async () => {
    const { server, admin, adminUser } = await setup();
    const { keep, remove, c } = await mergeWorld();
    const res = await request(server).post(`/api/admin/duplicate-candidates/${c.id}/merge`).set('Cookie', admin).send({ keepPublicationId: keep.id });
    expect(res.status).toBe(200);
    expect(res.body.merge).toEqual({ removedPublicationId: remove.id, sourceRecordsMoved: 2, relationshipsMoved: 0, relationshipsRemoved: 0, candidatesRepointed: 0, candidatesClosed: 0 });
    expect(res.body.publication).toMatchObject({ id: keep.id, sources: ['OPENALEX', 'DBLP', 'ORCID'], sourceRecordCount: 3, venue: 'CAV', doi: '10.1000/merged' });

    expect(await prisma.publication.findUnique({ where: { id: remove.id } })).toBeNull();
    const moved = await prisma.publicationSourceRecord.findMany({ where: { source: { in: ['DBLP', 'ORCID'] } } });
    for (const r of moved) {
      expect(r).toMatchObject({ publicationId: keep.id, matchMethod: 'ADMIN' });
      expect(r.matchDetail).toContain(`Merged by the administrator from publication ${remove.id} (duplicate candidate ${c.id}); previously`);
    }
    expect(moved.map((r) => r.matchDetail).some((d) => d!.includes('previously DOI: Matched on DOI'))).toBe(true);
    const merged = await prisma.duplicateCandidate.findUniqueOrThrow({ where: { id: c.id } });
    expect(merged).toMatchObject({ status: 'MERGED', resolvedByUserId: adminUser.id, resolvedAt: new Date(NOW) });
    expect([merged.publicationAId, merged.publicationBId]).toContain(keep.id);
    expect([merged.publicationAId, merged.publicationBId]).toContain(null); // the removed side (§6.10)
    expect(res.body.candidate).toMatchObject({ id: c.id, status: 'MERGED' });
  });

  it('either publication may be kept', async () => {
    const { server, admin } = await setup();
    const { keep, remove, c } = await mergeWorld();
    const res = await request(server).post(`/api/admin/duplicate-candidates/${c.id}/merge`).set('Cookie', admin).send({ keepPublicationId: remove.id });
    expect(res.status).toBe(200);
    expect(res.body.merge.removedPublicationId).toBe(keep.id);
    expect(await prisma.publicationSourceRecord.count({ where: { publicationId: remove.id } })).toBe(3);
  });

  it('consolidates relationships APPROVED > PENDING > REJECTED; ties keep the survivor’s; the winner keeps its decision metadata', async () => {
    const { server, admin, adminUser } = await setup();
    const { keep, remove, c } = await mergeWorld();
    const [p1, p2, p3, p4, p5, p6] = await Promise.all(['P1', 'P2', 'P3', 'P4', 'P5', 'P6'].map((n) => professor(n)));
    const decided = { decidedAt: new Date('2026-09-01T00:00:00Z'), decidedByUserId: adminUser.id };
    await link(p1.id, keep.id, 'PENDING');
    const p1Winner = await link(p1.id, remove.id, 'APPROVED', decided);
    await link(p2.id, keep.id, 'REJECTED', decided);
    const p2Winner = await link(p2.id, remove.id, 'PENDING');
    const p3Winner = await link(p3.id, keep.id, 'APPROVED', decided);
    await link(p3.id, remove.id, 'REJECTED', decided);
    const p4Winner = await link(p4.id, keep.id, 'PENDING');
    await link(p4.id, remove.id, 'PENDING');
    const p5Moved = await link(p5.id, remove.id, 'REJECTED', decided);
    const p6Kept = await link(p6.id, keep.id, 'APPROVED', decided);

    const res = await request(server).post(`/api/admin/duplicate-candidates/${c.id}/merge`).set('Cookie', admin).send({ keepPublicationId: keep.id });
    expect(res.status).toBe(200);
    expect(res.body.merge).toMatchObject({ relationshipsMoved: 3, relationshipsRemoved: 4 }); // moved: p1, p2, p5

    const rows = await prisma.professorPublication.findMany({ orderBy: { id: 'asc' } });
    expect(rows).toHaveLength(6);
    expect(rows.every((r) => r.publicationId === keep.id)).toBe(true);
    const byId = (id: string) => rows.find((r) => r.id === id);
    for (const winner of [p1Winner, p2Winner, p3Winner, p4Winner, p5Moved, p6Kept]) {
      expect(byId(winner.id), winner.id).toEqual({ ...winner, publicationId: keep.id, updatedAt: expect.any(Date) });
    }
    expect(byId(p1Winner.id)).toMatchObject({ status: 'APPROVED', decidedAt: decided.decidedAt, decidedByUserId: adminUser.id });
    expect(byId(p2Winner.id)?.status).toBe('PENDING');
  });

  it('re-points other open candidates, closes redundant ones, never reopens dismissed pairs, and keeps resolved history', async () => {
    const { server, admin } = await setup();
    const { keep, remove, c } = await mergeWorld();
    const x = await publication({ title: 'X' });
    const y = await publication({ title: 'Y' });
    const z = await publication({ title: 'Z' });
    const repoint = await candidate(remove.id, x.id);
    const dismissedPair = await candidate(keep.id, y.id, 'DISMISSED');
    const redundant = await candidate(remove.id, y.id);
    const history = await candidate(remove.id, z.id, 'DISMISSED');

    const res = await request(server).post(`/api/admin/duplicate-candidates/${c.id}/merge`).set('Cookie', admin).send({ keepPublicationId: keep.id });
    expect(res.body.merge).toMatchObject({ candidatesRepointed: 1, candidatesClosed: 1 });

    const after = await prisma.duplicateCandidate.findUniqueOrThrow({ where: { id: repoint.id } });
    expect(after.status).toBe('OPEN');
    expect([after.publicationAId, after.publicationBId]).toEqual(keep.id < x.id ? [keep.id, x.id] : [x.id, keep.id]);
    expect(await prisma.duplicateCandidate.findUniqueOrThrow({ where: { id: dismissedPair.id } })).toMatchObject({ status: 'DISMISSED' });
    const closed = await prisma.duplicateCandidate.findUniqueOrThrow({ where: { id: redundant.id } });
    expect(closed.status).toBe('DISMISSED');
    expect(closed.reason).toContain('the pair already exists');
    const kept = await prisma.duplicateCandidate.findUniqueOrThrow({ where: { id: history.id } });
    expect(kept).toMatchObject({ status: 'DISMISSED', reason: history.reason });
    expect([kept.publicationAId, kept.publicationBId]).toContain(null);
    // No pair exists twice.
    const pairs = (await prisma.duplicateCandidate.findMany()).filter((d) => d.publicationAId && d.publicationBId).map((d) => `${d.publicationAId}|${d.publicationBId}`);
    expect(new Set(pairs).size).toBe(pairs.length);
  });

  it('a curated survivor keeps its metadata; two suppressed publications merge and stay suppressed', async () => {
    const { server, admin } = await setup();
    const curated = await publication({ title: 'Curated title', isCurated: true, doi: null, records: [{ source: 'OPENALEX' }] });
    const other = await publication({ title: 'Raw title', doi: '10.1000/raw', records: [{ source: 'DBLP', doi: '10.1000/raw', venue: 'V' }] });
    const c1 = await candidate(curated.id, other.id);
    await request(server).post(`/api/admin/duplicate-candidates/${c1.id}/merge`).set('Cookie', admin).send({ keepPublicationId: curated.id }).expect(200);
    expect(await prisma.publication.findUniqueOrThrow({ where: { id: curated.id } })).toMatchObject({ title: 'Curated title', doi: null, venue: null, isCurated: true });

    const s1 = await publication({ status: 'SUPPRESSED' });
    const s2 = await publication({ status: 'SUPPRESSED' });
    const c2 = await candidate(s1.id, s2.id);
    const res = await request(server).post(`/api/admin/duplicate-candidates/${c2.id}/merge`).set('Cookie', admin).send({ keepPublicationId: s2.id });
    expect(res.status).toBe(200);
    expect(res.body.publication.status).toBe('SUPPRESSED');
  });

  it('refuses an active/suppressed pair, a publication outside the candidate, resolved and unknown candidates — changing nothing', async () => {
    const { server, admin } = await setup();
    const a = await publication();
    const s = await publication({ status: 'SUPPRESSED' });
    const mixed = await candidate(a.id, s.id);
    const b = await publication();
    const c = await publication();
    const ok = await candidate(b.id, c.id);
    const done = await candidate(a.id, b.id, 'DISMISSED');
    const before = await snapshot();
    const merge = (id: string, body: unknown) => request(server).post(`/api/admin/duplicate-candidates/${id}/merge`).set('Cookie', admin).send(body as object);

    const mismatch = await merge(mixed.id, { keepPublicationId: a.id });
    expect(mismatch.status).toBe(409);
    expect(mismatch.body.error.code).toBe('MERGE_STATUS_MISMATCH');
    expect((await merge(ok.id, { keepPublicationId: a.id })).body.error.code).toBe('INVALID_KEEP_PUBLICATION');
    expect((await merge(ok.id, { keepPublicationId: 'x' })).body.error.code).toBe('VALIDATION_ERROR');
    expect((await merge(ok.id, {})).body.error.code).toBe('VALIDATION_ERROR');
    expect((await merge(ok.id, { keepPublicationId: b.id, extra: 1 })).body.error.code).toBe('VALIDATION_ERROR');
    const resolved = await merge(done.id, { keepPublicationId: a.id });
    expect(resolved.body.error).toMatchObject({ code: 'CANDIDATE_NOT_OPEN', details: { currentStatus: 'DISMISSED' } });
    expect((await merge('00000000-0000-4000-8000-000000000001', { keepPublicationId: a.id })).body.error.code).toBe('CANDIDATE_NOT_FOUND');
    expect(await snapshot()).toEqual(before);
  });

  it('a failure part-way through rolls the whole merge back', async () => {
    const { server, admin } = await setup();
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { keep, remove, c } = await mergeWorld();
    const prof = await professor('P1');
    await link(prof.id, remove.id, 'APPROVED');
    await candidate(remove.id, (await publication({ title: 'X' })).id);
    const before = await snapshot();
    await withTrigger('publications', 'BEFORE DELETE', `RAISE EXCEPTION 'phase13b test: delete blocked';`, async () => {
      const res = await request(server).post(`/api/admin/duplicate-candidates/${c.id}/merge`).set('Cookie', admin).send({ keepPublicationId: keep.id });
      expect(res.status).toBe(500);
      expect(JSON.stringify(res.body)).not.toContain('phase13b');
    });
    expect(await snapshot()).toEqual(before);
  });

  it('two simultaneous merges of one candidate: exactly one succeeds', async () => {
    const { server, admin } = await setup();
    const { keep, c } = await mergeWorld();
    const results = await Promise.all(
      [0, 1].map(() => request(server).post(`/api/admin/duplicate-candidates/${c.id}/merge`).set('Cookie', admin).send({ keepPublicationId: keep.id })),
    );
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(results.find((r) => r.status === 409)!.body.error.code).toBe('CANDIDATE_NOT_OPEN');
    expect(await prisma.publication.count()).toBe(1);
  });
});

describe('POST /api/admin/source-records/:id/detach', () => {
  it('moves the record to a new ACTIVE publication with ADMIN provenance; relationships stay; both publications are recomputed', async () => {
    const { server, admin } = await setup();
    const p = await publication({
      title: 'Correct paper',
      doi: '10.1000/wrong',
      records: [
        { source: 'OPENALEX', doi: null, venue: null },
        { source: 'DBLP', title: 'A different paper', doi: '10.1000/wrong', venue: 'Elsewhere', year: 2011 },
      ],
    });
    const wrong = await prisma.publicationSourceRecord.findFirstOrThrow({ where: { publicationId: p.id, source: 'DBLP' } });
    const prof = await professor('P1');
    const rel = await link(prof.id, p.id, 'APPROVED');

    const res = await request(server).post(`/api/admin/source-records/${wrong.id}/detach`).set('Cookie', admin);
    expect(res.status).toBe(200);
    const created = res.body.publication;
    expect(created).toMatchObject({ title: 'A different paper', year: 2011, venue: 'Elsewhere', doi: '10.1000/wrong', status: 'ACTIVE', isCurated: false, sources: ['DBLP'], relationships: [] });
    expect(res.body.previousPublication).toMatchObject({ id: p.id, title: 'Correct paper', doi: null, venue: null, year: 2020, sources: ['OPENALEX'] });
    expect(await prisma.publicationSourceRecord.findUniqueOrThrow({ where: { id: wrong.id } })).toMatchObject({
      publicationId: created.id,
      matchMethod: 'ADMIN',
      matchDetail: `Detached by the administrator from publication ${p.id}`,
    });
    expect(await prisma.professorPublication.findMany()).toEqual([rel]); // nothing moved or created

    // The next synchronization of that record keeps it on its own publication (rule 1).
    const again = buildNormalizedPublication({ source: 'DBLP', externalId: wrong.externalId, title: 'A different paper', year: 2011, typeFamily: 'JOURNAL', dois: ['10.1000/wrong'] });
    expect(await ingestPublication(again)).toMatchObject({ outcome: 'UPDATED_EXISTING', publicationId: created.id });
  });

  it('a curated publication keeps its metadata; detaching from a suppressed publication creates an active one', async () => {
    const { server, admin } = await setup();
    const p = await publication({ title: 'Curated', isCurated: true, status: 'SUPPRESSED', records: [{ source: 'OPENALEX' }, { source: 'ORCID', title: 'Elsewhere' }] });
    const record = await prisma.publicationSourceRecord.findFirstOrThrow({ where: { publicationId: p.id, source: 'ORCID' } });
    const res = await request(server).post(`/api/admin/source-records/${record.id}/detach`).set('Cookie', admin);
    expect(res.status).toBe(200);
    expect(res.body.publication).toMatchObject({ title: 'Elsewhere', status: 'ACTIVE' });
    expect(await prisma.publication.findUniqueOrThrow({ where: { id: p.id } })).toEqual(expect.objectContaining({ title: 'Curated', status: 'SUPPRESSED', isCurated: true }));
  });

  it('refuses the only record of a publication and unknown records; a failure rolls back', async () => {
    const { server, admin } = await setup();
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const single = await publication();
    const only = await prisma.publicationSourceRecord.findFirstOrThrow({ where: { publicationId: single.id } });
    const multi = await publication({ records: [{ source: 'OPENALEX' }, { source: 'DBLP' }] });
    const record = await prisma.publicationSourceRecord.findFirstOrThrow({ where: { publicationId: multi.id, source: 'DBLP' } });
    const before = await snapshot();

    const last = await request(server).post(`/api/admin/source-records/${only.id}/detach`).set('Cookie', admin);
    expect(last.status).toBe(409);
    expect(last.body.error.code).toBe('LAST_SOURCE_RECORD');
    expect((await request(server).post('/api/admin/source-records/00000000-0000-4000-8000-000000000001/detach').set('Cookie', admin)).body.error.code).toBe('SOURCE_RECORD_NOT_FOUND');
    expect((await request(server).post('/api/admin/source-records/nope/detach').set('Cookie', admin)).status).toBe(404);

    await withTrigger('publication_source_records', 'BEFORE UPDATE', `RAISE EXCEPTION 'phase13b test: update blocked';`, async () => {
      expect((await request(server).post(`/api/admin/source-records/${record.id}/detach`).set('Cookie', admin)).status).toBe(500);
    });
    expect(await snapshot()).toEqual(before);

    // Two simultaneous detachments from a two-record publication: only one can succeed.
    const results = await Promise.all(
      (await prisma.publicationSourceRecord.findMany({ where: { publicationId: multi.id } })).map((r) =>
        request(server).post(`/api/admin/source-records/${r.id}/detach`).set('Cookie', admin),
      ),
    );
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(await prisma.publicationSourceRecord.count({ where: { publicationId: multi.id } })).toBe(1);
  });
});

describe('coordination with synchronization (#91)', () => {
  async function blockedRun() {
    const prof = await professor('Prof Sync');
    await prisma.externalIdentity.create({ data: { professorId: prof.id, source: 'OPENALEX', externalId: PRIEM } });
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const sync = syncService({ [AUTHOR_URL]: async () => (await gate, toResponse(loadFixture('openalex', 'author-valid'))) });
    return { sync, release };
  }

  it('merge and detach are refused with 409 while a run executes, then succeed after it; other edits stay available', async () => {
    const { sync, release } = await blockedRun();
    const { server, admin } = await setup(sync);
    const a = await publication({ title: 'Same' });
    const b = await publication({ title: 'Same', records: [{ source: 'ORCID' }, { source: 'MANUAL' }] });
    const c = await candidate(a.id, b.id);
    const record = await prisma.publicationSourceRecord.findFirstOrThrow({ where: { publicationId: b.id, source: 'MANUAL' } });

    await request(server).post('/api/admin/sync').set('Cookie', admin).expect(202);
    const before = await snapshot();
    const merge = await request(server).post(`/api/admin/duplicate-candidates/${c.id}/merge`).set('Cookie', admin).send({ keepPublicationId: a.id });
    expect(merge.status).toBe(409);
    expect(merge.body.error.code).toBe('SYNC_ALREADY_RUNNING');
    expect((await request(server).post(`/api/admin/source-records/${record.id}/detach`).set('Cookie', admin)).body.error.code).toBe('SYNC_ALREADY_RUNNING');
    expect(await snapshot()).toEqual(before);
    // Editing and suppressing do not conflict with synchronization (curated rows are never recomputed).
    expect((await request(server).patch(`/api/admin/publications/${a.id}`).set('Cookie', admin).send({ venue: 'Edited' })).status).toBe(200);

    release();
    await sync.idle();
    expect((await request(server).post(`/api/admin/duplicate-candidates/${c.id}/merge`).set('Cookie', admin).send({ keepPublicationId: a.id })).status).toBe(200);
  });

  it('a RUNNING run recorded in the database (another process, unrecovered crash) also blocks merge and detach', async () => {
    const { server, admin } = await setup();
    const a = await publication({ title: 'Same' });
    const b = await publication({ title: 'Same', records: [{ source: 'ORCID' }, { source: 'MANUAL' }] });
    const c = await candidate(a.id, b.id);
    const record = await prisma.publicationSourceRecord.findFirstOrThrow({ where: { publicationId: b.id, source: 'MANUAL' } });
    await prisma.syncRun.create({ data: { trigger: 'SCHEDULED', status: 'RUNNING' } });
    expect((await request(server).post(`/api/admin/duplicate-candidates/${c.id}/merge`).set('Cookie', admin).send({ keepPublicationId: a.id })).body.error.code).toBe('SYNC_ALREADY_RUNNING');
    expect((await request(server).post(`/api/admin/source-records/${record.id}/detach`).set('Cookie', admin)).body.error.code).toBe('SYNC_ALREADY_RUNNING');
    expect(await prisma.publication.count()).toBe(2);
  });

  it('a run started during an exclusive operation waits for it; a queued operation is then refused', async () => {
    const sync = syncService();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const order: string[] = [];
    let entered!: () => void;
    const inside = new Promise<void>((r) => (entered = r));
    const first = sync.exclusive(async () => {
      entered();
      await gate;
      order.push('first done');
      // The run cannot have been created while this operation was running.
      order.push(`runs during operation: ${await prisma.syncRun.count()}`);
    });
    await inside; // the first operation is running
    const queued = sync.exclusive(async () => void order.push('queued ran')).then(
      () => 'ran',
      (error: unknown) => error,
    );
    const started = sync.start('MANUAL', null).then((run) => (order.push('run started'), run));
    // Refused immediately: the run holds the guard from the moment start() was called.
    await expect(sync.exclusive(async () => undefined)).rejects.toBeInstanceOf(SyncAlreadyRunningError);

    await new Promise((r) => setTimeout(r, 50));
    expect(await prisma.syncRun.count()).toBe(0);
    release();
    await first;
    expect(await queued).toBeInstanceOf(SyncAlreadyRunningError);
    await started;
    await sync.idle();
    expect(order).toEqual(['first done', 'runs during operation: 0', 'run started']);
    expect(await prisma.syncRun.count()).toBe(1);

    // After the run, exclusive operations work again.
    await expect(sync.exclusive(async () => 'ok')).resolves.toBe('ok');
  });
});

describe('merges and concurrent manual entries (#96)', () => {
  const KEY = 4242;

  /** Holds a transaction-level advisory lock on another connection until released. */
  async function holdAdvisoryLock() {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let acquired!: () => void;
    const held = new Promise<void>((r) => (acquired = r));
    const done = prisma.$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(${KEY})`;
        acquired();
        await gate;
      },
      { timeout: 30_000 },
    );
    await held;
    return { release, done };
  }

  async function waitUntil(condition: () => Promise<boolean>, what: string) {
    for (let i = 0; i < 200; i++) {
      if (await condition()) return;
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error(`Timed out waiting for: ${what}`);
  }
  const manualBlocked = async () =>
    (await prisma.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory' AND NOT granted`)[0].n > 0;

  /** The manual entry's source-record insert waits on the advisory lock inside its transaction (after matching). */
  async function withBlockedManualInsert(run: () => Promise<void>) {
    await withTrigger('publication_source_records', 'BEFORE INSERT', `IF NEW.source = 'MANUAL' THEN PERFORM pg_advisory_xact_lock(${KEY}); END IF; RETURN NEW;`, run);
  }

  async function world() {
    const { server, admin } = await setup();
    const user = await createUser({ email: 'prof@example.org', professor: 'active' });
    const prof = await prisma.professor.findUniqueOrThrow({ where: { userId: user.id } });
    const keep = await publication({ title: 'Model checking', doi: null, records: [{ source: 'OPENALEX' }] });
    const remove = await publication({ title: 'Model checking of programs', doi: '10.1000/remove', records: [{ source: 'DBLP', doi: '10.1000/remove' }] });
    const c = await candidate(keep.id, remove.id);
    return { server, admin, user, prof, keep, remove, c };
  }

  it('a merge waits for a manual entry matching the removed publication by title; both complete', async () => {
    const { server, admin, user, prof, keep, remove, c } = await world();
    await withBlockedManualInsert(async () => {
      const lock = await holdAdvisoryLock();
      const manual = addManualPublication(prof.id, user.id, { title: 'Model checking of programs', typeFamily: 'JOURNAL', year: 2020 }, new Date(NOW));
      await waitUntil(manualBlocked, 'manual entry inside its transaction');

      const merge = request(server).post(`/api/admin/duplicate-candidates/${c.id}/merge`).set('Cookie', admin).send({ keepPublicationId: keep.id }).then((r) => r);
      // The merge cannot proceed while the manual entry holds the title.
      await new Promise((r) => setTimeout(r, 300));
      expect((await prisma.duplicateCandidate.findUniqueOrThrow({ where: { id: c.id } })).status).toBe('OPEN');
      expect(await prisma.publication.findUnique({ where: { id: remove.id } })).not.toBeNull();

      lock.release();
      await lock.done;
      const entry = await manual;
      expect(entry.match).toMatchObject({ outcome: 'MATCHED_TITLE_YEAR', relationship: 'CREATED' });
      const res = await merge;
      expect(res.status).toBe(200);
      expect(res.body.merge).toMatchObject({ sourceRecordsMoved: 2, relationshipsMoved: 1 });
    });
    // The manual record and the professor's approval followed the merge to the survivor.
    expect(await prisma.publicationSourceRecord.findFirstOrThrow({ where: { source: 'MANUAL' } })).toMatchObject({ publicationId: keep.id });
    expect(await prisma.professorPublication.findMany({ where: { professorId: prof.id } })).toEqual([
      expect.objectContaining({ publicationId: keep.id, status: 'APPROVED', origin: 'MANUAL' }),
    ]);
    expect(await prisma.publication.count()).toBe(1);
  });

  it('a manual entry matching the removed publication by DOI is re-matched to the survivor instead of failing', async () => {
    const { server, admin, user, prof, keep, remove, c } = await world();
    await withBlockedManualInsert(async () => {
      const lock = await holdAdvisoryLock();
      const manual = addManualPublication(prof.id, user.id, { title: 'Model checking of programs: an extended study', typeFamily: 'JOURNAL', year: 2020, doi: '10.1000/REMOVE' }, new Date(NOW)).then(
        (value) => ({ value }),
        (error: unknown) => ({ error }),
      );
      await waitUntil(manualBlocked, 'manual entry inside its transaction');

      // A different normalized title (no shared title lock): the merge completes while the manual
      // entry, already matched to the removed publication by DOI, waits inside its transaction.
      const res = await request(server).post(`/api/admin/duplicate-candidates/${c.id}/merge`).set('Cookie', admin).send({ keepPublicationId: keep.id });
      expect(res.status).toBe(200);
      expect(await prisma.publication.findUnique({ where: { id: remove.id } })).toBeNull();

      lock.release();
      await lock.done;
      const outcome = await manual;
      expect(outcome).not.toHaveProperty('error');
      expect((outcome as { value: { match: unknown } }).value.match).toMatchObject({ outcome: 'MATCHED_DOI', relationship: 'CREATED' });
    });
    expect(await prisma.publicationSourceRecord.findFirstOrThrow({ where: { source: 'MANUAL' } })).toMatchObject({ publicationId: keep.id, matchMethod: 'DOI' });
    expect(await prisma.professorPublication.findMany({ where: { professorId: prof.id } })).toEqual([
      expect.objectContaining({ publicationId: keep.id, status: 'APPROVED', origin: 'MANUAL' }),
    ]);
  });

  it('a title that appears after the locks were chosen makes the merge refuse with 409 MERGE_CONFLICT and change nothing', async () => {
    const { server, admin, keep, remove, c } = await world();
    const before = await snapshot();
    // A source-record title that changes after the titles were locked (simulated inside the merge's
    // transaction, just before its revalidation).
    await withTrigger(
      'duplicate_candidates',
      'BEFORE UPDATE',
      `UPDATE publication_source_records SET normalized_title = 'retitled meanwhile' WHERE publication_id = '${remove.id}'; RETURN NEW;`,
      async () => {
        const res = await request(server).post(`/api/admin/duplicate-candidates/${c.id}/merge`).set('Cookie', admin).send({ keepPublicationId: keep.id });
        expect(res.status).toBe(409);
        expect(res.body.error.code).toBe('MERGE_CONFLICT');
      },
    );
    expect(await snapshot()).toEqual(before); // the trigger's own change was rolled back with the merge
  });
});

