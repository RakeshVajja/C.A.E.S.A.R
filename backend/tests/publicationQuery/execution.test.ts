import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '../../src/config/database';
import { queryFields, searchPublications } from '../../src/services/publicationQuery/execute';
import { resetDatabase } from '../helpers/database';
import { link, professor, publication, snapshot } from '../publications/helpers';

/*
 * Publication query execution against the isolated test database (Project_plan.md §24.3–§24.7;
 * decision #154): professor isolation, admin link scopes and ANY / ALL, every field, citation
 * availability, sorting and paging. Synthetic rows only.
 */

beforeEach(async () => {
  await resetDatabase();
});

afterAll(async () => {
  await resetDatabase();
  await prisma.$disconnect();
});

const cond = (field: string, operator: string, value?: unknown) => ({ field, operator, ...(value !== undefined && { value }) });
const and = (...children: unknown[]) => ({ combinator: 'AND', children });
const or = (...children: unknown[]) => ({ combinator: 'OR', children });
const admin = { role: 'ADMIN' as const };
const asProfessor = (professorId: string) => ({ role: 'PROFESSOR' as const, professorId });
const ids = (r: { publications: { id: string }[] }) => r.publications.map((p) => p.id).sort();
const all = { limit: 100 };

/**
 * P1 (active), P2 (active), P3 (inactive).
 *   a  journal 2024, P1 APPROVED, P2 APPROVED          — co-authored
 *   b  conference 2022, P1 APPROVED, P2 PENDING
 *   c  journal 2019, P1 PENDING
 *   d  preprint 2023, P1 REJECTED, P3 APPROVED (inactive professor)
 *   e  journal 2024 SUPPRESSED, P1 APPROVED
 *   f  book chapter, no year, no relationship
 *   g  journal 2021, P2 REJECTED only
 */
async function world() {
  const [p1, p2, p3] = [await professor('Prof One'), await professor('Prof Two'), await professor('Prof Three', false)];
  const a = await publication({ title: 'Alpha graph learning', year: 2024, type: 'JOURNAL', doi: '10.5555/alpha', records: [{ source: 'OPENALEX' }, { source: 'SCOPUS' }] });
  const b = await publication({ title: 'Beta networks', year: 2022, type: 'CONFERENCE', doi: '10.48550/arxiv.1', records: [{ source: 'DBLP' }] });
  const c = await publication({ title: 'Gamma databases', year: 2019, type: 'JOURNAL', doi: null, records: [{ source: 'ORCID' }] });
  const d = await publication({ title: 'Delta preprint', year: 2023, type: 'PREPRINT', doi: null, records: [{ source: 'OPENALEX' }] });
  const e = await publication({ title: 'Epsilon hidden', year: 2024, type: 'JOURNAL', status: 'SUPPRESSED', records: [{ source: 'OPENALEX' }] });
  const f = await publication({ title: 'Zeta chapter', year: null, type: 'BOOK_CHAPTER', doi: null, records: [{ source: 'MANUAL' }] });
  const g = await publication({ title: 'Eta rejected', year: 2021, type: 'JOURNAL', records: [{ source: 'SCOPUS' }] });
  await prisma.publication.update({ where: { id: a.id }, data: { venue: 'Journal of Graphs', authorNamesDisplay: 'A. One; B. Two', isCurated: true } });
  await prisma.publication.update({ where: { id: b.id }, data: { venue: 'Networks Conference' } });
  await prisma.publication.update({ where: { id: c.id }, data: { venue: '' } });
  await prisma.publicationSourceRecord.updateMany({ where: { publicationId: a.id }, data: { issns: ['1234-5679'] } });
  const decided = new Date('2026-03-10T12:00:00Z');
  await link(p1.id, a.id, 'APPROVED', { decidedAt: decided });
  await link(p2.id, a.id, 'APPROVED', { decidedAt: new Date('2026-05-01T00:00:00Z') });
  await link(p1.id, b.id, 'APPROVED', { decidedAt: decided });
  await link(p2.id, b.id, 'PENDING');
  await link(p1.id, c.id, 'PENDING');
  await link(p1.id, d.id, 'REJECTED', { decidedAt: decided });
  await link(p3.id, d.id, 'APPROVED', { decidedAt: decided });
  await link(p1.id, e.id, 'APPROVED', { decidedAt: decided });
  await link(p2.id, g.id, 'REJECTED', { decidedAt: decided });
  await prisma.professorPublication.updateMany({ where: { professorId: p1.id, publicationId: b.id }, data: { origin: 'MANUAL' } });
  return { p1, p2, p3, a, b, c, d, e, f, g };
}

