import { describe, expect, it } from 'vitest';
import { HttpError } from '../../src/utils/httpError';
import { LIMITS, parseQuery } from '../../src/services/publicationQuery/ast';
import { describeFields } from '../../src/services/publicationQuery/fields';
import { buildPreset, currentYear, defaultAdminQuery, listPresets } from '../../src/services/publicationQuery/presets';

/* Publication query validation, field permissions, limits and presets (Project_plan.md §24.3–§24.5; decision #154). No database. */

const P = 'PROFESSOR' as const;
const A = 'ADMIN' as const;
const LINK = { mode: 'ANY_PROFESSOR' };
const cond = (field: string, operator: string, value?: unknown) => ({ field, operator, ...(value !== undefined && { value }) });
const and = (...children: unknown[]) => ({ combinator: 'AND', children });
const or = (...children: unknown[]) => ({ combinator: 'OR', children });

function refused(fn: () => unknown, code = 'VALIDATION_ERROR'): { path: string; message: string }[] {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(HttpError);
    expect((error as HttpError).code).toBe(code);
    return ((error as HttpError).details as { path: string; message: string }[]) ?? [];
  }
  throw new Error('expected the query to be refused');
}

describe('shape, defaults and paging', () => {
  it('applies the documented defaults and accepts an empty professor query', () => {
    expect(parseQuery(P, {})).toEqual({ sort: 'year', limit: 25, offset: 0 });
    expect(parseQuery(A, { link: LINK })).toEqual({ link: { mode: 'ANY_PROFESSOR', statuses: ['APPROVED'] }, sort: 'year', limit: 25, offset: 0 });
    expect(parseQuery(P, { limit: 100, offset: 50, sort: 'scopusCitations' })).toMatchObject({ limit: 100, offset: 50, sort: 'scopusCitations' });
  });

  it('refuses out-of-range paging, unknown sorts and unknown keys anywhere', () => {
    for (const body of [{ limit: 0 }, { limit: 101 }, { offset: -1 }, { sort: 'citations' }, { sort: 'year', extra: 1 }, { root: { ...and(cond('year', 'eq', 2020)), extra: true } }, { root: and({ ...cond('year', 'eq', 2020), sql: 'x' }) }]) {
      refused(() => parseQuery(P, body));
    }
  });
});

describe('field permissions (§24.3–§24.4, D1, D10)', () => {
  it('a professor query may not carry a link scope, admin-only fields or another identity', () => {
    for (const body of [
      { link: LINK },
      { root: and(cond('publicationStatus', 'in', ['ACTIVE'])) },
      { root: and(cond('curated', 'is', true)) },
      { root: and(cond('linkedProfessors', 'gte', 2)) },
      { professorId: '00000000-0000-4000-8000-000000000001' },
      { root: and(cond('relationshipStatus', 'in', ['PENDING'])) },
    ]) {
      refused(() => parseQuery(P, body));
    }
  });

  it('an administrator query requires an explicit link scope and accepts the admin fields', () => {
    refused(() => parseQuery(A, {}));
    expect(parseQuery(A, { link: LINK, root: and(cond('publicationStatus', 'in', ['SUPPRESSED']), cond('curated', 'is', false), cond('linkedProfessors', 'eq', 0)) }).root?.children).toHaveLength(3);
  });

  it('refuses unknown fields and operators not allowed for a field', () => {
    expect(refused(() => parseQuery(P, { root: and(cond('keywords', 'contains', 'x')) }))[0].path).toBe('root.children.0.field');
    expect(refused(() => parseQuery(P, { root: and(cond('year', 'contains', '2020')) }))[0].path).toBe('root.children.0.operator');
    refused(() => parseQuery(P, { root: and(cond('authors', 'equals', 'x')) }));
    refused(() => parseQuery(P, { root: and(cond('venue', 'constructor', 'x')) }));
  });
});

