import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '../../src/config/database';
import { cookiePair, createUser, PASSWORD } from '../auth/helpers';
import { resetDatabase } from '../helpers/database';
import { link, professor, professorSession, publication, setup } from '../publications/helpers';

/*
 * /api/admin/publication-queries (Project_plan.md §24.4–§24.8; decisions #154–#159, stage Q3):
 * admin-only access, the four link-scope modes, SELECTED ANY / ALL, the 50-professor limit,
 * inactive and unknown professors, same-row relationship conditions, NO_LINK, the D2 / D3
 * department population, admin presets, admin-only row data, paging, sorting, validation, and the
 * department-wide analytics staying unchanged. Synthetic rows only; no network.
 */

const BASE = '/api/admin/publication-queries';
const ANALYTICS = ['overview', 'professors', 'years', 'sources', 'sync', 'citations'].map((p) => `/api/admin/analytics/${p}`);

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
const D3 = and(cond('publicationStatus', 'in', ['ACTIVE']), cond('type', 'notIn', ['PREPRINT']));

/**
 * P1, P2 active; P3 inactive.
 *   a  journal 2024 — P1 APPROVED, P2 APPROVED (joint)
 *   b  conference 2022 — P1 APPROVED, P2 PENDING (origin MANUAL)
 *   c  journal 2021 — P3 APPROVED (inactive professor only)
 *   d  preprint 2023 — P1 APPROVED
 *   e  journal 2020 SUPPRESSED — P2 APPROVED
 *   f  journal 2019 — P1 REJECTED only
 *   g  journal 2018 — no relationship
 */
async function world() {
  const { server, admin } = await setup();
  const [p1, p2, p3] = [await professor('Prof One'), await professor('Prof Two'), await professor('Prof Three', false)];
  const a = await publication({ title: 'Alpha joint', year: 2024, type: 'JOURNAL' });
  const b = await publication({ title: 'Beta conference', year: 2022, type: 'CONFERENCE' });
  const c = await publication({ title: 'Gamma inactive', year: 2021, type: 'JOURNAL' });
  const d = await publication({ title: 'Delta preprint', year: 2023, type: 'PREPRINT' });
  const e = await publication({ title: 'Epsilon suppressed', year: 2020, type: 'JOURNAL', status: 'SUPPRESSED' });
  const f = await publication({ title: 'Zeta rejected', year: 2019, type: 'JOURNAL' });
  const g = await publication({ title: 'Eta unlinked', year: 2018, type: 'JOURNAL' });
  await link(p1.id, a.id, 'APPROVED', { decidedAt: new Date('2026-03-10T12:00:00Z') });
  await link(p2.id, a.id, 'APPROVED', { decidedAt: new Date('2026-05-01T00:00:00Z') });
  await link(p1.id, b.id, 'APPROVED', { decidedAt: new Date('2026-03-10T12:00:00Z') });
  await link(p2.id, b.id, 'PENDING');
  await prisma.professorPublication.updateMany({ where: { professorId: p2.id, publicationId: b.id }, data: { origin: 'MANUAL' } });
  await link(p3.id, c.id, 'APPROVED');
  await link(p1.id, d.id, 'APPROVED');
  await link(p2.id, e.id, 'APPROVED');
  await link(p1.id, f.id, 'REJECTED');
  const search = (body: unknown, cookie = admin) => request(server).post(`${BASE}/search`).set('Cookie', cookie).send(body as object);
  const titles = async (body: unknown) => {
    const res = await search({ limit: 100, ...(body as object) });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    return res.body.publications.map((p: { title: string }) => p.title).sort();
  };
  return { server, admin, p1, p2, p3, a, b, c, d, e, f, g, search, titles };
}

