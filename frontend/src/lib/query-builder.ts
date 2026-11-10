/**
 * Publication-query builder model (Project_plan.md §24.3, §24.7, §24.8; decisions #154–#157).
 *
 * Framework-free: the builder's state, its immutable edits, the conversion to and from the query
 * engine's condition tree, local completeness checks, the mapping of the server's validation paths
 * back to builder rows, and the URL encoding of an applied query (D11). The server remains the only
 * authority: everything built here is re-validated and re-authorized on every request, and a query
 * read from a URL is never trusted. Fields, operators, value kinds, sorts and limits come from the
 * server's `…/fields` response; nothing here defines which fields exist.
 */

// ─── Server contracts (as returned by the Q1 query engine) ─────────────────────────────────────

export type ValueKind = 'none' | 'year' | 'yearRange' | 'types' | 'text' | 'sources' | 'date' | 'dateRange' | 'count' | 'countRange' | 'statuses' | 'boolean';
export type SortKey = 'year' | 'title' | 'addedOn' | 'scopusCitations';
export type ScopusCitationState = 'COUNTED' | 'NO_COUNT_YET' | 'NOT_IN_SCOPUS';

export interface FieldMeta {
  id: string;
  label: string;
  options?: string[];
  operators: { operator: string; value: ValueKind }[];
  available: boolean;
  unavailableReason?: string;
}
export interface QueryFieldsResponse {
  fields: FieldMeta[];
  scopus: { available: boolean };
  sorts: { key: SortKey; available: boolean }[];
  limits: { conditions: number; depth: number; groupChildren: number; pageDefault: number; pageMax: number };
  /** Administrator only. */
  link?: { modes: LinkMode[]; statuses: string[]; origins: string[]; maxProfessors: number };
  /** Administrator only: the initial query (D2, D3). */
  defaultQuery?: { link: ApiLinkScope; root: ApiGroup };
}
export interface PresetMeta {
  id: string;
  label: string;
  parameter?: 'year' | 'text' | 'professors';
  available: boolean;
  unavailableReason?: string;
}
export interface ApiCondition {
  field: string;
  operator: string;
  value?: unknown;
}
export interface ApiGroup {
  combinator: 'AND' | 'OR';
  children: (ApiCondition | ApiGroup)[];
}
export type LinkMode = 'ANY_PROFESSOR' | 'SELECTED' | 'NO_LINK' | 'ALL_PUBLICATIONS';
export interface ApiLinkScope {
  mode: LinkMode;
  statuses: string[];
  origins?: string[];
  decidedOn?: { after?: string; before?: string };
  professors?: string[];
  match?: 'ANY' | 'ALL';
}
/** A linked professor of an administrator's result row (§24.7). */
export interface QueryRowProfessor {
  id: string;
  name: string;
  isActive: boolean;
  status: 'APPROVED' | 'PENDING' | 'REJECTED';
  origin: string;
  qualifying: boolean;
  selected: boolean;
}
export interface QueryCitation {
  count: number;
  observedAt: string;
  recordUrl: string | null;
  citedByUrl: string | null;
}
export interface QueryRow {
  id: string;
  title: string;
  year: number | null;
  typeFamily: string;
  venue: string | null;
  authorNamesDisplay: string | null;
  doi: string | null;
  sources: string[];
  scopusCitation?: QueryCitation | null;
  scopusCitationState?: ScopusCitationState;
  /** Administrator only. */
  status?: 'ACTIVE' | 'SUPPRESSED';
  isCurated?: boolean;
  professors?: QueryRowProfessor[];
}
export type CitationSummary =
  | { available: false }
  | { available: true; latestObservation: string | null; coverage: { withCount: number; withoutCount: number; notInScopus: number; noCountYet: number } };
export interface SearchResponse {
  publications: QueryRow[];
  total: number;
  limit: number;
  offset: number;
  sort: SortKey;
  citations: CitationSummary;
  /** Fingerprint of the complete matching set (a hash; no IDs), equal for equal sets. */
  fingerprint: string;
}

