import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '../../src/config/database';
import { cookiePair, createUser, PASSWORD } from '../auth/helpers';
import { resetDatabase } from '../helpers/database';
import { inQueryTransaction, matchingSetFingerprint } from '../../src/services/publicationQuery/execute';
import { link, professor, professorSession, publication, setup } from '../publications/helpers';

/*
 * POST /api/admin/publication-queries/analytics (Project_plan.md §24.6; decisions D4, D5, D6,
 * D10; stage Q4): analytics over exactly the publications the query returns, the D5 threshold, the
 * relevance matrix, qualifying links vs selected professors, Scopus availability and missing
 * counts, admin-only access, and the department-wide analytics staying unchanged.
 * Synthetic rows only; no network.
 */

const BASE = '/api/admin/publication-queries';
const DEPARTMENT = ['overview', 'professors', 'years', 'sources', 'sync', 'citations'].map((p) => `/api/admin/analytics/${p}`);

beforeEach(async () => {
  await resetDatabase();
});

afterAll(async () => {
  await resetDatabase();
  await prisma.$disconnect();
});

const cond = (field: string, operator: string, value?: unknown) => ({ field, operator, ...(value !== undefined && { value }) });
const and = (...children: unknown[]) => ({ combinator: 'AND', children });
const ANY_APPROVED = { mode: 'ANY_PROFESSOR', statuses: ['APPROVED'] };
const ALL = { mode: 'ALL_PUBLICATIONS', statuses: ['APPROVED'] };
const D3 = and(cond('publicationStatus', 'in', ['ACTIVE']), cond('type', 'notIn', ['PREPRINT']));

/**
 * P1, P2 active; P3 inactive.
 *   a  journal 2024 "Journal of Graphs", DOI, OpenAlex + Scopus — P1 APPROVED, P2 APPROVED
 *   b  conference 2022 "Graph Conference", DOI, DBLP — P1 APPROVED, P2 PENDING (MANUAL)
 *   c  journal 2021 "journal of  graphs", DOI, ORCID + Scopus — P3 APPROVED (inactive)
 *   d  preprint 2023, no DOI, OpenAlex — P1 APPROVED
 *   e  journal 2020 SUPPRESSED, DOI, Scopus — P2 APPROVED
 *   f  journal 2019, DOI, DBLP — P1 REJECTED only
 *   g  journal 2018, DOI, DBLP — no relationship
 */
async function world() {
  const { server, admin } = await setup();
  const [p1, p2, p3] = [await professor('Prof One'), await professor('Prof Two'), await professor('Prof Three', false)];
  const a = await publication({ title: 'Alpha joint', year: 2024, type: 'JOURNAL', records: [{ source: 'OPENALEX' }, { source: 'SCOPUS' }] });
  const b = await publication({ title: 'Beta conference', year: 2022, type: 'CONFERENCE', records: [{ source: 'DBLP' }] });
  const c = await publication({ title: 'Gamma inactive', year: 2021, type: 'JOURNAL', records: [{ source: 'ORCID' }, { source: 'SCOPUS' }] });
  const d = await publication({ title: 'Delta preprint', year: 2023, type: 'PREPRINT', doi: null, records: [{ source: 'OPENALEX' }] });
  const e = await publication({ title: 'Epsilon suppressed', year: 2020, type: 'JOURNAL', status: 'SUPPRESSED', records: [{ source: 'SCOPUS' }] });
  const f = await publication({ title: 'Zeta rejected', year: 2019, type: 'JOURNAL', records: [{ source: 'DBLP' }] });
  const g = await publication({ title: 'Eta unlinked', year: 2018, type: 'JOURNAL', records: [{ source: 'DBLP' }] });
  await prisma.publication.update({ where: { id: a.id }, data: { venue: 'Journal of Graphs' } });
  await prisma.publication.update({ where: { id: b.id }, data: { venue: 'Graph Conference' } });
  await prisma.publication.update({ where: { id: c.id }, data: { venue: 'journal of  graphs' } });
  await link(p1.id, a.id, 'APPROVED');
  await link(p2.id, a.id, 'APPROVED');
  await link(p1.id, b.id, 'APPROVED');
  await link(p2.id, b.id, 'PENDING');
  await prisma.professorPublication.updateMany({ where: { professorId: p2.id, publicationId: b.id }, data: { origin: 'MANUAL' } });
  await link(p3.id, c.id, 'APPROVED');
  await link(p1.id, d.id, 'APPROVED');
  await link(p2.id, e.id, 'APPROVED');
  await link(p1.id, f.id, 'REJECTED');
  const post = (path: string, body: unknown, cookie = admin) => request(server).post(`${BASE}/${path}`).set('Cookie', cookie).send(body as object);
  const analytics = async (body: unknown) => {
    const res = await post('analytics', body);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    return res.body;
  };
  const searchTotal = async (body: unknown) => (await post('search', body)).body.total;
  return { server, admin, p1, p2, p3, a, b, c, d, e, f, g, post, analytics, searchTotal };
}

