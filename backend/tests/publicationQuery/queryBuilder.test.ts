import { describe, expect, it } from 'vitest';
import {
  addChild,
  analyticsConsistency,
  ApiGroup,
  ApiLinkScope,
  builderKey,
  builderOf,
  BuilderCondition,
  BuilderGroup,
  citationDisplay,
  countConditions,
  decodeQuery,
  emptyRoot,
  encodeQuery,
  FieldMeta,
  fitsInUrl,
  fromApiTree,
  groupDepths,
  LinkDraft,
  linkDraftOf,
  linkToApi,
  mapServerIssues,
  newCondition,
  newGroup,
  QueryRow,
  removeNode,
  sameFilter,
  setField,
  setOperator,
  toApiTree,
  updateNode,
  URL_LINK_MAX,
  URL_QUERY_MAX,
} from '../../../frontend/src/lib/query-builder';
import { parseQuery } from '../../src/services/publicationQuery/ast';
import { describeFields } from '../../src/services/publicationQuery/fields';

/*
 * The professor query builder's model and URL codec (frontend/src/lib/query-builder.ts; stage Q2).
 * The frontend has no test runner, so its framework-free module is tested here, against the real
 * field metadata and validator of the query engine: what the builder produces must be exactly what
 * the server accepts. No database, no network.
 */

const FIELDS = describeFields('PROFESSOR', true) as unknown as FieldMeta[];
const ADMIN_FIELDS = describeFields('ADMIN', true) as unknown as FieldMeta[];
const NO_SCOPUS = describeFields('PROFESSOR', false) as unknown as FieldMeta[];
const PAGE = 25;

function condition(root: BuilderGroup, index = 0): BuilderCondition {
  return root.children[index] as BuilderCondition;
}
function edit(root: BuilderGroup, id: string, value: BuilderCondition['value']): BuilderGroup {
  return updateNode(root, id, (n) => ({ ...(n as BuilderCondition), value }));
}