/** `POST /api/admin/publication-queries/analytics` (§24.6, stage Q4); `analytics` is null with fewer than two matches (D5). */
export interface QueryAnalyticsResponse {
  total: number;
  /** Fingerprint of the matching set the analytics were computed over (compare with the search's). */
  fingerprint: string;
  analytics: {
    years?: { years: { year: number; publications: number }[]; unknownYear: number; total: number };
    types?: { typeFamily: string; publications: number }[];
    venues?: { venues: { venue: string; publications: number }[]; otherVenues: number; withoutVenue: number };
    professors?: { rows: { id: string; name: string; isActive: boolean; selected: boolean; publications: number }[]; selectedCount: number };
    overlap?: { publications: number; selected: number };
    relationshipStatuses?: { status: 'APPROVED' | 'PENDING' | 'REJECTED'; links: number; publications: number }[];
    publicationStatuses?: { status: 'ACTIVE' | 'SUPPRESSED'; publications: number }[];
    doi?: { withDoi: number; withoutDoi: number };
    sources?: { source: string; publications: number; sourceRecords: number }[];
    citations:
      | { available: false }
      | { available: true; withCount: 0; coverage: { withCount: number; withoutCount: number; notInScopus: number; noCountYet: number } }
      | {
          available: true;
          withCount: number;
          coverage: { withCount: number; withoutCount: number; notInScopus: number; noCountYet: number };
          latestObservation: string | null;
          totalCitations: number;
          median: number;
          maximum: number;
          top: { id: string; title: string; year: number | null; count: number; observedAt: string }[];
        };
  } | null;
}

/**
 * Whether conditional analytics describe the same publications as the table (Q4 review, #163).
 * The table and the analytics come from separate requests; data may change between them. Only the
 * matching-set fingerprints decide — never totals, which can be equal for different sets.
 *   pending     one of the two has not arrived
 *   consistent  same set: the analytics may be shown
 *   changed     different sets: the analytics must not be shown (offer a manual refresh)
 */
export function analyticsConsistency(
  table: { fingerprint?: string } | null | undefined,
  analytics: { fingerprint?: string } | null | undefined,
): 'pending' | 'consistent' | 'changed' {
  if (!table?.fingerprint || !analytics?.fingerprint) return 'pending';
  return table.fingerprint === analytics.fingerprint ? 'consistent' : 'changed';
}

// ─── Builder state ───────────────────────────────────────────────────────────────────────────────

/** A condition's value while it is edited: text inputs keep strings until the query is applied. */
export type DraftValue = string | [string, string] | string[];

export interface BuilderCondition {
  kind: 'condition';
  id: string;
  field: string;
  operator: string;
  value: DraftValue;
}
export interface BuilderGroup {
  kind: 'group';
  id: string;
  combinator: 'AND' | 'OR';
  children: BuilderNode[];
}
export type BuilderNode = BuilderCondition | BuilderGroup;

let sequence = 0;
const nextId = () => `n${++sequence}`;

export function emptyRoot(): BuilderGroup {
  return { kind: 'group', id: nextId(), combinator: 'AND', children: [] };
}

export function valueKind(fields: readonly FieldMeta[], field: string, operator: string): ValueKind | undefined {
  return fields.find((f) => f.id === field)?.operators.find((o) => o.operator === operator)?.value;
}

export function defaultValue(kind: ValueKind | undefined): DraftValue {
  switch (kind) {
    case 'yearRange':
    case 'dateRange':
    case 'countRange':
      return ['', ''];
    case 'types':
    case 'sources':
    case 'statuses':
      return [];
    default:
      return '';
  }
}

/** A new condition on the first available field and its first operator. */
export function newCondition(fields: readonly FieldMeta[]): BuilderCondition {
  const field = fields.find((f) => f.available) ?? fields[0];
  const operator = field?.operators[0];
  return { kind: 'condition', id: nextId(), field: field?.id ?? '', operator: operator?.operator ?? '', value: defaultValue(operator?.value) };
}