async function observe(publicationId: string, values: { count: number; at: string }[]) {
  const record = await prisma.publicationSourceRecord.findFirstOrThrow({ where: { publicationId, source: 'SCOPUS' } });
  for (const v of values) await prisma.citationObservation.create({ data: { sourceRecordId: record.id, provider: 'SCOPUS', count: v.count, observedAt: new Date(v.at) } });
  return record;
}

describe('professor scope (D1, D10)', () => {
  it('returns only the professor’s APPROVED links to ACTIVE publications, without other professors’ data', async () => {
    const w = await world();
    const r = await searchPublications(asProfessor(w.p1.id), { ...all });
    expect(ids(r)).toEqual([w.a.id, w.b.id].sort()); // c PENDING, d REJECTED, e SUPPRESSED, f/g not theirs
    expect(r.total).toBe(2);
    for (const row of r.publications) {
      expect(row).not.toHaveProperty('professors');
      expect(row).not.toHaveProperty('status');
      expect(row).not.toHaveProperty('isCurated');
    }
    expect(ids(await searchPublications(asProfessor(w.p2.id), all))).toEqual([w.a.id]);
    expect(ids(await searchPublications(asProfessor(w.p3.id), all))).toEqual([w.d.id]);
  });

  it('conditions — OR, nesting, negations — can never widen the scope', async () => {
    const w = await world();
    const wide = or(cond('year', 'gte', 1000), cond('year', 'isEmpty'), and(or(cond('title', 'notContains', 'nothing at all'))));
    expect(ids(await searchPublications(asProfessor(w.p1.id), { root: wide, ...all }))).toEqual([w.a.id, w.b.id].sort());
    expect(ids(await searchPublications(asProfessor(w.p1.id), { root: and(cond('type', 'notIn', ['CONFERENCE'])) }))).toEqual([w.a.id]);
  });

  it('tampered queries are refused before anything is read', async () => {
    const w = await world();
    for (const body of [
      { link: { mode: 'ALL_PUBLICATIONS' } },
      { professorId: w.p2.id },
      { root: and(cond('publicationStatus', 'in', ['SUPPRESSED'])) },
      { root: and(cond('linkedProfessors', 'gte', 1)) },
      { root: and(cond('curated', 'is', true)) },
      { limit: 1000 },
    ]) {
      await expect(searchPublications(asProfessor(w.p1.id), body)).rejects.toMatchObject({ status: 400, code: 'VALIDATION_ERROR' });
    }
  });
});