describe('builder operations', () => {
  it('adds, edits and removes conditions and groups', () => {
    let root = emptyRoot();
    expect(toApiTree(root, FIELDS)).toEqual({ issues: new Map() }); // no conditions = no root
    root = addChild(root, root.id, newCondition(FIELDS));
    expect(condition(root)).toMatchObject({ field: 'year', operator: 'eq', value: '' });
    // Incomplete → a local issue on that row, and no request is needed to find it.
    expect(toApiTree(root, FIELDS).issues.get(condition(root).id)).toBe('Enter a year');

    root = edit(root, condition(root).id, '2024');
    root = setOperator(root, condition(root).id, FIELDS, 'between'); // year → yearRange: value resets
    expect(condition(root).value).toEqual(['', '']);
    root = edit(root, condition(root).id, ['2020', '2024']);
    root = setOperator(root, condition(root).id, FIELDS, 'between');
    expect(condition(root).value).toEqual(['2020', '2024']);

    const group = newGroup(FIELDS);
    root = addChild(root, root.id, group);
    root = updateNode(root, group.id, (g) => ({ ...(g as BuilderGroup), combinator: 'OR' }));
    const inner = (root.children[1] as BuilderGroup).children[0] as BuilderCondition;
    root = setField(root, inner.id, FIELDS, 'type');
    root = edit(root, inner.id, ['JOURNAL', 'CONFERENCE']);
    root = addChild(root, group.id, { ...newCondition(FIELDS) });
    const second = (root.children[1] as BuilderGroup).children[1] as BuilderCondition;
    root = setField(root, second.id, FIELDS, 'doi');
    root = setOperator(root, second.id, FIELDS, 'isAbsent');

    expect(countConditions(root)).toBe(3);
    expect(groupDepths(root).get(group.id)).toBe(2);
    const { root: api, issues } = toApiTree(root, FIELDS);
    expect(issues.size).toBe(0);
    expect(api).toEqual({
      combinator: 'AND',
      children: [
        { field: 'year', operator: 'between', value: [2020, 2024] },
        { combinator: 'OR', children: [{ field: 'type', operator: 'in', value: ['JOURNAL', 'CONFERENCE'] }, { field: 'doi', operator: 'isAbsent' }] },
      ],
    });
    expect(() => parseQuery('PROFESSOR', { root: api })).not.toThrow();

    root = removeNode(root, second.id);
    expect(countConditions(root)).toBe(2);
    root = removeNode(root, group.id);
    expect(root.children).toHaveLength(1);
    expect(removeNode(root, root.id)).toBe(root); // the root group stays
  });

  it('converts every value kind into what the server accepts', () => {
    const cases: [string, string, BuilderCondition['value']][] = [
      ['year', 'lte', '2021'],
      ['year', 'isEmpty', ''],
      ['type', 'notIn', ['PREPRINT']],
      ['title', 'contains', '  graph  '],
      ['venue', 'isNotEmpty', ''],
      ['authors', 'contains', 'Smith'],
      ['doi', 'equals', 'https://doi.org/10.1000/ABC'],
      ['source', 'anyOf', ['SCOPUS', 'MANUAL']],
      ['issn', 'equals', '1234-5679'],
      ['addedOn', 'after', '2026-01-31'],
      ['addedOn', 'between', ['2026-01-01', '2026-02-01']],
      ['scopusCitations', 'gte', '10'],
      ['scopusCitations', 'between', ['0', '5']],
      ['scopusCitations', 'noCount', ''],
    ];
    for (const [field, operator, value] of cases) {
      let root = emptyRoot();
      const c = newCondition(FIELDS);
      root = addChild(root, root.id, c);
      root = setField(root, c.id, FIELDS, field);
      root = setOperator(root, c.id, FIELDS, operator);
      root = edit(root, c.id, value);
      const { root: api, issues } = toApiTree(root, FIELDS);
      expect(issues.size, `${field} ${operator}`).toBe(0);
      expect(() => parseQuery('PROFESSOR', { root: api }), `${field} ${operator}`).not.toThrow();
    }
  });

  it('reports incomplete values, reversed ranges, empty groups and unavailable fields locally', () => {
    const issue = (field: string, operator: string, value: BuilderCondition['value'], fields = FIELDS) => {
      let root = emptyRoot();
      const c = newCondition(fields);
      root = addChild(root, root.id, c);
      root = setField(root, c.id, fields, field);
      root = setOperator(root, c.id, fields, operator);
      root = edit(root, c.id, value);
      return toApiTree(root, fields).issues.get(c.id);
    };
    expect(issue('year', 'eq', 'abcd')).toBe('Enter a year');
    expect(issue('year', 'between', ['2024', '2020'])).toMatch(/greater/);
    expect(issue('addedOn', 'between', ['2026-02-01', '2026-01-01'])).toMatch(/after/);
    expect(issue('type', 'in', [])).toBe('Choose at least one value');
    expect(issue('title', 'contains', '   ')).toBe('Enter a value');
    expect(issue('title', 'contains', 'x'.repeat(301))).toMatch(/300/);
    expect(issue('scopusCitations', 'gte', '1', NO_SCOPUS)).toBe('Scopus citation data is unavailable');

    let root = emptyRoot();
    const g = { ...newGroup(FIELDS), children: [] };
    root = addChild(root, root.id, g);
    expect(toApiTree(root, FIELDS).issues.get(g.id)).toMatch(/Add a condition/);
  });

  it('new conditions never start on an unavailable citation field', () => {
    const fields = [...NO_SCOPUS].reverse(); // scopusCitations first, but unavailable
    expect(newCondition(fields).field).not.toBe('scopusCitations');
  });

  it('maps server validation paths to the rows they concern', () => {
    let root = emptyRoot();
    const a = newCondition(FIELDS);
    const g = newGroup(FIELDS);
    root = addChild(addChild(root, root.id, a), root.id, g);
    const inner = (root.children[1] as BuilderGroup).children[0];
    const { byNode, general } = mapServerIssues(root, [
      { path: 'root.children.0.value', message: 'Too small' },
      { path: 'root.children.1.children.0.value', message: 'Not a valid DOI' },
      { path: 'sort', message: 'Invalid option' },
      { path: 'root.children.9', message: 'Gone' },
    ]);
    expect(byNode.get(a.id)).toBe('Too small');
    expect(byNode.get(inner.id)).toBe('Not a valid DOI');
    expect(general).toEqual(['Invalid option', 'Gone']);
    expect(mapServerIssues(root, 'nonsense')).toEqual({ byNode: new Map(), general: [] });
  });
});