export function newGroup(fields: readonly FieldMeta[]): BuilderGroup {
  return { kind: 'group', id: nextId(), combinator: 'AND', children: [newCondition(fields)] };
}

function mapTree(node: BuilderNode, fn: (node: BuilderNode) => BuilderNode | null): BuilderNode | null {
  const mapped = fn(node);
  if (!mapped || mapped.kind === 'condition') return mapped;
  return { ...mapped, children: mapped.children.map((c) => mapTree(c, fn)).filter((c): c is BuilderNode => c !== null) };
}

/** Replaces the node with `id`. */
export function updateNode(root: BuilderGroup, id: string, change: (node: BuilderNode) => BuilderNode): BuilderGroup {
  return mapTree(root, (n) => (n.id === id ? change(n) : n)) as BuilderGroup;
}

/** Removes the node with `id` (the root itself is never removed). */
export function removeNode(root: BuilderGroup, id: string): BuilderGroup {
  if (root.id === id) return root;
  return mapTree(root, (n) => (n.id === id ? null : n)) as BuilderGroup;
}

/** Appends a node to the group with `groupId`. */
export function addChild(root: BuilderGroup, groupId: string, child: BuilderNode): BuilderGroup {
  return updateNode(root, groupId, (n) => (n.kind === 'group' ? { ...n, children: [...n.children, child] } : n));
}

/** Changes a condition's field (operator and value reset to the field's first operator). */
export function setField(root: BuilderGroup, id: string, fields: readonly FieldMeta[], field: string): BuilderGroup {
  const meta = fields.find((f) => f.id === field);
  const operator = meta?.operators[0];
  return updateNode(root, id, (n) => (n.kind === 'condition' ? { ...n, field, operator: operator?.operator ?? '', value: defaultValue(operator?.value) } : n));
}

/** Changes a condition's operator; the value is kept when its kind does not change. */
export function setOperator(root: BuilderGroup, id: string, fields: readonly FieldMeta[], operator: string): BuilderGroup {
  return updateNode(root, id, (n) => {
    if (n.kind !== 'condition') return n;
    const same = valueKind(fields, n.field, n.operator) === valueKind(fields, n.field, operator);
    return { ...n, operator, value: same ? n.value : defaultValue(valueKind(fields, n.field, operator)) };
  });
}

export function countConditions(node: BuilderNode): number {
  return node.kind === 'condition' ? 1 : node.children.reduce((n, c) => n + countConditions(c), 0);
}

/** The nesting level of every group (root = 1). */
export function groupDepths(root: BuilderGroup): Map<string, number> {
  const depths = new Map<string, number>();
  const visit = (g: BuilderGroup, d: number) => {
    depths.set(g.id, d);
    for (const c of g.children) if (c.kind === 'group') visit(c, d + 1);
  };
  visit(root, 1);
  return depths;
}

// ─── Conversion and local checks ─────────────────────────────────────────────────────────────────

const INTEGER = /^\d{1,10}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** One condition's draft value as the API value, or a message explaining what is missing. */
function apiValue(kind: ValueKind, value: DraftValue): { value?: unknown; issue?: string } {
  const one = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
  switch (kind) {
    case 'none':
      return {};
    case 'year':
    case 'count': {
      const v = one(value);
      if (!INTEGER.test(v)) return { issue: kind === 'year' ? 'Enter a year' : 'Enter a whole number' };
      return { value: Number(v) };
    }
    case 'yearRange':
    case 'countRange': {
      const [a, b] = Array.isArray(value) ? value.map(one) : ['', ''];
      if (!INTEGER.test(a) || !INTEGER.test(b)) return { issue: 'Enter both values' };
      if (Number(a) > Number(b)) return { issue: 'The first value must not be greater than the second' };
      return { value: [Number(a), Number(b)] };
    }
    case 'date': {
      const v = one(value);
      return DATE.test(v) ? { value: v } : { issue: 'Choose a date' };
    }
    case 'dateRange': {
      const [a, b] = Array.isArray(value) ? value.map(one) : ['', ''];
      if (!DATE.test(a) || !DATE.test(b)) return { issue: 'Choose both dates' };
      if (a > b) return { issue: 'The first date must not be after the second' };
      return { value: [a, b] };
    }
    case 'types':
    case 'sources':
    case 'statuses':
      return Array.isArray(value) && value.length > 0 ? { value: [...value] } : { issue: 'Choose at least one value' };
    case 'boolean':
      return value === 'true' || value === 'false' ? { value: value === 'true' } : { issue: 'Choose yes or no' };
    case 'text': {
      const v = one(value);
      if (!v) return { issue: 'Enter a value' };
      if (v.length > 300) return { issue: 'Use at most 300 characters' };
      return { value: v };
    }
  }
}