describe('administrator link scope (§24.5)', () => {
  it('ANY_PROFESSOR with APPROVED is the department population (inactive professors included); statuses widen it', async () => {
    const w = await world();
    expect(ids(await searchPublications(admin, { link: { mode: 'ANY_PROFESSOR' }, ...all }))).toEqual([w.a.id, w.b.id, w.d.id, w.e.id].sort());
    expect(ids(await searchPublications(admin, { link: { mode: 'ANY_PROFESSOR', statuses: ['PENDING'] }, ...all }))).toEqual([w.b.id, w.c.id].sort());
    expect(ids(await searchPublications(admin, { link: { mode: 'ANY_PROFESSOR', statuses: ['REJECTED'] }, ...all }))).toEqual([w.d.id, w.g.id].sort());
    // With the D3 defaults it equals the §16 counted population (ACTIVE, not preprint, ≥ 1 APPROVED link).
    const counted = await prisma.publication.findMany({ where: { status: 'ACTIVE', typeFamily: { not: 'PREPRINT' }, professors: { some: { status: 'APPROVED' } } }, select: { id: true } });
    const defaults = and(cond('publicationStatus', 'in', ['ACTIVE']), cond('type', 'notIn', ['PREPRINT']));
    expect(ids(await searchPublications(admin, { link: { mode: 'ANY_PROFESSOR' }, root: defaults, ...all }))).toEqual(counted.map((p) => p.id).sort());
  });

  it('SELECTED with ANY and ALL; non-qualifying statuses do not count; each publication once', async () => {
    const w = await world();
    const sel = (professors: string[], match: 'ANY' | 'ALL', statuses?: string[]) => searchPublications(admin, { link: { mode: 'SELECTED', professors, match, ...(statuses && { statuses }) }, ...all });
    expect(ids(await sel([w.p1.id, w.p2.id], 'ANY'))).toEqual([w.a.id, w.b.id, w.e.id].sort());
    expect(ids(await sel([w.p1.id, w.p2.id], 'ALL'))).toEqual([w.a.id]); // b: P2 only PENDING
    expect(ids(await sel([w.p1.id, w.p2.id], 'ALL', ['APPROVED', 'PENDING']))).toEqual([w.a.id, w.b.id].sort());
    expect(ids(await sel([w.p1.id], 'ANY'))).toEqual(ids(await sel([w.p1.id], 'ALL')));
    expect(ids(await sel([w.p1.id, w.p2.id, w.p3.id], 'ALL'))).toEqual([]);
    expect(ids(await sel([w.p3.id], 'ANY'))).toEqual([w.d.id]); // inactive professor allowed
    // Duplicates in the selection change nothing, and a co-authored publication appears once.
    const dup = await sel([w.p1.id, w.p2.id, w.p1.id], 'ANY');
    expect(dup.publications.filter((p) => p.id === w.a.id)).toHaveLength(1);
    expect(dup.total).toBe(3);
  });

  it('origin and decision date are evaluated on the same relationship row', async () => {
    const w = await world();
    const r = await searchPublications(admin, { link: { mode: 'SELECTED', professors: [w.p1.id, w.p2.id], origins: ['MANUAL'] }, ...all });
    expect(ids(r)).toEqual([w.b.id]); // P1's MANUAL link on b; P2's PENDING row on b is not MANUAL-and-APPROVED
    // After 2026-04-01: only P2's link on a (decided 2026-05-01) qualifies.
    expect(ids(await searchPublications(admin, { link: { mode: 'ANY_PROFESSOR', decidedOn: { after: '2026-04-01' } }, ...all }))).toEqual([w.a.id]);
    expect(ids(await searchPublications(admin, { link: { mode: 'ANY_PROFESSOR', decidedOn: { before: '2026-03-10' } }, ...all }))).toEqual([]);
    expect(ids(await searchPublications(admin, { link: { mode: 'ANY_PROFESSOR', decidedOn: { after: '2026-03-09', before: '2026-03-11' } }, ...all }))).toEqual([w.a.id, w.b.id, w.d.id, w.e.id].sort());
  });

  it('NO_LINK means no relationship of any status; ALL_PUBLICATIONS returns every publication', async () => {
    const w = await world();
    expect(ids(await searchPublications(admin, { link: { mode: 'NO_LINK' }, ...all }))).toEqual([w.f.id]); // g has a REJECTED link
    const everything = await searchPublications(admin, { link: { mode: 'ALL_PUBLICATIONS' }, ...all });
    expect(everything.total).toBe(7);
  });

  it('marks qualifying and selected professors in admin rows; unknown professors are refused', async () => {
    const w = await world();
    const r = await searchPublications(admin, { link: { mode: 'SELECTED', professors: [w.p2.id] }, root: and(cond('title', 'contains', 'Beta')), ...all });
    expect(r.total).toBe(0); // P2's link on b is PENDING
    const b = await searchPublications(admin, { link: { mode: 'SELECTED', professors: [w.p2.id], statuses: ['PENDING'] }, ...all });
    expect(b.publications[0]).toMatchObject({ id: w.b.id, status: 'ACTIVE', isCurated: false });
    expect(b.publications[0].professors).toEqual([
      expect.objectContaining({ id: w.p2.id, status: 'PENDING', qualifying: true, selected: true }),
      expect.objectContaining({ id: w.p1.id, status: 'APPROVED', origin: 'MANUAL', qualifying: false, selected: false }),
    ]);
    await expect(searchPublications(admin, { link: { mode: 'SELECTED', professors: [w.p1.id, '00000000-0000-4000-8000-000000000099'] } })).rejects.toMatchObject({
      status: 400,
      code: 'PROFESSOR_NOT_FOUND',
      details: { professorIds: ['00000000-0000-4000-8000-000000000099'] },
    });
  });

  it('linkedProfessors counts professors with a qualifying link', async () => {
    const w = await world();
    const run = (operator: string, value: number, statuses?: string[]) =>
      searchPublications(admin, { link: { mode: 'ALL_PUBLICATIONS', ...(statuses && { statuses }) }, root: and(cond('linkedProfessors', operator, value)), ...all });
    expect(ids(await run('gte', 2))).toEqual([w.a.id]);
    expect(ids(await run('gte', 2, ['APPROVED', 'PENDING']))).toEqual([w.a.id, w.b.id].sort());
    expect(ids(await run('eq', 0))).toEqual([w.c.id, w.f.id, w.g.id].sort());
    expect((await run('gte', 0)).total).toBe(7);
  });
});