describe('values', () => {
  it('validates and normalizes typed values per operator', () => {
    const q = parseQuery(P, {
      root: and(
        cond('year', 'between', [2020, 2025]),
        cond('type', 'in', ['JOURNAL', 'CONFERENCE']),
        cond('title', 'contains', '  Graph  '),
        cond('doi', 'equals', 'https://doi.org/10.5555/ABC'),
        cond('doi', 'startsWith', '10.48550/'),
        cond('issn', 'equals', '12345679'),
        cond('addedOn', 'between', ['2026-01-01', '2026-02-01']),
        cond('scopusCitations', 'gte', 0),
        cond('year', 'isEmpty'),
      ),
    });
    expect(q.root!.children).toEqual([
      cond('year', 'between', [2020, 2025]),
      cond('type', 'in', ['JOURNAL', 'CONFERENCE']),
      cond('title', 'contains', 'Graph'),
      cond('doi', 'equals', '10.5555/abc'),
      cond('doi', 'startsWith', '10.48550/'),
      cond('issn', 'equals', '1234-5679'),
      cond('addedOn', 'between', ['2026-01-01', '2026-02-01']),
      cond('scopusCitations', 'gte', 0),
      cond('year', 'isEmpty'),
    ]);
  });

  it('refuses malformed values', () => {
    for (const c of [
      cond('year', 'eq', 999),
      cond('year', 'eq', '2020'),
      cond('year', 'between', [2025, 2020]),
      cond('year', 'isEmpty', 2020),
      cond('type', 'in', []),
      cond('type', 'in', ['JOURNAL', 'JOURNAL']),
      cond('type', 'in', ['THESIS']),
      cond('title', 'contains', '   '),
      cond('title', 'contains', '!!!'),
      cond('title', 'contains', 'x'.repeat(301)),
      cond('doi', 'equals', 'not a doi'),
      cond('issn', 'equals', '1234'),
      cond('addedOn', 'before', '2026-13-01'),
      cond('addedOn', 'between', ['2026-02-01', '2026-01-01']),
      cond('scopusCitations', 'gt', -1),
      cond('scopusCitations', 'gt', 1.5),
      cond('source', 'anyOf', ['GOOGLE_SCHOLAR']),
    ]) {
      refused(() => parseQuery(P, { root: and(c) }));
    }
    refused(() => parseQuery(A, { link: LINK, root: and(cond('curated', 'is', 'yes')) }));
  });
});

describe('tree limits (§24.3)', () => {
  it('allows 25 conditions and 3 levels; refuses more, empty groups and over-wide groups', () => {
    const many = (n: number) => Array.from({ length: n }, (_, i) => cond('year', 'eq', 2000 + i));
    expect(parseQuery(P, { root: and(and(...many(20)), or(...many(5))) }).root!.children).toHaveLength(2);
    expect(refused(() => parseQuery(P, { root: and(and(...many(20)), or(...many(6))) })).some((d) => /at most 25 conditions/.test(d.message))).toBe(true);
    refused(() => parseQuery(P, { root: and(...many(21)) }));
    expect(parseQuery(P, { root: and(or(and(cond('year', 'eq', 2020)))) }).root).toBeDefined();
    expect(refused(() => parseQuery(P, { root: and(or(and(or(cond('year', 'eq', 2020))))) })).some((d) => /nested at most 3/.test(d.message))).toBe(true);
    refused(() => parseQuery(P, { root: and() }));
    refused(() => parseQuery(P, { root: { combinator: 'XOR', children: [cond('year', 'eq', 2020)] } }));
  });
});

describe('administrator link scope (§24.5, D12)', () => {
  const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

  it('removes duplicate professors, defaults ANY, and keeps statuses / origins / decision dates', () => {
    const q = parseQuery(A, { link: { mode: 'SELECTED', professors: [id(1), id(2), id(1), id(2).toUpperCase()], statuses: ['APPROVED', 'PENDING'], origins: ['MANUAL'], decidedOn: { after: '2026-01-01' } } });
    expect(q.link).toEqual({ mode: 'SELECTED', professors: [id(1), id(2)], match: 'ANY', statuses: ['APPROVED', 'PENDING'], origins: ['MANUAL'], decidedOn: { after: '2026-01-01' } });
    expect(parseQuery(A, { link: { mode: 'SELECTED', professors: [id(1)], match: 'ALL' } }).link.match).toBe('ALL');
  });

  it('refuses inconsistent or oversized link scopes', () => {
    for (const link of [
      { mode: 'SELECTED' },
      { mode: 'SELECTED', professors: [] },
      { mode: 'SELECTED', professors: ['not-a-uuid'] },
      { mode: 'SELECTED', professors: Array.from({ length: 51 }, (_, i) => id(i + 1)) },
      { mode: 'ANY_PROFESSOR', professors: [id(1)] },
      { mode: 'NO_LINK', match: 'ALL' },
      { mode: 'ANY_PROFESSOR', statuses: [] },
      { mode: 'ANY_PROFESSOR', statuses: ['APPROVED', 'APPROVED'] },
      { mode: 'ANY_PROFESSOR', decidedOn: {} },
      { mode: 'ANY_PROFESSOR', decidedOn: { after: '2026-02-01', before: '2026-01-01' } },
      { mode: 'EVERYONE' },
      { mode: 'ANY_PROFESSOR', professorId: id(1) },
    ]) {
      refused(() => parseQuery(A, { link }));
    }
    // 50 distinct professors are allowed, duplicates beyond that do not count.
    expect(parseQuery(A, { link: { mode: 'SELECTED', professors: [...Array.from({ length: 50 }, (_, i) => id(i + 1)), id(1)] } }).link.professors).toHaveLength(50);
  });
});

