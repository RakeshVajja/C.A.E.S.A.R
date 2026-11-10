import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '../../src/config/database';
import { cookiePair, createUser, PASSWORD } from '../auth/helpers';
import { resetDatabase } from '../helpers/database';
import { link, professor, professorSession, publication, setup } from '../publications/helpers';

/*
 * /api/me/publication-queries (Project_plan.md §24.8; decisions #154–#157, stage Q2): session and
 * role checks, the professor scope (own APPROVED links, ACTIVE publications), professor-only
 * metadata, preset building, tampered bodies, paging, sorting and the three citation states.
 * Synthetic rows only; no network.
 */

const BASE = '/api/me/publication-queries';

beforeEach(async () => {
  await resetDatabase();
});

afterAll(async () => {
  await resetDatabase();
  await prisma.$disconnect();
});

const cond = (field: string, operator: string, value?: unknown) => ({ field, operator, ...(value !== undefined && { value }) });
const and = (...children: unknown[]) => ({ combinator: 'AND', children });

/**
 * me: mine2024 (journal, APPROVED, SCOPUS record), mine2022 (conference, APPROVED), mine2019
 * (journal, APPROVED, no DOI), pending (PENDING), rejected (REJECTED), hidden (SUPPRESSED, APPROVED).
 * other professor: theirs (APPROVED for them only).
 */
async function world() {
  const { server, admin } = await setup();
  const me = await professorSession(server, 'me@example.org');
  const other = await professor('Other Prof');
  const mine2024 = await publication({ title: 'Alpha graphs', year: 2024, type: 'JOURNAL', records: [{ source: 'OPENALEX' }, { source: 'SCOPUS' }] });
  const mine2022 = await publication({ title: 'Beta networks', year: 2022, type: 'CONFERENCE', records: [{ source: 'DBLP' }, { source: 'SCOPUS' }] });
  const mine2019 = await publication({ title: 'Gamma databases', year: 2019, type: 'JOURNAL', doi: null, records: [{ source: 'ORCID' }] });
  const pending = await publication({ title: 'Pending paper', year: 2024 });
  const rejected = await publication({ title: 'Rejected paper', year: 2024 });
  const hidden = await publication({ title: 'Hidden paper', year: 2024, status: 'SUPPRESSED' });
  const theirs = await publication({ title: 'Their paper', year: 2024, records: [{ source: 'SCOPUS' }] });
  await prisma.publication.update({ where: { id: mine2024.id }, data: { venue: 'Journal of Graphs' } });
  for (const p of [mine2024, mine2022, mine2019, hidden]) await link(me.prof.id, p.id, 'APPROVED');
  await link(me.prof.id, pending.id, 'PENDING');
  await link(me.prof.id, rejected.id, 'REJECTED');
  await link(other.id, theirs.id, 'APPROVED');
  const search = (body: unknown, cookie = me.cookie) => request(server).post(`${BASE}/search`).set('Cookie', cookie).send(body as object);
  return { server, admin, me, other, mine2024, mine2022, mine2019, pending, rejected, hidden, theirs, search };
}

async function observe(publicationId: string, count: number, at = '2026-06-01T00:00:00Z') {
  const record = await prisma.publicationSourceRecord.findFirstOrThrow({ where: { publicationId, source: 'SCOPUS' } });
  await prisma.citationObservation.create({ data: { sourceRecordId: record.id, provider: 'SCOPUS', count, observedAt: new Date(at) } });
}