describe('fields (§24.3)', () => {
  it('compiles every field and operator correctly, with AND / OR groups', async () => {
    const w = await world();
    const q = async (...children: unknown[]) => ids(await searchPublications(admin, { link: { mode: 'ALL_PUBLICATIONS' }, root: and(...children), ...all }));
    expect(await q(cond('year', 'eq', 2024))).toEqual([w.a.id, w.e.id].sort());
    expect(await q(cond('year', 'neq', 2024))).toEqual([w.b.id, w.c.id, w.d.id, w.g.id].sort()); // unknown year is not "≠"
    expect(await q(cond('year', 'between', [2021, 2023]))).toEqual([w.b.id, w.d.id, w.g.id].sort());
    expect(await q(cond('year', 'lt', 2020))).toEqual([w.c.id]);
    expect(await q(cond('year', 'isEmpty'))).toEqual([w.f.id]);
    expect(await q(cond('type', 'in', ['JOURNAL']), cond('year', 'gt', 2020))).toEqual([w.a.id, w.e.id, w.g.id].sort());
    expect(await q(cond('type', 'notIn', ['JOURNAL', 'PREPRINT']))).toEqual([w.b.id, w.f.id].sort());
    expect(await q(cond('title', 'contains', 'GRAPH'))).toEqual([w.a.id]);
    expect(await q(cond('venue', 'contains', 'graphs'))).toEqual([w.a.id]);
    expect(await q(cond('venue', 'equals', 'networks conference'))).toEqual([w.b.id]);
    expect(await q(cond('venue', 'isNotEmpty'))).toEqual([w.a.id, w.b.id].sort());
    expect((await q(cond('venue', 'isEmpty'))).length).toBe(5); // null or '' (c)
    expect(await q(cond('authors', 'contains', 'b. two'))).toEqual([w.a.id]);
    expect(await q(cond('doi', 'equals', 'https://doi.org/10.5555/ALPHA'))).toEqual([w.a.id]);
    expect(await q(cond('doi', 'startsWith', '10.48550/'))).toEqual([w.b.id]);
    expect(await q(cond('doi', 'isAbsent'))).toEqual([w.c.id, w.d.id, w.f.id].sort());
    expect(await q(cond('source', 'anyOf', ['SCOPUS']))).toEqual([w.a.id, w.g.id].sort());
    expect((await q(cond('source', 'noneOf', ['OPENALEX', 'SCOPUS']))).sort()).toEqual([w.b.id, w.c.id, w.f.id].sort());
    expect(await q(cond('issn', 'equals', '12345679'))).toEqual([w.a.id]);
    expect(await q(cond('publicationStatus', 'in', ['SUPPRESSED']))).toEqual([w.e.id]);
    expect(await q(cond('curated', 'is', true))).toEqual([w.a.id]);
    expect(await q(or(cond('type', 'in', ['PREPRINT']), and(cond('year', 'eq', 2019), cond('doi', 'isAbsent'))))).toEqual([w.c.id, w.d.id].sort());
    // Date added: all rows were created now; a window before today matches nothing.
    expect(await q(cond('addedOn', 'before', '2000-01-01'))).toEqual([]);
    expect((await q(cond('addedOn', 'after', '2000-01-01'))).length).toBe(7);
  });
});