/**
 * The builder as the API's condition tree, with local issues per node (empty values, empty groups,
 * unavailable fields). An empty root means "no conditions". The server validates again.
 */
export function toApiTree(root: BuilderGroup, fields: readonly FieldMeta[]): { root?: ApiGroup; issues: Map<string, string> } {
  const issues = new Map<string, string>();
  const convert = (node: BuilderNode): ApiCondition | ApiGroup => {
    if (node.kind === 'group') {
      if (node.children.length === 0) issues.set(node.id, 'Add a condition to this group or remove it');
      return { combinator: node.combinator, children: node.children.map(convert) };
    }
    const meta = fields.find((f) => f.id === node.field);
    const kind = valueKind(fields, node.field, node.operator);
    if (!meta || !kind) {
      issues.set(node.id, 'Choose a field and an operator');
      return { field: node.field, operator: node.operator };
    }
    if (!meta.available) issues.set(node.id, meta.unavailableReason ?? 'This field is unavailable');
    const { value, issue } = apiValue(kind, node.value);
    if (issue && !issues.has(node.id)) issues.set(node.id, issue);
    return { field: node.field, operator: node.operator, ...(value !== undefined && { value }) };
  };
  if (root.children.length === 0) return { issues };
  return { root: convert(root) as ApiGroup, issues };
}

/** A builder from an API tree (from a URL or a preset). Unknown shapes throw. */
export function fromApiTree(group: ApiGroup): BuilderGroup {
  const convert = (node: ApiCondition | ApiGroup): BuilderNode => {
    if ('combinator' in node) {
      if ((node.combinator !== 'AND' && node.combinator !== 'OR') || !Array.isArray(node.children)) throw new Error('Malformed group');
      return { kind: 'group', id: nextId(), combinator: node.combinator, children: node.children.map(convert) };
    }
    if (typeof node.field !== 'string' || typeof node.operator !== 'string') throw new Error('Malformed condition');
    return { kind: 'condition', id: nextId(), field: node.field, operator: node.operator, value: draftOf(node.value) };
  };
  const root = convert(group);
  if (root.kind !== 'group') throw new Error('Malformed query');
  return root;
}

function draftOf(value: unknown): DraftValue {
  if (value === undefined || value === null) return '';
  if (typeof value === 'boolean' || typeof value === 'number') return String(value);
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    if (value.length === 2 && value.every((v) => typeof v === 'number' || (typeof v === 'string' && DATE.test(v)))) {
      return [String(value[0]), String(value[1])];
    }
    if (value.every((v) => typeof v === 'string')) return [...value];
  }
  throw new Error('Malformed value');
}

/**
 * Maps the server's validation details (paths such as `root.children.1.children.0.value`) to the
 * builder rows they concern; anything else is returned as general messages.
 */
export function mapServerIssues(root: BuilderGroup, details: unknown): { byNode: Map<string, string>; general: string[] } {
  const byNode = new Map<string, string>();
  const general: string[] = [];
  if (!Array.isArray(details)) return { byNode, general };
  for (const d of details as { path?: unknown; message?: unknown }[]) {
    const path = typeof d.path === 'string' ? d.path : '';
    const message = typeof d.message === 'string' ? d.message : 'Invalid value';
    let node: BuilderNode | undefined = root;
    const indexes = [...path.matchAll(/children\.(\d+)/g)].map((m) => Number(m[1]));
    if (!path.startsWith('root')) node = undefined;
    for (const i of indexes) node = node?.kind === 'group' ? node.children[i] : undefined;
    if (node && node !== root) byNode.set(node.id, message);
    else general.push(message);
  }
  return { byNode, general };
}