describe('URL state', () => {
  const tree: ApiGroup = {
    combinator: 'AND',
    children: [
      { field: 'title', operator: 'contains', value: 'Ünïcode & graphs/networks?' },
      { combinator: 'OR', children: [{ field: 'year', operator: 'between', value: [2020, 2024] }, { field: 'doi', operator: 'isAbsent' }] },
    ],
  };

  it('round-trips a query, leaving defaults out', () => {
    const params = encodeQuery({ root: tree, sort: 'title', offset: 50, limit: 50 }, PAGE);
    expect([...params.keys()]).toEqual(['q', 'sort', 'offset', 'limit']);
    expect(params.get('q')).toMatch(/^[A-Za-z0-9_-]+$/); // URL-safe, no padding
    const decoded = decodeQuery(new URLSearchParams(params.toString()), PAGE);
    expect(decoded).toEqual({ ok: true, query: { root: tree, sort: 'title', offset: 50, limit: 50 } });

    // The restored builder converts back into the same tree.
    const restored = fromApiTree(tree);
    expect(toApiTree(restored, FIELDS).root).toEqual(tree);

    expect(encodeQuery({ sort: 'year', offset: 0, limit: PAGE }, PAGE).toString()).toBe('');
    expect(decodeQuery(new URLSearchParams(''), PAGE)).toEqual({ ok: true, query: { sort: 'year', offset: 0, limit: PAGE } });
  });

  it('rejects malformed and tampered parameters', () => {
    const good = encodeQuery({ root: tree, sort: 'year', offset: 0, limit: PAGE }, PAGE).get('q')!;
    const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url');
    for (const search of [
      'q=',
      'q=%%%',
      'q=not+base64!',
      `q=${good.slice(0, -5)}`, // truncated
      `q=${b64('just a string')}`,
      `q=${b64({ combinator: 'XOR', children: [] })}`,
      `q=${b64({ combinator: 'AND', children: [{ field: 1, operator: 'eq' }] })}`,
      `q=${b64({ combinator: 'AND', children: [{ field: 'year', operator: 'eq', value: { $gt: 1 } }] })}`,
      `q=${Buffer.from([0xff, 0xfe]).toString('base64url')}`,
      `q=${'A'.repeat(URL_QUERY_MAX + 1)}`,
      'sort=status',
      'sort=',
      'offset=-1',
      'offset=1e3',
      'limit=abc',
      'limit=1000',
    ]) {
      expect(decodeQuery(new URLSearchParams(search), PAGE).ok, search).toBe(false);
    }
  });

  it('refuses to keep a valid query whose encoding exceeds the URL limit, and restores every query it keeps', () => {
    const title = (n: number) => Array.from({ length: n }, () => ({ field: 'title', operator: 'contains', value: 'x'.repeat(300) }));
    // 25 conditions (the maximum) in two groups of at most 20 entries each.
    const big: ApiGroup = { combinator: 'AND', children: [...title(12), { combinator: 'OR', children: title(13) }] };
    expect(() => parseQuery('PROFESSOR', { root: big })).not.toThrow(); // valid for the server…
    const query = { root: big, sort: 'year' as const, offset: 0, limit: PAGE };
    expect(fitsInUrl(query, PAGE)).toBe(false); // …but not restorable from a URL, so Apply refuses it
    expect(decodeQuery(encodeQuery(query, PAGE), PAGE).ok).toBe(false);
    const fits = { ...query, root: { combinator: 'AND' as const, children: title(15) } };
    expect(fitsInUrl(fits, PAGE)).toBe(true);
    expect(decodeQuery(encodeQuery(fits, PAGE), PAGE)).toEqual({ ok: true, query: fits });
  });

  it('only checks the shape: values and admin-only fields are left to the server, which refuses them', () => {
    const tampered = { combinator: 'AND', children: [{ field: 'publicationStatus', operator: 'in', value: ['SUPPRESSED'] }] } as ApiGroup;
    const params = new URLSearchParams({ q: Buffer.from(JSON.stringify(tampered)).toString('base64url'), limit: '500' });
    const decoded = decodeQuery(params, PAGE);
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) return;
    expect(() => parseQuery('PROFESSOR', decoded.query)).toThrow();
    expect(() => parseQuery('PROFESSOR', { ...decoded.query, root: undefined })).toThrow(); // limit 500
  });
});