describe('access', () => {
  it('needs a session, the PROFESSOR role and a changed password; responses are not cached', async () => {
    const { server, admin, me } = await world();
    await createUser({ email: 'temp@example.org', professor: 'active', mustChangePassword: true });
    const temp = cookiePair(await request(server).post('/api/auth/login').send({ email: 'temp@example.org', password: PASSWORD }), 'cse_session');
    for (const [method, path] of [
      ['get', `${BASE}/fields`],
      ['get', `${BASE}/presets`],
      ['get', `${BASE}/presets/recent`],
      ['post', `${BASE}/search`],
    ] as const) {
      expect((await request(server)[method](path).send({})).status, path).toBe(401);
      const asAdmin = await request(server)[method](path).set('Cookie', admin).send({});
      expect([asAdmin.status, asAdmin.body.error.code], path).toEqual([403, 'FORBIDDEN']);
      expect((await request(server)[method](path).set('Cookie', temp).send({})).body.error.code, path).toBe('PASSWORD_CHANGE_REQUIRED');
      const ok = await request(server)[method](path).set('Cookie', me.cookie).send({});
      expect(ok.status, path).toBe(200);
      expect(ok.headers['cache-control'], path).toContain('no-store');
    }
    const foreign = await request(server).post(`${BASE}/search`).set('Cookie', me.cookie).set('Origin', 'https://evil.example').send({});
    expect(foreign.body.error.code).toBe('ORIGIN_NOT_ALLOWED');
  });

  it('only returns the professor’s own APPROVED, ACTIVE publications', async () => {
    const w = await world();
    const res = await w.search({ limit: 100 });
    expect(res.body.total).toBe(3);
    expect(res.body.publications.map((p: { id: string }) => p.id).sort()).toEqual([w.mine2024.id, w.mine2022.id, w.mine2019.id].sort());
    // Conditions only narrow the scope: an OR that names the others' data still returns own rows only.
    const wide = await w.search({ root: { combinator: 'OR', children: [cond('title', 'contains', 'their'), cond('title', 'contains', 'hidden'), cond('title', 'contains', 'pending')] } });
    expect(wide.body.total).toBe(0);
  });

  it('refuses admin-only fields and scope controls in the body (400), and returns no admin-only data', async () => {
    const w = await world();
    for (const body of [
      { link: { mode: 'ALL_PUBLICATIONS', statuses: ['APPROVED'] } },
      { professorId: w.other.id },
      { root: and(cond('publicationStatus', 'in', ['SUPPRESSED'])) },
      { root: and(cond('curated', 'is', true)) },
      { root: and(cond('linkedProfessors', 'gte', 1)) },
      { root: and(cond('title', 'like', 'x')) },
      { sort: 'status' },
      { limit: 101 },
    ]) {
      const res = await w.search(body);
      expect([res.status, res.body.error.code], JSON.stringify(body)).toEqual([400, 'VALIDATION_ERROR']);
    }
    const res = await w.search({});
    for (const row of res.body.publications) {
      expect(row).not.toHaveProperty('status');
      expect(row).not.toHaveProperty('isCurated');
      expect(row).not.toHaveProperty('professors');
      expect(row).not.toHaveProperty('rawMetadata');
    }
    expect(res.body).not.toHaveProperty('link');
  });
});

describe('metadata', () => {
  it('lists only professor fields and presets, with Scopus availability', async () => {
    const w = await world();
    const fields = (await request(w.server).get(`${BASE}/fields`).set('Cookie', w.me.cookie)).body;
    const ids = fields.fields.map((f: { id: string }) => f.id);
    expect(ids).toEqual(['year', 'type', 'title', 'venue', 'authors', 'doi', 'source', 'issn', 'addedOn', 'scopusCitations']);
    expect(fields).not.toHaveProperty('link');
    expect(fields.scopus).toEqual({ available: false });
    expect(fields.fields.find((f: { id: string }) => f.id === 'scopusCitations')).toMatchObject({ available: false, unavailableReason: expect.any(String) });
    expect(fields.sorts).toContainEqual({ key: 'scopusCitations', available: false });
    expect(fields.limits).toMatchObject({ pageDefault: 25, pageMax: 100 });

    const presets = (await request(w.server).get(`${BASE}/presets`).set('Cookie', w.me.cookie)).body.presets;
    expect(presets.map((p: { id: string }) => p.id)).toEqual([
      'recent', 'journalArticles', 'conferencePapers', 'booksAndChapters', 'preprints', 'publishedInYear',
      'withDoi', 'withoutDoi', 'venueContains', 'reportedByScopus', 'manualEntries', 'citedInScopus',
    ]);
    expect(presets.find((p: { id: string }) => p.id === 'citedInScopus')).toMatchObject({ available: false });

    await observe(w.mine2024.id, 3);
    const after = (await request(w.server).get(`${BASE}/fields`).set('Cookie', w.me.cookie)).body;
    expect(after.scopus).toEqual({ available: true });
    expect(after.fields.find((f: { id: string }) => f.id === 'scopusCitations').available).toBe(true);
  });

  it('builds presets on the server, with parameters validated', async () => {
    const w = await world();
    const get = (path: string) => request(w.server).get(`${BASE}/presets/${path}`).set('Cookie', w.me.cookie);
    // D7: the current year (server time zone) and the four before it; NOW is 2026-10-26.
    expect((await get('recent')).body.query).toEqual({ root: and(cond('year', 'between', [2022, 2026])) });
    expect((await get('publishedInYear?value=2019')).body.query).toEqual({ root: and(cond('year', 'eq', 2019)) });
    expect((await get('venueContains?value=Graphs')).body.query).toEqual({ root: and(cond('venue', 'contains', 'Graphs')) });
    expect((await get('publishedInYear')).body.error.code).toBe('VALIDATION_ERROR');
    expect((await get('publishedInYear?value=abc')).body.error.code).toBe('VALIDATION_ERROR');
    expect((await get('publishedInYear?value=2019&extra=1')).body.error.code).toBe('VALIDATION_ERROR');
    for (const adminOnly of ['pendingVerification', 'suppressed', 'curated', 'coAuthored', 'unknown']) {
      const res = await get(adminOnly);
      expect([res.status, res.body.error.code], adminOnly).toEqual([404, 'PRESET_NOT_FOUND']);
    }
    const cited = await get('citedInScopus');
    expect([cited.status, cited.body.error.code]).toEqual([409, 'CITATION_DATA_UNAVAILABLE']);

    // A built preset runs as a normal query.
    const recent = await w.search({ ...(await get('recent')).body.query });
    expect(recent.body.total).toBe(2);
  });
});