// ─── URL state (D11) ─────────────────────────────────────────────────────────────────────────────

export const URL_QUERY_MAX = 8_000;
/** A link scope with 50 professors is about 2,900 characters encoded. */
export const URL_LINK_MAX = 4_000;
const SORTS: readonly SortKey[] = ['year', 'title', 'addedOn', 'scopusCitations'];

export interface AppliedQuery {
  /** Administrator only (§24.5). */
  link?: ApiLinkScope;
  root?: ApiGroup;
  sort: SortKey;
  offset: number;
  limit: number;
}

function toBase64Url(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(encoded: string): string {
  if (!/^[A-Za-z0-9_-]*$/.test(encoded)) throw new Error('Not base64url');
  const binary = atob(encoded.replace(/-/g, '+').replace(/_/g, '/'));
  return new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(binary, (c) => c.charCodeAt(0)));
}

/** URL parameters of an applied query; defaults are left out (sort year, offset 0, the default page size). */
export function encodeQuery(query: AppliedQuery, pageDefault: number): URLSearchParams {
  const params = new URLSearchParams();
  if (query.link) params.set('link', toBase64Url(JSON.stringify(query.link)));
  if (query.root) params.set('q', toBase64Url(JSON.stringify(query.root)));
  if (query.sort !== 'year') params.set('sort', query.sort);
  if (query.offset > 0) params.set('offset', String(query.offset));
  if (query.limit !== pageDefault) params.set('limit', String(query.limit));
  return params;
}

/** Whether an applied query fits the URL limits, so the URL can restore it (D11). */
export function fitsInUrl(query: AppliedQuery, pageDefault: number): boolean {
  const params = encodeQuery(query, pageDefault);
  return (params.get('q') ?? '').length <= URL_QUERY_MAX && (params.get('link') ?? '').length <= URL_LINK_MAX;
}

const LINK_KEYS = new Set(['mode', 'statuses', 'origins', 'decidedOn', 'professors', 'match']);
const isStringList = (v: unknown) => Array.isArray(v) && v.length <= 500 && v.every((x) => typeof x === 'string');

/** Shape check of a link scope read from a URL; its values are validated by the server. */
function linkShape(value: unknown): value is ApiLinkScope {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const l = value as Record<string, unknown>;
  if (!Object.keys(l).every((k) => LINK_KEYS.has(k))) return false;
  if (typeof l.mode !== 'string' || !isStringList(l.statuses)) return false;
  if (l.origins !== undefined && !isStringList(l.origins)) return false;
  if (l.professors !== undefined && !isStringList(l.professors)) return false;
  if (l.match !== undefined && typeof l.match !== 'string') return false;
  if (l.decidedOn !== undefined) {
    const d = l.decidedOn as Record<string, unknown>;
    if (typeof d !== 'object' || d === null || !Object.entries(d).every(([k, v]) => (k === 'after' || k === 'before') && typeof v === 'string')) return false;
  }
  return true;
}

/**
 * Reads an applied query from URL parameters. Only the shape is checked here (decodable JSON of
 * groups and conditions, a known sort, whole-number paging, and for the administrator a link
 * scope); every value is validated by the server. Returns `ok: false` for anything malformed.
 *
 * `link` — the administrator's page: an applied query always has a link scope, and a URL without
 * any query parameter means "no query" (`query: null`, the department-wide view). The professor's
 * page refuses a link scope.
 */