describe('access', () => {
  it('admin only: no session 401, professors FORBIDDEN, temporary password refused, no-store, foreign Origin refused', async () => {
    const { server, admin } = await setup();
    const prof = await professorSession(server, 'prof@example.org');
    await createUser({ email: 'temp-admin@example.org', role: 'ADMIN', mustChangePassword: true });
    const temp = cookiePair(await request(server).post('/api/auth/login').send({ email: 'temp-admin@example.org', password: PASSWORD }), 'cse_session');
    for (const [method, path, body] of [
      ['get', `${BASE}/fields`, undefined],
      ['get', `${BASE}/presets`, undefined],
      ['get', `${BASE}/presets/recent`, undefined],
      ['post', `${BASE}/search`, { link: ANY_APPROVED }],
    ] as const) {
      expect((await request(server)[method](path).send(body)).status, path).toBe(401);
      const asProfessor = await request(server)[method](path).set('Cookie', prof.cookie).send(body);
      expect([asProfessor.status, asProfessor.body.error.code], path).toEqual([403, 'FORBIDDEN']);
      expect((await request(server)[method](path).set('Cookie', temp).send(body)).body.error.code, path).toBe('PASSWORD_CHANGE_REQUIRED');
      const ok = await request(server)[method](path).set('Cookie', admin).send(body);
      expect(ok.status, path).toBe(200);
      expect(ok.headers['cache-control'], path).toContain('no-store');
    }
    const foreign = await request(server).post(`${BASE}/search`).set('Cookie', admin).set('Origin', 'https://evil.example').send({ link: ANY_APPROVED });
    expect(foreign.body.error.code).toBe('ORIGIN_NOT_ALLOWED');
  });

  it('professor endpoints stay professor-only and never accept admin scope controls', async () => {
    const { server, admin } = await setup();
    const prof = await professorSession(server, 'prof@example.org');
    for (const path of ['/api/me/publication-queries/fields', '/api/me/publication-queries/presets']) {
      expect((await request(server).get(path).set('Cookie', admin)).body.error.code).toBe('FORBIDDEN');
    }
    const tampered = await request(server).post('/api/me/publication-queries/search').set('Cookie', prof.cookie).send({ link: ANY_APPROVED });
    expect([tampered.status, tampered.body.error.code]).toEqual([400, 'VALIDATION_ERROR']);
    const fields = (await request(server).get('/api/me/publication-queries/fields').set('Cookie', prof.cookie)).body;
    expect(fields).not.toHaveProperty('link');
    expect(fields).not.toHaveProperty('defaultQuery');
  });
});

describe('metadata and presets', () => {
  it('fields include admin-only fields, link options and the D2 / D3 initial query', async () => {
    const { server, admin } = await setup();
    const body = (await request(server).get(`${BASE}/fields`).set('Cookie', admin)).body;
    expect(body.fields.map((f: { id: string }) => f.id)).toEqual(expect.arrayContaining(['publicationStatus', 'curated', 'linkedProfessors']));
    expect(body.link).toEqual({ modes: ['ANY_PROFESSOR', 'SELECTED', 'NO_LINK', 'ALL_PUBLICATIONS'], statuses: ['APPROVED', 'PENDING', 'REJECTED'], origins: ['DISCOVERED', 'MANUAL', 'ADMIN'], maxProfessors: 50 });
    expect(body.defaultQuery).toEqual({ link: ANY_APPROVED, root: D3 });
    const presets = (await request(server).get(`${BASE}/presets`).set('Cookie', admin)).body.presets.map((p: { id: string }) => p.id);
    expect(presets).toEqual(expect.arrayContaining(['recent', 'withDoi', 'pendingVerification', 'rejectedLinks', 'jointPublications', 'coAuthored', 'withoutProfessorLink', 'suppressed', 'curated']));
  });

  it('builds admin presets on the server, with defaults dropped only where contradicted', async () => {
    const w = await world();
    const get = (path: string) => request(w.server).get(`${BASE}/presets/${path}`).set('Cookie', w.admin);
    expect((await get('recent')).body.query).toEqual({ link: ANY_APPROVED, root: and(...D3.children, cond('year', 'between', [2022, 2026])) });
    expect((await get('pendingVerification')).body.query.link).toEqual({ mode: 'ANY_PROFESSOR', statuses: ['PENDING'] });
    expect((await get('withoutProfessorLink')).body.query.link.mode).toBe('NO_LINK');
    expect((await get('preprints')).body.query.root).toEqual(and(cond('publicationStatus', 'in', ['ACTIVE']), cond('type', 'in', ['PREPRINT'])));
    expect((await get('suppressed')).body.query.root).toEqual(and(cond('type', 'notIn', ['PREPRINT']), cond('publicationStatus', 'in', ['SUPPRESSED'])));
    const joint = (await get(`jointPublications?value=${w.p1.id},${w.p2.id}`)).body.query;
    expect(joint.link).toEqual({ mode: 'SELECTED', statuses: ['APPROVED'], professors: [w.p1.id, w.p2.id], match: 'ALL' });
    const run = await w.search({ ...joint, limit: 100 });
    expect(run.body.publications.map((p: { title: string }) => p.title)).toEqual(['Alpha joint']);
    for (const bad of ['jointPublications', 'jointPublications?value=not-a-uuid', `jointPublications?value=${Array.from({ length: 51 }, () => w.p1.id).join(',')}`, 'publishedInYear?value=abc']) {
      expect((await get(bad)).body.error.code, bad).toBe('VALIDATION_ERROR');
    }
    expect((await get('nope')).status).toBe(404);
    expect((await get('citedInScopus')).body.error.code).toBe('CITATION_DATA_UNAVAILABLE');
  });
});

