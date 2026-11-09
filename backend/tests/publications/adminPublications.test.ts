import request from 'supertest';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { prisma } from '../../src/config/database';
import { overview } from '../../src/services/analytics/analytics';
import { updatePublication } from '../../src/services/publications/adminPublications';
import { ingestPublication, recomputeCanonical, Tx } from '../../src/services/matching/engine';
import { buildNormalizedPublication } from '../../src/services/normalization/normalizedPublication';
import { SyncAlreadyRunningError } from '../../src/services/sync/syncService';
import { cookiePair, createUser, PASSWORD } from '../auth/helpers';
import { resetDatabase } from '../helpers/database';
import { loadFixture, toResponse } from '../helpers/fixtures';
import { INDEPENDENT_ENTRY } from '../helpers/basis';
import { AUTHOR_URL, candidate, link, NOW, PRIEM, professor, publication, setup, snapshot, syncService, withTrigger } from './helpers';

/* Administrator publication management (Project_plan.md §15.1; Phase 13B, #90–#95). Duplicate candidates are the professors' (#149; professorDuplicates.test.ts). No network. */

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

const PUB_ROUTES = (id: string) => [
  ['get', '/api/admin/publications'],
  ['get', `/api/admin/publications/${id}`],
  ['patch', `/api/admin/publications/${id}`],
  ['patch', `/api/admin/publications/${id}/status`],
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
    await candidate(p.id, q.id);
    const bodies = [
      await request(server).get('/api/admin/publications').set('Cookie', admin),
      await request(server).get(`/api/admin/publications/${p.id}`).set('Cookie', admin),
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
  it('returns source-record summaries and relationships, no candidates (#149); unknown and malformed IDs are 404', async () => {
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
    expect(c.status).toBe('OPEN');
    expect(detail).not.toHaveProperty('duplicateCandidates');

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
      .send({ ...INDEPENDENT_ENTRY, title: '  The Correct <i>Title</i>: Ünïcode ', year: 2019, venue: 'ICSE', typeFamily: 'CONFERENCE', authorNames: 'A. Author; B. Author', doi: 'https://doi.org/10.1145/ABC.123' });
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
    const cleared = await request(server).patch(`/api/admin/publications/${p.id}`).set('Cookie', admin).send({ ...INDEPENDENT_ENTRY, doi: null, venue: '', year: null });
    expect(cleared.body.publication).toMatchObject({ doi: null, venue: null, year: null, isCurated: true });
  });

  it('a curated edit survives later synchronization of its source records', async () => {
    const { server, admin } = await setup();
    const p = await publication({ title: 'Source title', records: [{ source: 'DBLP' }] });
    const record = await prisma.publicationSourceRecord.findFirstOrThrow({ where: { publicationId: p.id } });
    await request(server).patch(`/api/admin/publications/${p.id}`).set('Cookie', admin).send({ ...INDEPENDENT_ENTRY, title: 'Curated title', year: 2001 }).expect(200);

    // The source reports the record again (rule 1: update in place) with different metadata.
    const again = buildNormalizedPublication({ source: 'DBLP', externalId: record.externalId, title: 'Source title, revised', year: 2020, typeFamily: 'JOURNAL', dois: ['10.1000/new'] });
    const result = await ingestPublication(again, { seenAt: new Date(NOW) });
    expect(result).toMatchObject({ outcome: 'UPDATED_EXISTING', publicationId: p.id });
    expect(await prisma.publication.findUniqueOrThrow({ where: { id: p.id } })).toMatchObject({ title: 'Curated title', year: 2001, isCurated: true });
    expect(await prisma.publicationSourceRecord.findUniqueOrThrow({ where: { id: record.id } })).toMatchObject({ title: 'Source title, revised', doi: '10.1000/new' });
  });

  it('an edit made while a synchronization recompute is in flight waits for it and is never overwritten (#90, #125)', async () => {
    const p = await publication({ title: 'Source title', records: [{ source: 'DBLP' }] });
    await prisma.publicationSourceRecord.updateMany({ where: { publicationId: p.id }, data: { title: 'Source title v2', normalizedTitle: 'source title v2' } });
    let edit: Promise<unknown> | undefined;
    let editSettled = false;
    await prisma.$transaction(async (tx) => {
      // The recompute has locked and read the (not yet curated) publication; the administrator's
      // edit starts on another connection before the recompute writes, and must wait for it.
      const interleaved = new Proxy(tx, {
        get(target, key) {
          if (key !== 'publication') return Reflect.get(target, key);
          return new Proxy(target.publication, {
            get(model, method) {
              if (method !== 'findUniqueOrThrow') return Reflect.get(model, method);
              return async (args: Parameters<typeof model.findUniqueOrThrow>[0]) => {
                const row = await model.findUniqueOrThrow(args);
                edit = updatePublication(p.id, { title: 'Curated title', ...INDEPENDENT_ENTRY }).finally(() => {
                  editSettled = true;
                });
                await new Promise((resolve) => setTimeout(resolve, 300));
                expect(editSettled).toBe(false);
                return row;
              };
            },
          });
        },
      }) as Tx;
      await recomputeCanonical(interleaved, p.id);
    });
    await edit;
    expect(await prisma.publication.findUniqueOrThrow({ where: { id: p.id } })).toMatchObject({
      title: 'Curated title',
      isCurated: true,
      curation: { title: { basis: 'INDEPENDENT', evidence: INDEPENDENT_ENTRY.evidence } },
    });
    await prisma.$transaction((tx) => recomputeCanonical(tx, p.id));
    expect(await prisma.publication.findUniqueOrThrow({ where: { id: p.id } })).toMatchObject({ title: 'Curated title' });
  });

  it('refuses invalid input, a DOI owned by another publication, and unknown publications', async () => {
    const { server, admin } = await setup();
    const p = await publication();
    const owner = await publication({ doi: '10.1000/taken' });
    const before = await snapshot();
    const patch = (body: object, id = p.id) => request(server).patch(`/api/admin/publications/${id}`).set('Cookie', admin).send({ ...INDEPENDENT_ENTRY, ...body });

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

  it('detach is refused with 409 while a run executes, then succeeds after it; other edits stay available', async () => {
    const { sync, release } = await blockedRun();
    const { server, admin } = await setup(sync);
    const a = await publication({ title: 'Same' });
    const b = await publication({ title: 'Same', records: [{ source: 'ORCID' }, { source: 'MANUAL' }] });
    const record = await prisma.publicationSourceRecord.findFirstOrThrow({ where: { publicationId: b.id, source: 'MANUAL' } });

    await request(server).post('/api/admin/sync').set('Cookie', admin).expect(202);
    const before = await snapshot();
    expect((await request(server).post(`/api/admin/source-records/${record.id}/detach`).set('Cookie', admin)).body.error.code).toBe('SYNC_ALREADY_RUNNING');
    expect(await snapshot()).toEqual(before);
    // Editing and suppressing do not conflict with synchronization (curated rows are never recomputed).
    expect((await request(server).patch(`/api/admin/publications/${a.id}`).set('Cookie', admin).send({ ...INDEPENDENT_ENTRY, venue: 'Edited' })).status).toBe(200);

    release();
    await sync.idle();
    expect((await request(server).post(`/api/admin/source-records/${record.id}/detach`).set('Cookie', admin)).status).toBe(200);
  });

  it('a RUNNING run recorded in the database (another process, unrecovered crash) also blocks detach', async () => {
    const { server, admin } = await setup();
    const b = await publication({ title: 'Same', records: [{ source: 'ORCID' }, { source: 'MANUAL' }] });
    const record = await prisma.publicationSourceRecord.findFirstOrThrow({ where: { publicationId: b.id, source: 'MANUAL' } });
    await prisma.syncRun.create({ data: { trigger: 'SCHEDULED', status: 'RUNNING' } });
    expect((await request(server).post(`/api/admin/source-records/${record.id}/detach`).set('Cookie', admin)).body.error.code).toBe('SYNC_ALREADY_RUNNING');
    expect(await prisma.publication.count()).toBe(1);
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

describe('duplicate-candidate resolution is not an administrator function (#149)', () => {
  it('the former admin candidate endpoints no longer exist and change nothing', async () => {
    const { server, admin } = await setup();
    const a = await publication({ title: 'Same' });
    const b = await publication({ title: 'Same' });
    const c = await candidate(a.id, b.id);
    const before = await snapshot();
    for (const [method, path, body] of [
      ['get', '/api/admin/duplicate-candidates', undefined],
      ['post', `/api/admin/duplicate-candidates/${c.id}/dismiss`, undefined],
      ['post', `/api/admin/duplicate-candidates/${c.id}/merge`, { keepPublicationId: a.id }],
    ] as const) {
      const res = await request(server)[method](path).set('Cookie', admin).send(body ?? {});
      expect(res.status, path).toBe(404);
      expect(res.body.error.code, path).toBe('NOT_FOUND');
    }
    expect(await snapshot()).toEqual(before);
  });
});