export function decodeQuery(params: URLSearchParams, pageDefault: number): { ok: true; query: AppliedQuery } | { ok: false; reason: string };
export function decodeQuery(
  params: URLSearchParams,
  pageDefault: number,
  options: { link: true },
): { ok: true; query: AppliedQuery | null } | { ok: false; reason: string };
export function decodeQuery(
  params: URLSearchParams,
  pageDefault: number,
  options: { link?: boolean } = {},
): { ok: true; query: AppliedQuery | null } | { ok: false; reason: string } {
  const q = params.get('q');
  const encodedLink = params.get('link');
  if (encodedLink !== null && !options.link) return { ok: false, reason: 'unexpected link scope' };
  if (options.link && encodedLink === null) {
    if (['q', 'sort', 'offset', 'limit'].some((k) => params.has(k))) return { ok: false, reason: 'missing link scope' };
    return { ok: true, query: null };
  }
  const sort = params.get('sort') ?? 'year';
  const offset = params.get('offset') ?? '0';
  const limit = params.get('limit') ?? String(pageDefault);
  if (!(SORTS as readonly string[]).includes(sort)) return { ok: false, reason: 'unknown sort' };
  if (!/^\d{1,7}$/.test(offset) || !/^\d{1,3}$/.test(limit)) return { ok: false, reason: 'invalid paging' };
  let root: ApiGroup | undefined;
  if (q !== null) {
    if (q.length === 0 || q.length > URL_QUERY_MAX) return { ok: false, reason: 'invalid query length' };
    try {
      const parsed = JSON.parse(fromBase64Url(q)) as ApiGroup;
      fromApiTree(parsed); // shape check
      root = parsed;
    } catch {
      return { ok: false, reason: 'undecodable query' };
    }
  }
  let link: ApiLinkScope | undefined;
  if (encodedLink !== null) {
    if (encodedLink.length === 0 || encodedLink.length > URL_LINK_MAX) return { ok: false, reason: 'invalid link length' };
    try {
      const parsed: unknown = JSON.parse(fromBase64Url(encodedLink));
      if (!linkShape(parsed)) return { ok: false, reason: 'malformed link scope' };
      link = parsed;
    } catch {
      return { ok: false, reason: 'undecodable link scope' };
    }
  }
  return { ok: true, query: { ...(link && { link }), ...(root && { root }), sort: sort as SortKey, offset: Number(offset), limit: Number(limit) } };
}

// ─── Administrator link scope (§24.5) ────────────────────────────────────────────────────────────

/** The link-scope editor's state; text inputs stay strings until the query is applied. */
export interface LinkDraft {
  mode: LinkMode;
  statuses: string[];
  origins: string[];
  decidedAfter: string;
  decidedBefore: string;
  professors: string[];
  match: 'ANY' | 'ALL';
}

export function linkDraftOf(link: ApiLinkScope): LinkDraft {
  return {
    mode: link.mode,
    statuses: [...link.statuses],
    origins: [...(link.origins ?? [])],
    decidedAfter: link.decidedOn?.after ?? '',
    decidedBefore: link.decidedOn?.before ?? '',
    professors: [...(link.professors ?? [])],
    match: link.match === 'ALL' ? 'ALL' : 'ANY',
  };
}

/**
 * The link-scope editor as the API's link scope, with a local issue when it is incomplete. The
 * server validates it again (statuses, 1–50 existing professors, dates).
 */
export function linkToApi(draft: LinkDraft, maxProfessors: number): { link: ApiLinkScope; issue?: string } {
  const after = draft.decidedAfter.trim();
  const before = draft.decidedBefore.trim();
  const professors = [...new Set(draft.professors)];
  // In NO_LINK the statuses decide nothing and are not edited; the server's default is kept valid.
  const statuses = draft.mode === 'NO_LINK' && draft.statuses.length === 0 ? ['APPROVED'] : [...draft.statuses];
  const link: ApiLinkScope = {
    mode: draft.mode,
    statuses,
    ...(draft.origins.length > 0 && { origins: [...draft.origins] }),
    ...((after || before) && { decidedOn: { ...(after && { after }), ...(before && { before }) } }),
    ...(draft.mode === 'SELECTED' && { professors, match: draft.match }),
  };
  let issue: string | undefined;
  if (statuses.length === 0) issue = 'Choose at least one relationship status';
  else if (draft.mode === 'SELECTED' && professors.length === 0) issue = 'Select at least one professor';
  else if (draft.mode === 'SELECTED' && professors.length > maxProfessors) issue = `Select at most ${maxProfessors} professors`;
  else if ((after && !DATE.test(after)) || (before && !DATE.test(before))) issue = 'Choose valid decision dates';
  else if (after && before && after > before) issue = 'The first decision date must not be after the second';
  return { link, ...(issue && { issue }) };
}