async function observe(publicationId: string, count: number, at = '2026-06-01T00:00:00Z') {
  const record = await prisma.publicationSourceRecord.findFirstOrThrow({ where: { publicationId, source: 'SCOPUS' } });
  await prisma.citationObservation.create({ data: { sourceRecordId: record.id, provider: 'SCOPUS', count, observedAt: new Date(at) } });
}

describe('access and validation', () => {
  it('admin only: no session 401, professors FORBIDDEN, temporary password refused, no-store, foreign Origin refused', async () => {
    const { server, admin } = await setup();
    const prof = await professorSession(server, 'prof@example.org');
    await createUser({ email: 'temp-admin@example.org', role: 'ADMIN', mustChangePassword: true });
    const temp = cookiePair(await request(server).post('/api/auth/login').send({ email: 'temp-admin@example.org', password: PASSWORD }), 'cse_session');
    const path = `${BASE}/analytics`;
    const body = { link: ANY_APPROVED };
    expect((await request(server).post(path).send(body)).status).toBe(401);
    expect((await request(server).post(path).set('Cookie', prof.cookie).send(body)).body.error.code).toBe('FORBIDDEN');
    expect((await request(server).post(path).set('Cookie', temp).send(body)).body.error.code).toBe('PASSWORD_CHANGE_REQUIRED');
    const ok = await request(server).post(path).set('Cookie', admin).send(body);
    expect(ok.status).toBe(200);
    expect(ok.headers['cache-control']).toContain('no-store');
    expect((await request(server).post(path).set('Cookie', admin).set('Origin', 'https://evil.example').send(body)).body.error.code).toBe('ORIGIN_NOT_ALLOWED');
    // Professors have no analytics endpoint at all.
    expect((await request(server).post('/api/me/publication-queries/analytics').set('Cookie', prof.cookie).send({})).status).toBe(404);
  });

  it('validates the body with the shared validator; client IDs or counts cannot define the population', async () => {
    const w = await world();
    for (const body of [
      {},
      { link: ANY_APPROVED, publicationIds: [w.a.id, w.b.id] },
      { link: ANY_APPROVED, total: 99 },
      { link: { ...ANY_APPROVED, departmentId: 'x' } },
      { link: ANY_APPROVED, root: and(cond('keywords', 'contains', 'x')) },
    ]) {
      const res = await w.post('analytics', body);
      expect([res.status, res.body.error.code], JSON.stringify(body)).toEqual([400, 'VALIDATION_ERROR']);
    }
    const unknown = await w.post('analytics', { link: { mode: 'SELECTED', statuses: ['APPROVED'], professors: ['00000000-0000-4000-8000-000000000000'] } });
    expect(unknown.body.error.code).toBe('PROFESSOR_NOT_FOUND');
  });
});