describe('Scopus citation availability (§24.4, D6, D9)', () => {
  it('without any Scopus data every citation filter, the citation sort and the preset are refused — never an empty result', async () => {
    const w = await world();
    for (const c of [cond('scopusCitations', 'gt', 0), cond('scopusCitations', 'lte', 5), cond('scopusCitations', 'between', [0, 3]), cond('scopusCitations', 'hasCount'), cond('scopusCitations', 'noCount')]) {
      await expect(searchPublications(asProfessor(w.p1.id), { root: and(c) })).rejects.toMatchObject({ status: 409, code: 'CITATION_DATA_UNAVAILABLE' });
      await expect(searchPublications(admin, { link: { mode: 'ALL_PUBLICATIONS' }, root: or(cond('year', 'gte', 1000), c) })).rejects.toMatchObject({ status: 409 });
    }
    await expect(searchPublications(asProfessor(w.p1.id), { sort: 'scopusCitations' })).rejects.toMatchObject({ status: 409, code: 'CITATION_DATA_UNAVAILABLE' });
    // Other queries work and say the data is unavailable; rows carry no citation value at all.
    const r = await searchPublications(asProfessor(w.p1.id), all);
    expect(r.citations).toEqual({ available: false });
    for (const row of r.publications) expect(row).not.toHaveProperty('scopusCitation');
    const fields = await queryFields(asProfessor(w.p1.id));
    expect(fields.scopus).toEqual({ available: false });
    expect(fields.sorts.find((s) => s.key === 'scopusCitations')).toEqual({ key: 'scopusCitations', available: false });
  });

  it('with data: latest observation per record, highest across records; no count ≠ zero; coverage and sort', async () => {
    const w = await world();
    // a: two observations (latest 7), plus a second Scopus record whose latest is 3 → 7.
    await observe(w.a.id, [
      { count: 9, at: '2026-01-01T00:00:00Z' },
      { count: 7, at: '2026-06-01T00:00:00Z' },
    ]);
    const second = await prisma.publicationSourceRecord.create({
      data: { publicationId: w.a.id, source: 'SCOPUS', externalId: 'SCOPUS-second', title: 'Alpha graph learning', normalizedTitle: 'alpha graph learning', typeFamily: 'JOURNAL', matchMethod: 'DOI' },
    });
    await prisma.citationObservation.create({ data: { sourceRecordId: second.id, provider: 'SCOPUS', count: 3, observedAt: new Date('2026-07-01T00:00:00Z') } });
    await observe(w.g.id, [{ count: 0, at: '2026-06-01T00:00:00Z' }]);

    const q = async (c: unknown, extra: object = {}) => searchPublications(admin, { link: { mode: 'ALL_PUBLICATIONS' }, root: and(c), ...all, ...extra });
    expect(ids(await q(cond('scopusCitations', 'gte', 7)))).toEqual([w.a.id]);
    expect(ids(await q(cond('scopusCitations', 'gt', 7)))).toEqual([]); // not the older 9, not 9 + 3
    expect(ids(await q(cond('scopusCitations', 'lt', 5)))).toEqual([w.g.id]); // zero counts; publications without a count never match
    expect(ids(await q(cond('scopusCitations', 'between', [0, 0])))).toEqual([w.g.id]);
    expect(ids(await q(cond('scopusCitations', 'hasCount')))).toEqual([w.a.id, w.g.id].sort());
    expect((await q(cond('scopusCitations', 'noCount'))).total).toBe(5);

    const everything = await searchPublications(admin, { link: { mode: 'ALL_PUBLICATIONS' }, sort: 'scopusCitations', ...all });
    expect(everything.publications.slice(0, 2).map((p) => p.id)).toEqual([w.a.id, w.g.id]); // 7, then 0, then no counts
    expect(everything.citations).toEqual({ available: true, latestObservation: new Date('2026-06-01T00:00:00Z'), coverage: { withCount: 2, withoutCount: 5, notInScopus: 5, noCountYet: 0 } });
    expect(everything.publications.find((p) => p.id === w.a.id)!.scopusCitation).toMatchObject({ count: 7 });
    expect(everything.publications.find((p) => p.id === w.g.id)!.scopusCitation).toMatchObject({ count: 0 });
    expect(everything.publications.find((p) => p.id === w.b.id)!.scopusCitation).toBeNull();

    // Professors may filter and sort by their own counts (D9), still within their scope.
    const mine = await searchPublications(asProfessor(w.p1.id), { root: and(cond('scopusCitations', 'hasCount')), sort: 'scopusCitations' });
    expect(ids(mine)).toEqual([w.a.id]);
    expect(mine.citations).toMatchObject({ available: true, coverage: { withCount: 1, withoutCount: 0 } });
    expect((await queryFields(asProfessor(w.p1.id))).scopus).toEqual({ available: true });
  });
});