describe('citation display (#157)', () => {
  const row = (extra: Partial<QueryRow>): QueryRow => ({ id: 'x', title: 'T', year: 2024, typeFamily: 'JOURNAL', venue: null, authorNamesDisplay: null, doi: null, sources: [], ...extra });
  const citation = (count: number) => ({ count, observedAt: '2026-06-01T00:00:00.000Z', recordUrl: null, citedByUrl: null });

  it('is decided by the state, never by a missing or null count', () => {
    expect(citationDisplay(row({ scopusCitationState: 'COUNTED', scopusCitation: citation(0) })).kind).toBe('zero');
    expect(citationDisplay(row({ scopusCitationState: 'COUNTED', scopusCitation: citation(7) })).kind).toBe('count');
    expect(citationDisplay(row({ scopusCitationState: 'NO_COUNT_YET', scopusCitation: null })).kind).toBe('noCountYet');
    expect(citationDisplay(row({ scopusCitationState: 'NOT_IN_SCOPUS', scopusCitation: null })).kind).toBe('notInScopus');
    expect(citationDisplay(row({ scopusCitation: null })).kind).toBe('unavailable');
    expect(citationDisplay(row({})).kind).toBe('unavailable');
  });
});

describe('administrator link scope and URL (Q3)', () => {
  const P1 = '11111111-1111-4111-8111-111111111111';
  const P2 = '22222222-2222-4222-8222-222222222222';
  const tree: ApiGroup = { combinator: 'AND', children: [{ field: 'publicationStatus', operator: 'in', value: ['ACTIVE'] }, { field: 'type', operator: 'notIn', value: ['PREPRINT'] }] };
  const selected: ApiLinkScope = { mode: 'SELECTED', statuses: ['APPROVED', 'PENDING'], origins: ['MANUAL'], decidedOn: { after: '2026-01-01' }, professors: [P1, P2], match: 'ALL' };
  const draft = (change: Partial<LinkDraft> = {}): LinkDraft => ({ ...linkDraftOf(selected), ...change });

  it('converts the link-scope editor into what the server accepts, with local issues', () => {
    expect(linkToApi(linkDraftOf(selected), 50)).toEqual({ link: selected });
    expect(() => parseQuery('ADMIN', { link: linkToApi(linkDraftOf(selected), 50).link, root: tree })).not.toThrow();
    // Modes other than SELECTED never send professors or a match.
    expect(linkToApi(draft({ mode: 'ANY_PROFESSOR' }), 50).link).toEqual({ mode: 'ANY_PROFESSOR', statuses: ['APPROVED', 'PENDING'], origins: ['MANUAL'], decidedOn: { after: '2026-01-01' } });
    expect(() => parseQuery('ADMIN', { link: linkToApi(draft({ mode: 'NO_LINK', statuses: [] }), 50).link })).not.toThrow();
    expect(linkToApi(draft({ professors: [] }), 50).issue).toBe('Select at least one professor');
    expect(linkToApi(draft({ professors: Array.from({ length: 51 }, (_, i) => `p${i}`) }), 50).issue).toMatch(/at most 50/);
    expect(linkToApi(draft({ professors: [P1, P1] }), 50).link.professors).toEqual([P1]);
    expect(linkToApi(draft({ statuses: [] }), 50).issue).toMatch(/status/);
    expect(linkToApi(draft({ decidedAfter: '2026-05-01', decidedBefore: '2026-01-01' }), 50).issue).toMatch(/after/);
  });

  it('round-trips an admin query through the URL; a URL without parameters means "no query"', () => {
    const query = { link: selected, root: tree, sort: 'title' as const, offset: 25, limit: 25 };
    const params = encodeQuery(query, PAGE);
    expect([...params.keys()]).toEqual(['link', 'q', 'sort', 'offset']);
    expect(decodeQuery(new URLSearchParams(params.toString()), PAGE, { link: true })).toEqual({ ok: true, query });
    // A query without conditions is still a query (link scope only).
    expect(decodeQuery(encodeQuery({ link: selected, sort: 'year', offset: 0, limit: PAGE }, PAGE), PAGE, { link: true })).toEqual({ ok: true, query: { link: selected, sort: 'year', offset: 0, limit: PAGE } });
    expect(decodeQuery(new URLSearchParams(''), PAGE, { link: true })).toEqual({ ok: true, query: null });
    // The professor's URL format is unchanged and refuses a link scope.
    expect(decodeQuery(params, PAGE).ok).toBe(false);
    expect([...encodeQuery({ root: tree, sort: 'year', offset: 0, limit: PAGE }, PAGE).keys()]).toEqual(['q']);
  });

  it('refuses malformed and tampered admin URLs', () => {
    const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url');
    const q = b64(tree);
    for (const search of [
      `q=${q}`, // conditions without a link scope
      'sort=title',
      'link=',
      'link=%%%',
      `link=${b64('ANY_PROFESSOR')}`,
      `link=${b64({ mode: 'ANY_PROFESSOR' })}`, // statuses missing
      `link=${b64({ mode: 'ANY_PROFESSOR', statuses: 'APPROVED' })}`,
      `link=${b64({ mode: 'ANY_PROFESSOR', statuses: ['APPROVED'], departmentId: 'x' })}`,
      `link=${b64({ mode: 'SELECTED', statuses: ['APPROVED'], professors: [1, 2] })}`,
      `link=${b64({ mode: 'ANY_PROFESSOR', statuses: ['APPROVED'], decidedOn: { since: '2026-01-01' } })}`,
      `link=${'A'.repeat(URL_LINK_MAX + 1)}`,
      `link=${b64({ mode: 'ANY_PROFESSOR', statuses: ['APPROVED'] })}&q=%%%`,
    ]) {
      expect(decodeQuery(new URLSearchParams(search), PAGE, { link: true }).ok, search).toBe(false);
    }
    // Values are left to the server: an unknown mode decodes, then the server refuses it.
    const unknownMode = decodeQuery(new URLSearchParams(`link=${b64({ mode: 'EVERYTHING', statuses: ['APPROVED'] })}`), PAGE, { link: true });
    expect(unknownMode.ok).toBe(true);
    if (unknownMode.ok) expect(() => parseQuery('ADMIN', unknownMode.query)).toThrow();
    expect(fitsInUrl({ link: { ...selected, professors: Array.from({ length: 50 }, () => P1) }, sort: 'year', offset: 0, limit: PAGE }, PAGE)).toBe(true);
  });
});