describe('population and thresholds', () => {
  it('uses exactly the matching set: suppressed publications and preprints are included when the query permits them', async () => {
    const w = await world();
    const all = await w.analytics({ link: ALL });
    expect(all.total).toBe(7);
    expect(all.total).toBe(await w.searchTotal({ link: ALL }));
    expect(all.analytics.types).toEqual([
      { typeFamily: 'JOURNAL', publications: 5 },
      { typeFamily: 'CONFERENCE', publications: 1 },
      { typeFamily: 'PREPRINT', publications: 1 },
    ]);
    expect(all.analytics.publicationStatuses).toEqual([
      { status: 'ACTIVE', publications: 6 },
      { status: 'SUPPRESSED', publications: 1 },
    ]);
    expect(all.analytics.years).toMatchObject({ total: 7, unknownYear: 0 });
    // ANY professor APPROVED without the D3 conditions: the preprint and the suppressed paper count.
    const approved = await w.analytics({ link: ANY_APPROVED });
    expect(approved.total).toBe(5);
    expect(approved.analytics.types.map((t: { typeFamily: string }) => t.typeFamily)).toContain('PREPRINT');
    // With the D3 conditions kept, the population is the department's.
    const department = await w.analytics({ link: ANY_APPROVED, root: D3 });
    const overview = (await request(w.server).get('/api/admin/analytics/overview').set('Cookie', w.admin)).body.overview;
    expect(department.total).toBe(overview.uniquePublications);
    expect(department.analytics.publicationStatuses).toBeUndefined();
    expect(department.analytics.types).toEqual([
      { typeFamily: 'JOURNAL', publications: 2 },
      { typeFamily: 'CONFERENCE', publications: 1 },
    ]);
    // Totals always equal the search's total for the same query.
    for (const body of [{ link: { mode: 'NO_LINK', statuses: ['APPROVED'] } }, { link: { mode: 'ANY_PROFESSOR', statuses: ['APPROVED', 'PENDING', 'REJECTED'] } }]) {
      expect((await w.analytics(body)).total).toBe(await w.searchTotal(body));
    }
  });

  it('D5: zero and one match return no analytics; two or more do', async () => {
    const w = await world();
    expect(await w.analytics({ link: ANY_APPROVED, root: and(cond('year', 'eq', 1999)) })).toMatchObject({ total: 0, analytics: null });
    expect(await w.analytics({ link: { mode: 'NO_LINK', statuses: ['APPROVED'] } })).toMatchObject({ total: 1, analytics: null });
    const two = await w.analytics({ link: ALL, root: and(cond('year', 'gte', 2023)) });
    expect(two.total).toBe(2);
    expect(two.analytics).not.toBeNull();
  });

  it('relevance matrix: a section only when its dimension has two or more values', async () => {
    const w = await world();
    // a and c: both journals with a DOI, two venue spellings of one venue, two years.
    const pair = await w.analytics({ link: ALL, root: and(cond('title', 'contains', 'a'), cond('type', 'in', ['JOURNAL']), cond('year', 'between', [2021, 2024])) });
    expect(pair.total).toBe(2);
    expect(pair.analytics.years.years.map((y: { year: number }) => y.year)).toEqual([2021, 2024]);
    expect(pair.analytics.types).toBeUndefined(); // one type
    expect(pair.analytics.venues).toBeUndefined(); // one venue, ignoring case and spacing
    expect(pair.analytics.doi).toBeUndefined(); // all with a DOI
    expect(pair.analytics.publicationStatuses).toBeUndefined();
    expect(pair.analytics.sources.map((s: { source: string }) => s.source)).toEqual(['OPENALEX', 'ORCID', 'SCOPUS']);
    // Everything: venues, DOI coverage, sources, statuses.
    const all = (await w.analytics({ link: ALL })).analytics;
    expect(all.venues).toEqual({ venues: [{ venue: 'Journal of Graphs', publications: 2 }, { venue: 'Graph Conference', publications: 1 }], otherVenues: 0, withoutVenue: 4 });
    expect(all.doi).toEqual({ withDoi: 6, withoutDoi: 1 });
    expect(all.sources).toEqual([
      { source: 'OPENALEX', publications: 2, sourceRecords: 2 },
      { source: 'DBLP', publications: 3, sourceRecords: 3 },
      { source: 'ORCID', publications: 1, sourceRecords: 1 },
      { source: 'SCOPUS', publications: 3, sourceRecords: 3 },
    ]);
    // Operational department sections are never part of conditional analytics.
    for (const key of ['overview', 'pendingVerifications', 'lastSync', 'sync', 'stored']) expect(all).not.toHaveProperty(key);
  });
});