describe('sorting and paging (§24.7, D11)', () => {
  it('sorts by year (unknown last), title and date added with a stable id tie-break, and pages with a total', async () => {
    const w = await world();
    const base = { link: { mode: 'ALL_PUBLICATIONS' } };
    const byYear = await searchPublications(admin, { ...base, ...all });
    expect(byYear.publications.map((p) => p.year)).toEqual([2024, 2024, 2023, 2022, 2021, 2019, null]);
    const tied = byYear.publications.slice(0, 2).map((p) => p.id);
    expect(tied).toEqual([...tied].sort());
    expect((await searchPublications(admin, { ...base, sort: 'title', ...all })).publications[0].title).toBe('Alpha graph learning');

    const pages = [];
    for (let offset = 0; offset < 7; offset += 3) pages.push(await searchPublications(admin, { ...base, limit: 3, offset }));
    expect(pages.map((p) => p.publications.length)).toEqual([3, 3, 1]);
    expect(pages.every((p) => p.total === 7 && p.limit === 3)).toBe(true);
    expect(pages.flatMap((p) => p.publications.map((x) => x.id))).toEqual(byYear.publications.map((p) => p.id));
    expect((await searchPublications(admin, { ...base, offset: 50 })).publications).toEqual([]);
    expect((await searchPublications(admin, base)).limit).toBe(25);
    expect(w.a.id).toBeDefined();
  });

  it('is read-only: running queries changes no row', async () => {
    const w = await world();
    const before = await snapshot();
    await searchPublications(admin, { link: { mode: 'SELECTED', professors: [w.p1.id, w.p2.id], match: 'ALL' }, root: and(cond('linkedProfessors', 'gte', 1)), sort: 'title' });
    await searchPublications(asProfessor(w.p1.id), { root: or(cond('year', 'isEmpty'), cond('venue', 'contains', 'x')) });
    expect(await snapshot()).toEqual(before);
  });
});