describe('search', () => {
  it('pages and sorts on the server', async () => {
    const w = await world();
    const first = await w.search({ sort: 'title', limit: 2, offset: 0 });
    expect(first.body).toMatchObject({ total: 3, limit: 2, offset: 0, sort: 'title' });
    expect(first.body.publications.map((p: { title: string }) => p.title)).toEqual(['Alpha graphs', 'Beta networks']);
    const second = await w.search({ sort: 'title', limit: 2, offset: 2 });
    expect(second.body.publications.map((p: { title: string }) => p.title)).toEqual(['Gamma databases']);
    const byYear = await w.search({});
    expect(byYear.body.publications.map((p: { year: number }) => p.year)).toEqual([2024, 2022, 2019]);
    expect(byYear.body).toMatchObject({ limit: 25, offset: 0, sort: 'year' });
    const empty = await w.search({ root: and(cond('year', 'eq', 1999)) });
    expect(empty.body).toMatchObject({ total: 0, publications: [] });
  });

  it('refuses citation filters and sorting while Scopus data is unavailable (409), and omits citation fields', async () => {
    const w = await world();
    for (const body of [{ root: and(cond('scopusCitations', 'gte', 1)) }, { root: and(cond('scopusCitations', 'noCount')) }, { sort: 'scopusCitations' }]) {
      const res = await w.search(body);
      expect([res.status, res.body.error.code], JSON.stringify(body)).toEqual([409, 'CITATION_DATA_UNAVAILABLE']);
    }
    const res = await w.search({});
    expect(res.body.citations).toEqual({ available: false });
    for (const row of res.body.publications) {
      expect(row).not.toHaveProperty('scopusCitation');
      expect(row).not.toHaveProperty('scopusCitationState');
    }
  });

  it('reports the three citation states distinctly (#157), counted zero included', async () => {
    const w = await world();
    await observe(w.mine2024.id, 0); // COUNTED with zero
    await observe(w.theirs.id, 50); // another professor's count is never disclosed
    // mine2022 has a Scopus record but no observation (NO_COUNT_YET); mine2019 has none (NOT_IN_SCOPUS).
    const res = await w.search({ limit: 100 });
    const byId = Object.fromEntries(res.body.publications.map((p: { id: string }) => [p.id, p]));
    expect(byId[w.mine2024.id]).toMatchObject({ scopusCitationState: 'COUNTED', scopusCitation: { count: 0 } });
    expect(byId[w.mine2022.id]).toMatchObject({ scopusCitationState: 'NO_COUNT_YET', scopusCitation: null });
    expect(byId[w.mine2019.id]).toMatchObject({ scopusCitationState: 'NOT_IN_SCOPUS', scopusCitation: null });
    expect(res.body.citations).toMatchObject({ available: true, coverage: { withCount: 1, withoutCount: 2, notInScopus: 1, noCountYet: 1 } });

    const sorted = await w.search({ sort: 'scopusCitations' });
    expect(sorted.status).toBe(200);
    const counted = await w.search({ root: and(cond('scopusCitations', 'hasCount')) });
    expect(counted.body.publications.map((p: { id: string }) => p.id)).toEqual([w.mine2024.id]);
    expect((await request(w.server).get(`${BASE}/presets/citedInScopus`).set('Cookie', w.me.cookie)).status).toBe(200);
  });
});