describe('unsaved filter changes and paging (shared UX, Q3)', () => {
  const link: ApiLinkScope = { mode: 'ANY_PROFESSOR', statuses: ['APPROVED'] };
  const tree: ApiGroup = { combinator: 'AND', children: [{ field: 'year', operator: 'between', value: [2020, 2024] }, { field: 'title', operator: 'contains', value: 'graph' }] };

  it('a builder restored from the applied query has no unsaved changes; an edit has; discarding restores it', () => {
    const applied = builderOf({ link, root: tree });
    const appliedKey = builderKey(applied.root, applied.link, ADMIN_FIELDS);
    const fresh = builderOf({ link, root: tree }); // e.g. after reload: new row ids, same query
    expect(builderKey(fresh.root, fresh.link, ADMIN_FIELDS)).toBe(appliedKey);
    const title = fresh.root.children[1] as BuilderCondition;
    // Whitespace that Apply would trim is not a change.
    expect(builderKey(updateNode(fresh.root, title.id, (n) => ({ ...(n as BuilderCondition), value: '  graph ' })), fresh.link, ADMIN_FIELDS)).toBe(appliedKey);
    expect(builderKey(updateNode(fresh.root, title.id, (n) => ({ ...(n as BuilderCondition), value: 'graphs' })), fresh.link, ADMIN_FIELDS)).not.toBe(appliedKey);
    expect(builderKey(fresh.root, { ...fresh.link!, statuses: ['APPROVED', 'PENDING'] }, ADMIN_FIELDS)).not.toBe(appliedKey);
    expect(builderKey(removeNode(fresh.root, title.id), fresh.link, ADMIN_FIELDS)).not.toBe(appliedKey);
    const discarded = builderOf({ link, root: tree });
    expect(builderKey(discarded.root, discarded.link, ADMIN_FIELDS)).toBe(appliedKey);
    // Professor (no link scope).
    const prof = builderOf({ root: tree });
    expect(builderKey(prof.root, prof.link, FIELDS)).toBe(builderKey(builderOf({ root: tree }).root, null, FIELDS));
    expect(builderKey(emptyRoot(), null, FIELDS)).toBe(builderKey(builderOf({}).root, null, FIELDS));
  });

  it('sorting and paging keep the same filter (previous rows may stay while loading); another query does not', () => {
    const a = { link, root: tree, sort: 'year' as const, offset: 0, limit: 25 };
    expect(sameFilter(a, { ...a, sort: 'title', offset: 50, limit: 100 })).toBe(true);
    expect(sameFilter(a, { ...a, root: { ...tree, combinator: 'OR' } })).toBe(false);
    expect(sameFilter(a, { ...a, link: { ...link, statuses: ['PENDING'] } })).toBe(false);
    expect(sameFilter(a, { ...a, root: undefined })).toBe(false);
    expect(sameFilter(null, a)).toBe(false);
    expect(sameFilter({ sort: 'year', offset: 0, limit: 25 }, { sort: 'title', offset: 25, limit: 25 })).toBe(true);
  });
});

describe('conditional analytics vs table consistency (Q4 review, #163)', () => {
  it('shows analytics only when both fingerprints are present and equal — never decided by totals', () => {
    const f1 = 'a'.repeat(64);
    const f2 = 'b'.repeat(64);
    expect(analyticsConsistency({ fingerprint: f1 }, { fingerprint: f1 })).toBe('consistent');
    expect(analyticsConsistency({ fingerprint: f1 }, { fingerprint: f2 })).toBe('changed');
    // Equal totals do not make different sets consistent.
    expect(analyticsConsistency({ fingerprint: f1, total: 5 } as { fingerprint: string }, { fingerprint: f2, total: 5 } as { fingerprint: string })).toBe('changed');
    expect(analyticsConsistency(null, { fingerprint: f1 })).toBe('pending');
    expect(analyticsConsistency({ fingerprint: f1 }, undefined)).toBe('pending');
    expect(analyticsConsistency({}, { fingerprint: f1 })).toBe('pending');
  });
});