describe('professors: qualifying links vs selected professors', () => {
  it('ANY_PROFESSOR lists every professor with a qualifying link, inactive included', async () => {
    const w = await world();
    const rows = (await w.analytics({ link: ANY_APPROVED })).analytics.professors.rows;
    expect(rows.map((r: { name: string; publications: number; selected: boolean; isActive: boolean }) => [r.name, r.publications, r.selected, r.isActive])).toEqual([
      ['Prof One', 3, false, true],
      ['Prof Two', 2, false, true],
      ['Prof Three', 1, false, false],
    ]);
  });

  it('SELECTED + ANY keeps unselected co-authors with qualifying links, flagged as not selected', async () => {
    const w = await world();
    const res = (await w.analytics({ link: { mode: 'SELECTED', statuses: ['APPROVED'], professors: [w.p2.id], match: 'ANY' } })).analytics;
    // P2's matches: a (with P1) and e. P1 qualifies on a without being selected.
    expect(res.professors.rows.map((r: { name: string; publications: number; selected: boolean }) => [r.name, r.publications, r.selected])).toEqual([
      ['Prof Two', 2, true],
      ['Prof One', 1, false],
    ]);
    expect(res.professors.selectedCount).toBe(1);
    expect(res.overlap).toBeUndefined(); // one selected professor
  });

  it('overlap of the selected professors; relationship statuses over qualifying links', async () => {
    const w = await world();
    const any = (await w.analytics({ link: { mode: 'SELECTED', statuses: ['APPROVED', 'PENDING'], professors: [w.p1.id, w.p2.id], match: 'ANY' } })).analytics;
    expect(any.overlap).toEqual({ publications: 2, selected: 2 }); // a (both APPROVED) and b (APPROVED + PENDING)
    expect(any.relationshipStatuses).toEqual([
      { status: 'APPROVED', links: 5, publications: 4 },
      { status: 'PENDING', links: 1, publications: 1 },
    ]);
    // Only APPROVED in the link scope: no relationship-status section.
    expect((await w.analytics({ link: { mode: 'SELECTED', statuses: ['APPROVED'], professors: [w.p1.id, w.p2.id], match: 'ANY' } })).analytics.relationshipStatuses).toBeUndefined();
  });

  it('no per-professor section for SELECTED + ALL, NO_LINK, or fewer than two qualifying professors', async () => {
    const w = await world();
    const all = await w.analytics({ link: { mode: 'SELECTED', statuses: ['APPROVED', 'PENDING'], professors: [w.p1.id, w.p2.id], match: 'ALL' } });
    expect(all.total).toBe(2);
    expect(all.analytics.professors).toBeUndefined();
    expect(all.analytics.overlap).toBeUndefined();
    await prisma.publication.create({ data: { title: 'Second unlinked', normalizedTitle: 'second unlinked', year: 2017, typeFamily: 'JOURNAL' } });
    const noLink = await w.analytics({ link: { mode: 'NO_LINK', statuses: ['APPROVED'] } });
    expect(noLink.total).toBe(2);
    expect(noLink.analytics.professors).toBeUndefined();
    expect(noLink.analytics.relationshipStatuses).toBeUndefined();
    const single = await w.analytics({ link: { mode: 'SELECTED', statuses: ['APPROVED'], professors: [w.p1.id], match: 'ANY' }, root: and(cond('title', 'contains', 'beta'), cond('year', 'gte', 2000)) });
    expect(single.total).toBe(1);
  });

  it('origin and decision date apply to the same row in the breakdown', async () => {
    const w = await world();
    // Qualifying = PENDING and MANUAL on one row: only P2's link to b; no breakdown with one professor.
    const res = await w.analytics({ link: { mode: 'ALL_PUBLICATIONS', statuses: ['APPROVED', 'PENDING'], origins: ['MANUAL'] } });
    expect(res.analytics.professors).toBeUndefined();
    expect(res.analytics.relationshipStatuses).toBeUndefined(); // only PENDING occurs among qualifying links
  });
});