describe('Q1 review: partial Scopus coverage, UTC day semantics, statement timeout', () => {
  it('partial observations never imply complete coverage: a Scopus record without an observation has no count', async () => {
    const w = await world();
    // a is observed; g has a Scopus source record but no observation yet.
    await observe(w.a.id, [{ count: 4, at: '2026-06-01T00:00:00Z' }]);
    const r = await searchPublications(admin, { link: { mode: 'ALL_PUBLICATIONS' }, root: and(cond('source', 'anyOf', ['SCOPUS'])), ...all });
    expect(ids(r)).toEqual([w.a.id, w.g.id].sort());
    expect(r.citations).toEqual({ available: true, latestObservation: new Date('2026-06-01T00:00:00Z'), coverage: { withCount: 1, withoutCount: 1, notInScopus: 0, noCountYet: 1 } });
    expect(r.publications.find((p) => p.id === w.g.id)!.scopusCitation).toBeNull();
    const q = async (c: unknown) => ids(await searchPublications(admin, { link: { mode: 'ALL_PUBLICATIONS' }, root: and(cond('source', 'anyOf', ['SCOPUS']), c), ...all }));
    expect(await q(cond('scopusCitations', 'lte', 100))).toEqual([w.a.id]); // g is never counted as 0
    expect(await q(cond('scopusCitations', 'noCount'))).toEqual([w.g.id]);
  });

  it('addedOn uses UTC calendar days at the boundaries', async () => {
    await world();
    const late = await publication({ title: 'Late on the tenth' });
    const early = await publication({ title: 'Start of the eleventh' });
    await prisma.publication.update({ where: { id: late.id }, data: { createdAt: new Date('2026-03-10T23:30:00Z') } }); // already 11 March in Asia/Kolkata
    await prisma.publication.update({ where: { id: early.id }, data: { createdAt: new Date('2026-03-11T00:00:00Z') } });
    const q = async (c: unknown) =>
      ids(await searchPublications(admin, { link: { mode: 'ALL_PUBLICATIONS' }, root: and(cond('title', 'contains', 'the'), c), ...all }));
    expect(await q(cond('addedOn', 'before', '2026-03-11'))).toEqual([late.id]);
    expect(await q(cond('addedOn', 'after', '2026-03-10'))).toEqual([early.id]);
    expect(await q(cond('addedOn', 'between', ['2026-03-10', '2026-03-10']))).toEqual([late.id]);
    expect(await q(cond('addedOn', 'between', ['2026-03-11', '2026-03-11']))).toEqual([early.id]);
  });

  it('decidedOn uses the same UTC days in the filter and in the qualifying marks of admin rows', async () => {
    const w = await world();
    // P1's link on a decided late on 10 March UTC; P2's on 11 March 00:00 UTC.
    await prisma.professorPublication.updateMany({ where: { professorId: w.p1.id, publicationId: w.a.id }, data: { decidedAt: new Date('2026-03-10T23:30:00Z') } });
    await prisma.professorPublication.updateMany({ where: { professorId: w.p2.id, publicationId: w.a.id }, data: { decidedAt: new Date('2026-03-11T00:00:00Z') } });
    const run = (decidedOn: object) => searchPublications(admin, { link: { mode: 'ALL_PUBLICATIONS', decidedOn }, root: and(cond('title', 'contains', 'alpha')), ...all });
    const marks = (r: Awaited<ReturnType<typeof run>>) => Object.fromEntries(r.publications[0].professors!.map((p) => [p.name, p.qualifying]));
    expect(marks(await run({ before: '2026-03-11' }))).toEqual({ 'Prof One': true, 'Prof Two': false });
    expect(marks(await run({ after: '2026-03-10' }))).toEqual({ 'Prof One': false, 'Prof Two': true });
    // The database filter agrees with the marks.
    const filtered = async (decidedOn: object, professors: string[]) =>
      ids(await searchPublications(admin, { link: { mode: 'SELECTED', professors, decidedOn }, root: and(cond('title', 'contains', 'alpha')), ...all }));
    expect(await filtered({ before: '2026-03-11' }, [w.p1.id])).toEqual([w.a.id]);
    expect(await filtered({ before: '2026-03-11' }, [w.p2.id])).toEqual([]);
    expect(await filtered({ after: '2026-03-10' }, [w.p2.id])).toEqual([w.a.id]);
    expect(await filtered({ after: '2026-03-10' }, [w.p1.id])).toEqual([]);
  });

  it('a PostgreSQL statement timeout becomes 503 QUERY_TIMEOUT (deterministic: a held table lock and a short timeout)', async () => {
    await world();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let locked!: () => void;
    const isLocked = new Promise<void>((r) => (locked = r));
    const holder = prisma.$transaction(
      async (tx) => {
        await tx.$executeRaw`LOCK TABLE publications IN ACCESS EXCLUSIVE MODE`;
        locked();
        await gate;
      },
      { timeout: 30_000 },
    );
    await isLocked;
    try {
      const started = Date.now();
      await expect(searchPublications(admin, { link: { mode: 'ALL_PUBLICATIONS' } }, prisma, { statementTimeoutMs: 200 })).rejects.toMatchObject({
        status: 503,
        code: 'QUERY_TIMEOUT',
        message: 'The query took too long; narrow it down and try again',
      });
      expect(Date.now() - started).toBeLessThan(5_000); // the short test timeout applied, not the 5 s default
    } finally {
      release();
      await holder;
    }
    // Without the lock the same query runs normally.
    expect((await searchPublications(admin, { link: { mode: 'ALL_PUBLICATIONS' } }, prisma, { statementTimeoutMs: 200 })).total).toBe(7);
  });

  it('other database failures are not reported as a timeout', async () => {
    const failing = { $transaction: async () => Promise.reject(new Error('connection refused')) } as unknown as typeof prisma;
    await expect(searchPublications(admin, { link: { mode: 'ALL_PUBLICATIONS' } }, failing)).rejects.toThrow('connection refused');
  });

  it('rows distinguish counted (including zero), "no Scopus count yet" and "not in Scopus"; coverage splits accordingly (#157)', async () => {
    const w = await world();
    // a: Scopus record with an observation of 0 (counted, zero); g: Scopus record, no observation; b, c, d, e, f: no Scopus record.
    await observe(w.a.id, [{ count: 0, at: '2026-06-01T00:00:00Z' }]);
    const r = await searchPublications(admin, { link: { mode: 'ALL_PUBLICATIONS' }, ...all });
    const row = (id: string) => r.publications.find((p) => p.id === id)!;
    expect(row(w.a.id)).toMatchObject({ scopusCitationState: 'COUNTED', scopusCitation: { count: 0 } });
    expect(row(w.g.id)).toMatchObject({ scopusCitationState: 'NO_COUNT_YET', scopusCitation: null });
    expect(row(w.b.id)).toMatchObject({ scopusCitationState: 'NOT_IN_SCOPUS', scopusCitation: null });
    const coverage = (r.citations as { coverage: { withCount: number; withoutCount: number; notInScopus: number; noCountYet: number } }).coverage;
    expect(coverage).toEqual({ withCount: 1, withoutCount: 6, notInScopus: 5, noCountYet: 1 });
    expect(coverage.withCount + coverage.withoutCount).toBe(r.total);
    expect(coverage.notInScopus + coverage.noCountYet).toBe(coverage.withoutCount);
    // The breakdown follows the matching set.
    const journals = await searchPublications(admin, { link: { mode: 'ALL_PUBLICATIONS' }, root: and(cond('type', 'in', ['JOURNAL'])), ...all });
    expect((journals.citations as { coverage: object }).coverage).toEqual({ withCount: 1, withoutCount: 3, notInScopus: 2, noCountYet: 1 }); // a; g; c, e
    // While data is unavailable, rows carry neither a count nor a state.
    await prisma.citationObservation.deleteMany();
    const none = await searchPublications(admin, { link: { mode: 'ALL_PUBLICATIONS' }, ...all });
    for (const p of none.publications) {
      expect(p).not.toHaveProperty('scopusCitation');
      expect(p).not.toHaveProperty('scopusCitationState');
    }
    // Professors see the same states for their own rows.
    await observe(w.a.id, [{ count: 2, at: '2026-06-01T00:00:00Z' }]);
    const mine = await searchPublications(asProfessor(w.p1.id), all);
    expect(Object.fromEntries(mine.publications.map((p) => [p.id, p.scopusCitationState]))).toEqual({ [w.a.id]: 'COUNTED', [w.b.id]: 'NOT_IN_SCOPUS' });
  });

  it('latestObservation is the date of the observation supplying the selected (highest) count, not the newest observation of any record', async () => {
    const w = await world();
    // Record 1: latest 7 on 1 June. Record 2: newer observation (1 July) with a lower count, 3. The count is 7, dated 1 June.
    await observe(w.a.id, [{ count: 7, at: '2026-06-01T00:00:00Z' }]);
    const second = await prisma.publicationSourceRecord.create({
      data: { publicationId: w.a.id, source: 'SCOPUS', externalId: 'SCOPUS-second', title: 'Alpha graph learning', normalizedTitle: 'alpha graph learning', typeFamily: 'JOURNAL', matchMethod: 'DOI' },
    });
    await prisma.citationObservation.create({ data: { sourceRecordId: second.id, provider: 'SCOPUS', count: 3, observedAt: new Date('2026-07-01T00:00:00Z') } });
    const r = await searchPublications(admin, { link: { mode: 'ALL_PUBLICATIONS' }, root: and(cond('title', 'contains', 'alpha')), ...all });
    expect(r.publications[0].scopusCitation).toMatchObject({ count: 7, observedAt: new Date('2026-06-01T00:00:00Z') });
    expect(r.citations).toMatchObject({ latestObservation: new Date('2026-06-01T00:00:00Z') });
    // When the newer record overtakes, the count and its date move together.
    await prisma.citationObservation.create({ data: { sourceRecordId: second.id, provider: 'SCOPUS', count: 12, observedAt: new Date('2026-08-01T00:00:00Z') } });
    const later = await searchPublications(admin, { link: { mode: 'ALL_PUBLICATIONS' }, root: and(cond('title', 'contains', 'alpha')), ...all });
    expect(later.publications[0].scopusCitation).toMatchObject({ count: 12, observedAt: new Date('2026-08-01T00:00:00Z') });
    expect(later.citations).toMatchObject({ latestObservation: new Date('2026-08-01T00:00:00Z') });
  });
});