describe('fields and presets descriptions', () => {
  it('describes only the role’s fields and marks citation fields unavailable without Scopus data', () => {
    const professorFields = describeFields(P, false).map((f) => f.id);
    expect(professorFields).not.toContain('publicationStatus');
    expect(professorFields).not.toContain('linkedProfessors');
    expect(professorFields).not.toContain('curated');
    expect(describeFields(A, false).map((f) => f.id)).toEqual(expect.arrayContaining(['publicationStatus', 'curated', 'linkedProfessors']));
    expect(describeFields(P, false).find((f) => f.id === 'scopusCitations')).toMatchObject({ available: false, unavailableReason: 'Scopus citation data is unavailable' });
    expect(describeFields(P, true).find((f) => f.id === 'scopusCitations')).toMatchObject({ available: true });
  });

  it('lists the shared presets for both roles and the admin presets only for administrators; Cited needs Scopus data', () => {
    const professor = listPresets(P, false).map((p) => p.id);
    const admin = listPresets(A, false).map((p) => p.id);
    expect(professor).not.toEqual(expect.arrayContaining(['pendingVerification']));
    expect(admin).toEqual(expect.arrayContaining([...professor, 'pendingVerification', 'rejectedLinks', 'jointPublications', 'coAuthored', 'withoutProfessorLink', 'suppressed', 'curated']));
    expect(listPresets(P, false).find((p) => p.id === 'citedInScopus')).toMatchObject({ available: false });
    expect(listPresets(P, true).find((p) => p.id === 'citedInScopus')).toMatchObject({ available: true });
  });

  it('Recent is the current year (server time zone) and the four before (D7)', () => {
    // 2026-12-31 20:00 UTC is already 2027 in Asia/Kolkata.
    const now = new Date('2026-12-31T20:00:00Z');
    expect(currentYear(now, 'Asia/Kolkata')).toBe(2027);
    expect(buildPreset(P, 'recent', undefined, now, 'Asia/Kolkata').root.children).toEqual([cond('year', 'between', [2023, 2027])]);
    expect(buildPreset(P, 'recent', undefined, now, 'UTC').root.children).toEqual([cond('year', 'between', [2022, 2026])]);
  });

  it('admin presets start from the visible D3 defaults and drop only the ones they contradict; every preset validates', () => {
    const now = new Date('2026-06-01T00:00:00Z');
    expect(defaultAdminQuery()).toEqual({
      link: { mode: 'ANY_PROFESSOR', statuses: ['APPROVED'] },
      root: and(cond('publicationStatus', 'in', ['ACTIVE']), cond('type', 'notIn', ['PREPRINT'])),
    });
    const active = cond('publicationStatus', 'in', ['ACTIVE']);
    const nonPreprint = cond('type', 'notIn', ['PREPRINT']);
    expect(buildPreset(A, 'journalArticles', undefined, now, 'UTC')).toEqual({ link: { mode: 'ANY_PROFESSOR', statuses: ['APPROVED'] }, root: and(active, nonPreprint, cond('type', 'in', ['JOURNAL'])) });
    expect(buildPreset(A, 'preprints', undefined, now, 'UTC').root).toEqual(and(active, cond('type', 'in', ['PREPRINT'])));
    expect(buildPreset(A, 'suppressed', undefined, now, 'UTC').root).toEqual(and(nonPreprint, cond('publicationStatus', 'in', ['SUPPRESSED'])));
    expect(buildPreset(A, 'withoutProfessorLink', undefined, now, 'UTC').link.mode).toBe('NO_LINK');
    expect(buildPreset(A, 'pendingVerification', undefined, now, 'UTC').link).toEqual({ mode: 'ANY_PROFESSOR', statuses: ['PENDING'] });
    expect(buildPreset(A, 'citedInScopus', undefined, now, 'UTC').root.children).toContainEqual(cond('scopusCitations', 'gte', 10));
    expect(buildPreset(P, 'preprints', undefined, now, 'UTC').root).toEqual(and(cond('type', 'in', ['PREPRINT'])));

    const params: Record<string, unknown> = { publishedInYear: 2024, venueContains: 'Journal', jointPublications: ['00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000002'] };
    for (const { id } of listPresets(A, true)) expect(() => parseQuery(A, buildPreset(A, id, params[id], now, 'UTC')), id).not.toThrow();
    for (const { id } of listPresets(P, true)) expect(() => parseQuery(P, buildPreset(P, id, params[id], now, 'UTC')), id).not.toThrow();

    expect(() => buildPreset(P, 'pendingVerification', undefined, now, 'UTC')).toThrow(expect.objectContaining({ code: 'PRESET_NOT_FOUND' }));
    expect(() => buildPreset(P, 'publishedInYear', undefined, now, 'UTC')).toThrow(expect.objectContaining({ code: 'VALIDATION_ERROR' }));
    // A malformed parameter is caught by the ordinary validation.
    expect(() => parseQuery(P, buildPreset(P, 'publishedInYear', 'nineteen', now, 'UTC'))).toThrow();
  });

  it('exposes the documented limits', () => {
    expect(LIMITS).toMatchObject({ conditions: 25, depth: 3, groupChildren: 20, professors: 50, pageDefault: 25, pageMax: 100 });
  });
});