describe('Scopus citations', () => {
  it('unavailable data: a note, never zeros; citation conditions refused with 409', async () => {
    const w = await world();
    expect((await w.analytics({ link: ALL })).analytics.citations).toEqual({ available: false });
    expect((await w.post('analytics', { link: ALL, root: and(cond('scopusCitations', 'noCount')) })).body.error.code).toBe('CITATION_DATA_UNAVAILABLE');
  });

  it('missing observations are not zero; totals, median and maximum use counted publications only', async () => {
    const w = await world();
    await observe(w.a.id, 0); // a counted zero
    await observe(w.c.id, 7);
    await observe(w.c.id, 9, '2026-08-01T00:00:00Z'); // the latest observation wins
    // e has a Scopus record without an observation (no count yet); b, d, f, g are not in Scopus.
    const res = (await w.analytics({ link: ALL })).analytics.citations;
    expect(res).toMatchObject({
      available: true,
      withCount: 2,
      coverage: { withCount: 2, withoutCount: 5, notInScopus: 4, noCountYet: 1 },
      totalCitations: 9,
      median: 4.5,
      maximum: 9,
    });
    expect(res.top.map((t: { title: string; count: number }) => [t.title, t.count])).toEqual([
      ['Gamma inactive', 9],
      ['Alpha joint', 0],
    ]);
    expect(new Date(res.latestObservation).toISOString()).toBe('2026-08-01T00:00:00.000Z');
    // Data exists, but none of these matches has a count.
    const none = (await w.analytics({ link: ALL, root: and(cond('source', 'noneOf', ['SCOPUS'])) })).analytics.citations;
    expect(none).toEqual({ available: true, withCount: 0, coverage: { withCount: 0, withoutCount: 4, notInScopus: 4, noCountYet: 0 } });
    // Citation conditions now work and narrow the population exactly.
    const cited = await w.analytics({ link: ALL, root: and(cond('scopusCitations', 'hasCount')) });
    expect(cited.total).toBe(2);
    expect(cited.analytics.citations.withCount).toBe(2);
  });
});

describe('department-wide analytics', () => {
  it('stay unchanged by conditional analytics', async () => {
    const w = await world();
    const snapshot = async () => Promise.all(DEPARTMENT.map(async (path) => (await request(w.server).get(path).set('Cookie', w.admin)).body));
    const before = await snapshot();
    await w.analytics({ link: ALL });
    await w.analytics({ link: { mode: 'SELECTED', statuses: ['APPROVED', 'PENDING'], professors: [w.p1.id, w.p2.id], match: 'ANY' } });
    expect(await snapshot()).toEqual(before);
    // The department years endpoint still applies its own policy (ACTIVE, not PREPRINT, APPROVED link).
    expect((await request(w.server).get(DEPARTMENT[2]).set('Cookie', w.admin)).body).toEqual({
      years: [
        { year: 2021, publications: 1 },
        { year: 2022, publications: 1 },
        { year: 2024, publications: 1 },
      ],
      unknownYear: 0,
      total: 3,
    });
  });
});

describe('per professor under ALL_PUBLICATIONS (§24.6 clarification, #164)', () => {
  it('is shown with two or more qualifying professors; the exclusions stay', async () => {
    const w = await world();
    const all = (await w.analytics({ link: ALL })).analytics;
    // Qualifying = APPROVED links of any professor, on every publication; selected applies to none.
    expect(all.professors.rows.map((r: { name: string; publications: number; selected: boolean }) => [r.name, r.publications, r.selected])).toEqual([
      ['Prof One', 3, false],
      ['Prof Two', 2, false],
      ['Prof Three', 1, false],
    ]);
    // ALL_PUBLICATIONS whose qualifying links involve fewer than two professors: no section.
    expect((await w.analytics({ link: { mode: 'ALL_PUBLICATIONS', statuses: ['REJECTED'] } })).analytics.professors).toBeUndefined();
    expect((await w.analytics({ link: { mode: 'SELECTED', statuses: ['APPROVED'], professors: [w.p1.id, w.p2.id], match: 'ALL' }, root: and(cond('year', 'gte', 2000)) })).analytics).toBeNull(); // one match
    expect((await w.analytics({ link: { mode: 'SELECTED', statuses: ['APPROVED', 'PENDING'], professors: [w.p1.id, w.p2.id], match: 'ALL' } })).analytics.professors).toBeUndefined();
  });
});