// ─── Applied query vs builder ────────────────────────────────────────────────────────────────────

/**
 * A comparable form of a builder state (condition tree and, for the administrator, link scope).
 * Both the builder and the applied query are compared through this one conversion, so a query
 * restored from a URL is not reported as changed.
 */
export function builderKey(root: BuilderGroup, link: LinkDraft | null, fields: readonly FieldMeta[], maxProfessors = 50): string {
  return JSON.stringify({ root: toApiTree(root, fields).root ?? null, link: link ? linkToApi(link, maxProfessors).link : null });
}

/** The builder state of an applied query. */
export function builderOf(query: Pick<AppliedQuery, 'root' | 'link'>): { root: BuilderGroup; link: LinkDraft | null } {
  return { root: query.root ? fromApiTree(query.root) : emptyRoot(), link: query.link ? linkDraftOf(query.link) : null };
}

/** Whether two applied queries select the same publications (they may differ in sort and page only). */
type FilterOf = Pick<AppliedQuery, 'root' | 'link'> | AppliedQuery;
export function sameFilter(a: FilterOf | null, b: FilterOf | null): boolean {
  if (!a || !b) return a === b;
  return JSON.stringify([a.root ?? null, a.link ?? null]) === JSON.stringify([b.root ?? null, b.link ?? null]);
}

// ─── Display ─────────────────────────────────────────────────────────────────────────────────────

export const OPERATOR_LABEL: Record<string, string> = {
  eq: 'is',
  neq: 'is not',
  gt: 'after / more than',
  gte: 'from / at least',
  lt: 'before / less than',
  lte: 'up to / at most',
  between: 'between',
  isEmpty: 'is unknown',
  isNotEmpty: 'is known',
  in: 'is any of',
  notIn: 'is none of',
  contains: 'contains',
  notContains: 'does not contain',
  equals: 'is exactly',
  startsWith: 'starts with',
  isPresent: 'is present',
  isAbsent: 'is missing',
  anyOf: 'any of',
  noneOf: 'none of',
  before: 'before',
  after: 'after',
  hasCount: 'has a Scopus count',
  noCount: 'has no Scopus count',
  is: 'is',
};

export const SORT_LABEL: Record<SortKey, string> = {
  year: 'Year (newest first)',
  title: 'Title (A–Z)',
  addedOn: 'Date added (newest first)',
  scopusCitations: 'Scopus citations (highest first)',
};

/**
 * How a row's Scopus citation is shown (#157). Decided only from the server's citation state —
 * never inferred from a missing or null count: a counted zero is "0 citations"; a Scopus record
 * without an observation is "No Scopus count yet"; no Scopus record is "Not in Scopus".
 */
export function citationDisplay(row: QueryRow): { kind: 'count'; citation: QueryCitation } | { kind: 'zero'; citation: QueryCitation } | { kind: 'noCountYet' } | { kind: 'notInScopus' } | { kind: 'unavailable' } {
  switch (row.scopusCitationState) {
    case 'COUNTED':
      if (!row.scopusCitation) return { kind: 'unavailable' };
      return row.scopusCitation.count === 0 ? { kind: 'zero', citation: row.scopusCitation } : { kind: 'count', citation: row.scopusCitation };
    case 'NO_COUNT_YET':
      return { kind: 'noCountYet' };
    case 'NOT_IN_SCOPUS':
      return { kind: 'notInScopus' };
    default:
      return { kind: 'unavailable' };
  }
}