describe('joint-publications preset (acceptance audit)', () => {
  it('needs 2–50 different, valid professor IDs and produces SELECTED + ALL', async () => {
    const w = await world();
    const get = (value: string) => request(w.server).get(`${BASE}/presets/jointPublications?value=${value}`).set('Cookie', w.admin);
    const uuid = (i: number) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`;
    for (const value of [w.p1.id, `${w.p1.id},${w.p1.id}`, `${w.p1.id},${w.p1.id.toUpperCase()}`, `${w.p1.id},x`, Array.from({ length: 51 }, (_, i) => uuid(i)).join(',')]) {
      const res = await get(value);
      expect([res.status, res.body.error?.code], value.slice(0, 80)).toEqual([400, 'VALIDATION_ERROR']);
    }
    const fifty = await get(Array.from({ length: 50 }, (_, i) => uuid(i)).join(','));
    expect(fifty.status).toBe(200);
    expect(fifty.body.query.link).toMatchObject({ mode: 'SELECTED', match: 'ALL' });
    expect(fifty.body.query.link.professors).toHaveLength(50);
    // Built queries are still checked on execution: unknown professors are refused.
    expect((await w.search(fifty.body.query)).body.error.code).toBe('PROFESSOR_NOT_FOUND');
    const three = (await get(`${w.p1.id},${w.p2.id},${w.p3.id}`)).body.query;
    expect(three.link).toEqual({ mode: 'SELECTED', statuses: ['APPROVED'], professors: [w.p1.id, w.p2.id, w.p3.id], match: 'ALL' });
    expect(await w.titles(three)).toEqual([]);
  });
});

describe('linked professors on result rows (acceptance audit)', () => {
  type Mark = { name: string; status: string; qualifying: boolean; selected: boolean; isActive: boolean };
  const marks = (row: { professors: Mark[] }) => row.professors.map((p) => `${p.name}:${p.status}:${p.qualifying ? 'Q' : '-'}:${p.selected ? 'S' : '-'}${p.isActive ? '' : ':inactive'}`);
  const row = async (w: Awaited<ReturnType<typeof world>>, link: unknown, title: string) => {
    const res = await w.search({ link, root: and(cond('title', 'contains', title)) });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    return res.body.publications[0];
  };

  it('lists every linked professor and marks qualifying links by status, origin and decision date of the same row', async () => {
    const w = await world();
    // b: P1 APPROVED / DISCOVERED / decided 2026-03-10; P2 PENDING / MANUAL / undecided.
    expect(marks(await row(w, { mode: 'ALL_PUBLICATIONS', statuses: ['APPROVED'] }, 'beta'))).toEqual(['Prof One:APPROVED:Q:-', 'Prof Two:PENDING:-:-']);
    expect(marks(await row(w, { mode: 'ALL_PUBLICATIONS', statuses: ['APPROVED', 'PENDING'], origins: ['MANUAL'] }, 'beta'))).toEqual(['Prof One:APPROVED:-:-', 'Prof Two:PENDING:Q:-']);
    // a: P1 decided 2026-03-10, P2 decided 2026-05-01.
    expect(marks(await row(w, { mode: 'ANY_PROFESSOR', statuses: ['APPROVED'], decidedOn: { after: '2026-04-01' } }, 'alpha'))).toEqual(['Prof One:APPROVED:-:-', 'Prof Two:APPROVED:Q:-']);
    // f: only a REJECTED link — listed, never qualifying for APPROVED.
    expect(marks(await row(w, { mode: 'ALL_PUBLICATIONS', statuses: ['APPROVED'] }, 'zeta'))).toEqual(['Prof One:REJECTED:-:-']);
    // g: no relationship.
    expect((await row(w, { mode: 'ALL_PUBLICATIONS', statuses: ['APPROVED'] }, 'unlinked')).professors).toEqual([]);
    // c: inactive professor, listed and qualifying (§24.5: active or inactive).
    expect(marks(await row(w, ANY_APPROVED, 'gamma'))).toEqual(['Prof Three:APPROVED:Q:-:inactive']);
  });

  it('marks selected professors first; qualifying follows §24.5 (status / origin / date), independent of the selection', async () => {
    const w = await world();
    const sel = (professors: string[], match: string) => ({ mode: 'SELECTED', statuses: ['APPROVED'], professors, match });
    expect(marks(await row(w, sel([w.p2.id], 'ANY'), 'alpha'))).toEqual(['Prof Two:APPROVED:Q:S', 'Prof One:APPROVED:Q:-']);
    expect(marks(await row(w, sel([w.p1.id, w.p2.id], 'ALL'), 'alpha'))).toEqual(['Prof One:APPROVED:Q:S', 'Prof Two:APPROVED:Q:S']);
    // ANY: b matches through P1 only; P2 is selected but its PENDING link does not qualify.
    expect(marks(await row(w, sel([w.p1.id, w.p2.id], 'ANY'), 'beta'))).toEqual(['Prof One:APPROVED:Q:S', 'Prof Two:PENDING:-:S']);
    // linkedProfessors counts professors with a qualifying link (§24.5), as the marks do.
    expect(await w.titles({ link: sel([w.p1.id], 'ANY'), root: and(cond('linkedProfessors', 'gte', 2)) })).toEqual(['Alpha joint']);
    expect(await w.titles({ link: { mode: 'ANY_PROFESSOR', statuses: ['APPROVED'], origins: ['MANUAL'] }, root: and(cond('linkedProfessors', 'eq', 0)) })).toEqual([]);
  });

  it('professor endpoints never return linked-professor, status or curated data', async () => {
    const w = await world();
    const me = await professorSession(w.server, 'me@example.org');
    await link(me.prof.id, w.a.id, 'APPROVED');
    const res = await request(w.server).post('/api/me/publication-queries/search').set('Cookie', me.cookie).send({});
    expect(res.body.publications).toHaveLength(1);
    for (const key of ['professors', 'status', 'isCurated']) expect(res.body.publications[0]).not.toHaveProperty(key);
    expect(JSON.stringify(res.body)).not.toMatch(/Prof One|Prof Two|qualifying/);
  });
});

describe('link scope', () => {
  it('the initial query (D2, D3) is exactly the department analytics population', async () => {
    const w = await world();
    const res = await w.search({ link: ANY_APPROVED, root: D3, limit: 100 });
    const overview = (await request(w.server).get('/api/admin/analytics/overview').set('Cookie', w.admin)).body.overview;
    expect(res.body.total).toBe(overview.uniquePublications);
    expect(res.body.publications.map((p: { title: string }) => p.title).sort()).toEqual(['Alpha joint', 'Beta conference', 'Gamma inactive']); // inactive professor included
  });

  it('ANY_PROFESSOR, NO_LINK and ALL_PUBLICATIONS', async () => {
    const w = await world();
    expect(await w.titles({ link: ANY_APPROVED })).toEqual(['Alpha joint', 'Beta conference', 'Delta preprint', 'Epsilon suppressed', 'Gamma inactive']);
    expect(await w.titles({ link: { mode: 'ANY_PROFESSOR', statuses: ['REJECTED'] } })).toEqual(['Zeta rejected']);
    // NO_LINK: no relationship of any status — the REJECTED-only and PENDING-linked publications do not match.
    expect(await w.titles({ link: { mode: 'NO_LINK', statuses: ['APPROVED'] } })).toEqual(['Eta unlinked']);
    expect((await w.titles({ link: { mode: 'ALL_PUBLICATIONS', statuses: ['APPROVED'] } })).length).toBe(7);
  });

  it('SELECTED with ANY and ALL, inactive professors selectable, duplicates ignored', async () => {
    const w = await world();
    const sel = (professors: string[], match?: string, statuses = ['APPROVED']) => ({ link: { mode: 'SELECTED', statuses, professors, ...(match && { match }) } });
    expect(await w.titles(sel([w.p1.id, w.p2.id], 'ANY'))).toEqual(['Alpha joint', 'Beta conference', 'Delta preprint', 'Epsilon suppressed']);
    expect(await w.titles(sel([w.p1.id, w.p2.id], 'ALL'))).toEqual(['Alpha joint']);
    expect(await w.titles(sel([w.p1.id, w.p2.id], 'ALL', ['APPROVED', 'PENDING']))).toEqual(['Alpha joint', 'Beta conference']);
    expect(await w.titles(sel([w.p1.id, w.p2.id, w.p3.id], 'ALL'))).toEqual([]);
    expect(await w.titles(sel([w.p3.id]))).toEqual(['Gamma inactive']);
    expect(await w.titles(sel([w.p1.id, w.p1.id], 'ALL'))).toEqual(await w.titles(sel([w.p1.id], 'ANY')));
  });

  it('enforces at most 50 selected professors and refuses unknown ones', async () => {
    const w = await world();
    const many = [];
    for (let i = 0; i < 51; i++) many.push((await professor(`Extra ${i}`)).id);
    const fifty = await w.search({ link: { mode: 'SELECTED', statuses: ['APPROVED'], professors: many.slice(0, 50) } });
    expect(fifty.status).toBe(200);
    const fiftyOne = await w.search({ link: { mode: 'SELECTED', statuses: ['APPROVED'], professors: many } });
    expect([fiftyOne.status, fiftyOne.body.error.code]).toEqual([400, 'VALIDATION_ERROR']);
    const unknown = await w.search({ link: { mode: 'SELECTED', statuses: ['APPROVED'], professors: ['00000000-0000-4000-8000-000000000000'] } });
    expect([unknown.status, unknown.body.error.code]).toEqual([400, 'PROFESSOR_NOT_FOUND']);
  });

  it('status, origin and decision date apply to one and the same relationship row', async () => {
    const w = await world();
    // b: P1 APPROVED (DISCOVERED) and P2 PENDING (MANUAL) — no single row is APPROVED and MANUAL.
    expect(await w.titles({ link: { mode: 'ANY_PROFESSOR', statuses: ['APPROVED'], origins: ['MANUAL'] } })).toEqual([]);
    expect(await w.titles({ link: { mode: 'ANY_PROFESSOR', statuses: ['PENDING'], origins: ['MANUAL'] } })).toEqual(['Beta conference']);
    // a: P1 decided 2026-03-10, P2 2026-05-01; P1 must be both selected and decided after April.
    expect(await w.titles({ link: { mode: 'SELECTED', statuses: ['APPROVED'], professors: [w.p1.id], decidedOn: { after: '2026-04-01' } } })).toEqual([]);
    expect(await w.titles({ link: { mode: 'SELECTED', statuses: ['APPROVED'], professors: [w.p2.id], decidedOn: { after: '2026-04-01' } } })).toEqual(['Alpha joint']);
  });
});

describe('results', () => {
  it('rows carry admin-only data: status, curated and linked professors with qualifying marks', async () => {
    const w = await world();
    const res = await w.search({ link: { mode: 'SELECTED', statuses: ['APPROVED'], professors: [w.p2.id] }, root: and(cond('title', 'contains', 'beta')) });
    // P2's only link to b is PENDING, so b is outside a SELECTED [P2] APPROVED scope.
    expect(res.body.total).toBe(0);
    const all = await w.search({ link: { mode: 'ALL_PUBLICATIONS', statuses: ['APPROVED'] }, root: and(cond('title', 'contains', 'beta')) });
    const [row] = all.body.publications;
    expect(row).toMatchObject({ status: 'ACTIVE', isCurated: false });
    expect(row.professors.map((p: { name: string; status: string; qualifying: boolean }) => [p.name, p.status, p.qualifying])).toEqual([
      ['Prof One', 'APPROVED', true],
      ['Prof Two', 'PENDING', false],
    ]);
    expect(await w.titles({ link: ANY_APPROVED, root: and(cond('linkedProfessors', 'gte', 2)) })).toEqual(['Alpha joint']);
    expect(await w.titles({ link: { mode: 'ANY_PROFESSOR', statuses: ['APPROVED', 'PENDING'] }, root: and(cond('linkedProfessors', 'eq', 2)) })).toEqual(['Alpha joint', 'Beta conference']);
  });

  it('sorts and pages on the server; validates every body', async () => {
    const w = await world();
    const page1 = await w.search({ link: { mode: 'ALL_PUBLICATIONS', statuses: ['APPROVED'] }, sort: 'title', limit: 3 });
    expect(page1.body).toMatchObject({ total: 7, limit: 3, offset: 0, sort: 'title' });
    expect(page1.body.publications.map((p: { title: string }) => p.title)).toEqual(['Alpha joint', 'Beta conference', 'Delta preprint']);
    const page3 = await w.search({ link: { mode: 'ALL_PUBLICATIONS', statuses: ['APPROVED'] }, sort: 'title', limit: 3, offset: 6 });
    expect(page3.body.publications.map((p: { title: string }) => p.title)).toEqual(['Zeta rejected']);
    const byYear = await w.search({ link: { mode: 'ALL_PUBLICATIONS', statuses: ['APPROVED'] } });
    expect(byYear.body.publications.map((p: { year: number }) => p.year)).toEqual([2024, 2023, 2022, 2021, 2020, 2019, 2018]);
    expect((await w.search({ link: ANY_APPROVED, root: and(cond('year', 'eq', 1999)) })).body).toMatchObject({ total: 0, publications: [] });
    for (const body of [
      {},
      { link: { mode: 'EVERYTHING', statuses: ['APPROVED'] } },
      { link: { mode: 'NO_LINK', statuses: ['APPROVED'], professors: [w.p1.id] } },
      { link: { mode: 'SELECTED', statuses: ['APPROVED'] } },
      { link: { ...ANY_APPROVED, departmentId: 'x' } },
      { link: ANY_APPROVED, root: and(cond('keywords', 'contains', 'x')) },
      { link: ANY_APPROVED, limit: 101 },
    ]) {
      const res = await w.search(body);
      expect([res.status, res.body.error.code], JSON.stringify(body)).toEqual([400, 'VALIDATION_ERROR']);
    }
    expect((await w.search({ link: ANY_APPROVED, sort: 'scopusCitations' })).body.error.code).toBe('CITATION_DATA_UNAVAILABLE');
  });

  it('queries never change the department-wide analytics', async () => {
    const w = await world();
    const snapshot = async () => Promise.all(ANALYTICS.map(async (path) => (await request(w.server).get(path).set('Cookie', w.admin)).body));
    const before = await snapshot();
    await w.search({ link: { mode: 'ALL_PUBLICATIONS', statuses: ['APPROVED', 'PENDING', 'REJECTED'] }, root: and(cond('publicationStatus', 'in', ['SUPPRESSED'])) });
    await w.search({ link: { mode: 'NO_LINK', statuses: ['APPROVED'] } });
    await request(w.server).get(`${BASE}/presets/suppressed`).set('Cookie', w.admin);
    // Conditional analytics (Q4) are read-only too.
    expect((await request(w.server).post(`${BASE}/analytics`).set('Cookie', w.admin).send({ link: { mode: 'ALL_PUBLICATIONS', statuses: ['APPROVED'] } })).status).toBe(200);
    expect(await snapshot()).toEqual(before);
    // The analytics endpoints still take no query parameters.
    expect((await request(w.server).get(`${ANALYTICS[0]}?link=x`).set('Cookie', w.admin)).status).toBe(400);
  });
});