describe('snapshot consistency and matching-set fingerprints (Q4 review, #163)', () => {
  it('every query request runs read-only, REPEATABLE READ, with the 5 s statement timeout', async () => {
    const settings = await inQueryTransaction(prisma, undefined, async (tx) =>
      tx.$queryRaw<{ iso: string; ro: string; timeout: string }[]>`SELECT current_setting('transaction_isolation') AS iso, current_setting('transaction_read_only') AS ro, current_setting('statement_timeout') AS timeout`,
    );
    expect(settings).toEqual([{ iso: 'repeatable read', ro: 'on', timeout: '5s' }]);
  });

  it('all statements of one request see the same snapshot, even when data changes meanwhile', async () => {
    await publication({ title: 'Before' });
    const seen = await inQueryTransaction(prisma, undefined, async (tx) => {
      const first = await tx.publication.count();
      await publication({ title: 'Committed in between' }); // another connection, committed
      const second = await tx.publication.count();
      return { first, second };
    });
    expect(seen).toEqual({ first: 1, second: 1 });
    expect(await prisma.publication.count()).toBe(2);
  });

  it('fingerprints depend only on the set of IDs', () => {
    const [a, b, c] = ['0b0e…a', '1c2d…b', 'ffff…c'];
    expect(matchingSetFingerprint([a, b, c])).toBe(matchingSetFingerprint([c, a, b]));
    expect(matchingSetFingerprint([a, b])).not.toBe(matchingSetFingerprint([a, c]));
    expect(matchingSetFingerprint([a, b])).not.toBe(matchingSetFingerprint([a, b, c]));
    expect(matchingSetFingerprint([])).toMatch(/^[0-9a-f]{64}$/);
  });

  it('search and analytics return the same fingerprint for the same set, across pages and sorts; it changes with the set; no IDs are disclosed', async () => {
    const w = await world();
    const body = { link: ALL };
    const page1 = (await w.post('search', { ...body, limit: 2 })).body;
    const page2 = (await w.post('search', { ...body, limit: 2, offset: 2, sort: 'title' })).body;
    const analytics = await w.analytics(body);
    expect(page1.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(page2.fingerprint).toBe(page1.fingerprint);
    expect(analytics.fingerprint).toBe(page1.fingerprint);
    const all = await prisma.publication.findMany({ select: { id: true } });
    expect(page1.fingerprint).toBe(matchingSetFingerprint(all.map((p) => p.id)));
    for (const p of all) {
      expect(JSON.stringify({ f: analytics.fingerprint })).not.toContain(p.id);
    }
    // Same total, different set: the fingerprint differs.
    const withoutAlpha = await w.analytics({ link: ALL, root: and(cond('title', 'notContains', 'alpha')) });
    const withoutBeta = await w.analytics({ link: ALL, root: and(cond('title', 'notContains', 'beta')) });
    expect(withoutBeta.total).toBe(withoutAlpha.total);
    expect(withoutBeta.fingerprint).not.toBe(withoutAlpha.fingerprint);
    await publication({ title: 'Theta added' });
    // The same query after a change in the data: a new fingerprint for search and analytics alike.
    const after = (await w.post('search', body)).body;
    expect(after.fingerprint).not.toBe(page1.fingerprint);
    expect((await w.analytics(body)).fingerprint).toBe(after.fingerprint);
    // Zero / one match also carry a fingerprint.
    expect((await w.analytics({ link: ALL, root: and(cond('year', 'eq', 1999)) })).fingerprint).toBe(matchingSetFingerprint([]));
  });

  it('a zero-match admin search and its analytics return identical, valid fingerprints', async () => {
    const w = await world();
    const body = { link: ANY_APPROVED, root: and(cond('year', 'eq', 1999)) };
    const search = (await w.post('search', body)).body;
    const analytics = await w.analytics(body);
    expect(search).toMatchObject({ total: 0, publications: [] });
    expect(analytics).toMatchObject({ total: 0, analytics: null });
    expect(search.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(analytics.fingerprint).toBe(search.fingerprint);
    expect(search.fingerprint).toBe(matchingSetFingerprint([]));
  });

  it('professor searches carry the fingerprint of their own set', async () => {
    const w = await world();
    const me = await professorSession(w.server, 'me@example.org');
    await link(me.prof.id, w.a.id, 'APPROVED');
    const res = await request(w.server).post('/api/me/publication-queries/search').set('Cookie', me.cookie).send({});
    expect(res.body.fingerprint).toBe(matchingSetFingerprint([w.a.id]));
  });
});
