import { createHash } from 'node:crypto';
import { Prisma, PrismaClient, PublicationSource, RelationshipOrigin, VerificationStatus } from '@prisma/client';
import { prisma as defaultClient } from '../../config/database';
import { HttpError } from '../../utils/httpError';
import { scopusCitations, ScopusCitation } from '../citations/scopusCitations';
import type { Tx } from '../matching/engine';
import { orderedSources } from '../publications/adminPublications';
import { AdminQuery, conditionsOf, LinkScope, LIMITS, parseQuery, ProfessorQuery, SORT_KEYS, LINK_MODES } from './ast';
import { CitationCount, scopusCounts, scopusDataAvailable } from './citations';
import { utcDay } from './dates';
import { compileTree } from './compile';
import { CITATION_FIELDS, describeFields, Role } from './fields';
import { adminLinkScope, professorScope, qualifyingLink } from './scope';

/**
 * Publication query execution (Project_plan.md §24.3–§24.8; decision #154). One entry point per
 * concern, shared by the professor and administrator endpoints of stages Q2 / Q3:
 *
 *   searchPublications(context, body)  validate → authorize → scope → compile → page
 *   queryFields(context)               the role's fields, operators, limits and data availability
 *
 * The caller's identity comes only from `context` (the session); the body is untrusted — it is
 * fully re-validated on every request, including when it was decoded from a page URL (D11).
 * Everything runs in one read-only REPEATABLE READ transaction with a statement timeout
 * (`inQueryTransaction`): every statement of a request sees the same database snapshot, so the
 * total, the page, the coverage and the matching-set fingerprint agree, and no query runs unbounded.
 * Separate requests (another page, or the conditional analytics) see the database as it is then;
 * the fingerprint lets a client detect that the matching set changed between them.
 */

export type QueryContext = { role: 'PROFESSOR'; professorId: string } | { role: 'ADMIN' };

/** Per-query statement timeout (§24.9; implementation decision of stage Q1): 5 s, then 503 QUERY_TIMEOUT. */
export const STATEMENT_TIMEOUT_MS = 5_000;

export interface ResultProfessor {
  id: string;
  name: string;
  isActive: boolean;
  status: VerificationStatus;
  origin: RelationshipOrigin;
  /** The link satisfies the link scope's statuses / origins / decision dates (§24.5). */
  qualifying: boolean;
  /** One of the selected professors (SELECTED mode). */
  selected: boolean;
}

export interface ResultRow {
  id: string;
  title: string;
  year: number | null;
  typeFamily: string;
  venue: string | null;
  authorNamesDisplay: string | null;
  doi: string | null;
  sources: PublicationSource[];
  /** Scopus citation with attribution links; null = no count; absent while Scopus data is unavailable (D6). */
  scopusCitation?: ScopusCitation | null;
  /**
   * Why a row has (or lacks) a count (#157); absent while Scopus data is unavailable (D6):
   *   COUNTED       an observation exists (its count may be 0 — shown as "0 citations")
   *   NO_COUNT_YET  a Scopus source record exists but has no observation ("No Scopus count yet")
   *   NOT_IN_SCOPUS no Scopus source record ("Not in Scopus")
   */
  scopusCitationState?: ScopusCitationState;
  /** Administrator only. */
  status?: string;
  isCurated?: boolean;
  professors?: ResultProfessor[];
}

export type ScopusCitationState = 'COUNTED' | 'NO_COUNT_YET' | 'NOT_IN_SCOPUS';

/**
 * Coverage of the matching set (#157): `withCount + withoutCount = total`, and the publications
 * without a count split into `notInScopus` (no Scopus source record) and `noCountYet` (a Scopus
 * record without an observation): `notInScopus + noCountYet = withoutCount`.
 */
export interface CitationCoverage {
  withCount: number;
  withoutCount: number;
  notInScopus: number;
  noCountYet: number;
}

export type CitationSummary =
  | { available: false }
  | {
      available: true;
      /** The observation date behind the selected count of each match, newest among them (not the newest observation of any record). */
      latestObservation: Date | null;
      coverage: CitationCoverage;
    };

export interface SearchResult {
  publications: ResultRow[];
  total: number;
  limit: number;
  offset: number;
  sort: (typeof SORT_KEYS)[number];
  citations: CitationSummary;
  /** Fingerprint of the complete matching set (`matchingSetFingerprint`); no IDs are disclosed. */
  fingerprint: string;
}

export async function searchPublications(
  context: QueryContext,
  body: unknown,
  client: PrismaClient = defaultClient,
  /** Tests only: a shorter statement timeout, to exercise the timeout path without waiting 5 s. */
  options: { statementTimeoutMs?: number } = {},
): Promise<SearchResult> {
  const query: ProfessorQuery | AdminQuery = context.role === 'ADMIN' ? parseQuery('ADMIN', body) : parseQuery('PROFESSOR', body);
  return inQueryTransaction(client, options.statementTimeoutMs, async (tx) => {
    const { where, available, citations, link } = await matchingFilter(tx, context, query);

    // Every matching ID (one query, in place of a count): the total, the fingerprint and, for the
    // citation sort, the order all come from it.
    const ids = (await tx.publication.findMany({ where, select: { id: true } })).map((p) => p.id);
    const total = ids.length;
    let pageIds: string[];
    if (query.sort === 'scopusCitations') {
      ids.sort((a, b) => compareByCitations(citations!, a, b));
      pageIds = ids.slice(query.offset, query.offset + query.limit);
    } else {
      pageIds = (await tx.publication.findMany({ where, select: { id: true }, orderBy: ORDER[query.sort], skip: query.offset, take: query.limit })).map((p) => p.id);
    }

    const rows = await loadRows(tx, context, link, pageIds, available);
    return {
      publications: rows,
      total,
      limit: query.limit,
      offset: query.offset,
      sort: query.sort,
      citations: available ? await coverage(tx, where, citations!, total) : { available: false },
      fingerprint: matchingSetFingerprint(ids),
    };
  });
}

/**
 * A deterministic fingerprint of a matching set: SHA-256 of its publication IDs, sorted, so it
 * depends only on which publications match (not on order, paging or sorting). The search and the
 * conditional analytics both return it, so a client can tell whether they describe the same set
 * without receiving any ID (stage Q4 review, decision #163).
 */
export function matchingSetFingerprint(ids: readonly string[]): string {
  return createHash('sha256').update([...ids].sort().join('\n')).digest('hex');
}

/**
 * Runs `work` in one read-only REPEATABLE READ transaction with the per-query statement timeout
 * (§24.9). Under PostgreSQL's default READ COMMITTED every statement would take a new snapshot;
 * REPEATABLE READ gives the whole request one snapshot, so all its figures describe the same data
 * (read-only REPEATABLE READ transactions never fail with serialization errors). A PostgreSQL
 * statement timeout becomes 503 QUERY_TIMEOUT. Shared by the professor and administrator searches
 * and the conditional analytics.
 */
export async function inQueryTransaction<T>(client: PrismaClient, statementTimeoutMs: number | undefined, work: (tx: Tx) => Promise<T>): Promise<T> {
  const timeoutMs = Math.max(1, Math.floor(statementTimeoutMs ?? STATEMENT_TIMEOUT_MS));
  try {
    return await client.$transaction(
      async (tx) => {
        await tx.$executeRaw`SET TRANSACTION READ ONLY`;
        await tx.$executeRawUnsafe(`SET LOCAL statement_timeout = ${timeoutMs}`);
        return work(tx);
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead, timeout: Math.max(timeoutMs, STATEMENT_TIMEOUT_MS) * 3, maxWait: 5_000 },
    );
  } catch (error) {
    if (error instanceof HttpError) throw error;
    if (error instanceof Error && /statement timeout|57014/.test(error.message)) {
      throw new HttpError(503, 'QUERY_TIMEOUT', 'The query took too long; narrow it down and try again');
    }
    throw error;
  }
}

/**
 * The publications a validated query matches, as one filter: the server-built scope (professor
 * scope, or the administrator's link scope) ANDed with the compiled condition tree (§24.3–§24.5).
 * Refuses any citation condition or the citation sort while no Scopus data exists (D6). The search
 * and the conditional analytics use this one definition, so they describe the same set.
 */
export async function matchingFilter(tx: Tx, context: QueryContext, query: ProfessorQuery | AdminQuery) {
  const conditions = conditionsOf(query.root);
  const usesCitations = query.sort === 'scopusCitations' || conditions.some((c) => CITATION_FIELDS.has(c.field));
  const link = context.role === 'ADMIN' ? (query as AdminQuery).link : null;
  const available = await scopusDataAvailable(tx);
  if (usesCitations && !available) {
    throw new HttpError(409, 'CITATION_DATA_UNAVAILABLE', 'Scopus citation data is unavailable, so citation filters and sorting cannot be used');
  }
  const scope = context.role === 'PROFESSOR' ? professorScope(context.professorId) : await adminLinkScope(link!, tx);
  const citations = available ? await scopusCounts(tx) : undefined;
  const linkedCounts = conditions.some((c) => c.field === 'linkedProfessors') ? await qualifyingLinkCounts(tx, link!) : undefined;
  const where: Prisma.PublicationWhereInput = { AND: [scope, compileTree(query.root, { citations, linkedCounts })] };
  return { where, available, citations, link };
}

/** Sort orders with `id` as the final tie-breaker, so paging is stable (§24.7). */
const ORDER: Record<Exclude<(typeof SORT_KEYS)[number], 'scopusCitations'>, Prisma.PublicationOrderByWithRelationInput[]> = {
  year: [{ year: { sort: 'desc', nulls: 'last' } }, { id: 'asc' }],
  title: [{ normalizedTitle: 'asc' }, { id: 'asc' }],
  addedOn: [{ createdAt: 'desc' }, { id: 'asc' }],
};

/** Highest Scopus count first; publications without a count last; then by id. */
function compareByCitations(counts: Map<string, CitationCount>, a: string, b: string): number {
  const x = counts.get(a)?.count;
  const y = counts.get(b)?.count;
  if (x === undefined && y === undefined) return a.localeCompare(b);
  if (x === undefined) return 1;
  if (y === undefined) return -1;
  return y - x || a.localeCompare(b);
}

/**
 * Coverage of the matching set (§24.4, #157): how many have a Scopus count, how many of the rest
 * have no Scopus record and how many have one without an observation yet, and the latest
 * observation date among the counts used. A count's date is that of the observation supplying it
 * (the latest of the record whose count is the highest), as in `scopusCitations`.
 */
export async function coverage(tx: Tx, where: Prisma.PublicationWhereInput, counts: Map<string, CitationCount>, total: number): Promise<CitationSummary> {
  const counted = await tx.publication.findMany({ where: { AND: [where, { id: { in: [...counts.keys()] } }] }, select: { id: true } });
  // Every publication with a count has a Scopus record, so the rest of those with one have no observation yet.
  const withScopusRecord = await tx.publication.count({ where: { AND: [where, { sourceRecords: { some: { source: 'SCOPUS' } } }] } });
  const latest = counted.reduce<Date | null>((max, p) => {
    const at = counts.get(p.id)!.observedAt;
    return max && max >= at ? max : at;
  }, null);
  const withCount = counted.length;
  return {
    available: true,
    latestObservation: latest,
    coverage: { withCount, withoutCount: total - withCount, notInScopus: total - withScopusRecord, noCountYet: withScopusRecord - withCount },
  };
}

/** A row's citation state (#157). */
function citationState(citation: ScopusCitation | undefined, sources: readonly PublicationSource[]): ScopusCitationState {
  if (citation) return 'COUNTED';
  return sources.includes('SCOPUS') ? 'NO_COUNT_YET' : 'NOT_IN_SCOPUS';
}

/** Professors with a qualifying link, per publication (for `linkedProfessors`, §24.5). */
async function qualifyingLinkCounts(tx: Tx, link: LinkScope): Promise<Map<string, number>> {
  const groups = await tx.professorPublication.groupBy({ by: ['publicationId'], where: qualifyingLink(link), _count: { _all: true }, orderBy: { publicationId: 'asc' } });
  return new Map(groups.map((g) => [g.publicationId, (g._count as { _all: number })._all]));
}

function isQualifying(link: LinkScope, rel: { status: VerificationStatus; origin: RelationshipOrigin; decidedAt: Date | null }): boolean {
  if (!link.statuses.includes(rel.status)) return false;
  if (link.origins && !link.origins.includes(rel.origin)) return false;
  if (link.decidedOn) {
    if (!rel.decidedAt) return false;
    const day = utcDay(rel.decidedAt); // same UTC-day rule as the database filter (dates.ts)
    if (link.decidedOn.after && day <= link.decidedOn.after) return false;
    if (link.decidedOn.before && day >= link.decidedOn.before) return false;
  }
  return true;
}

/** The page's rows in page order. Professors' rows never carry other professors' relationships (D10). */
async function loadRows(tx: Tx, context: QueryContext, link: LinkScope | null, ids: string[], available: boolean): Promise<ResultRow[]> {
  if (ids.length === 0) return [];
  const admin = context.role === 'ADMIN';
  const rows = await tx.publication.findMany({
    where: { id: { in: ids } },
    select: {
      id: true,
      title: true,
      year: true,
      typeFamily: true,
      venue: true,
      authorNamesDisplay: true,
      doi: true,
      status: true,
      isCurated: true,
      sourceRecords: { select: { source: true } },
    },
  });
  // Administrator only: every relationship of the page's publications, with its professor.
  const relationships = admin
    ? await tx.professorPublication.findMany({
        where: { publicationId: { in: ids } },
        select: { publicationId: true, status: true, origin: true, decidedAt: true, professor: { select: { id: true, name: true, isActive: true } } },
      })
    : [];
  const citations = available ? await scopusCitations(ids, tx) : null;
  const selected = new Set(link?.professors ?? []);
  const byId = new Map(rows.map((r) => [r.id, r]));
  return ids.map((id) => {
    const r = byId.get(id)!;
    const row: ResultRow = {
      id: r.id,
      title: r.title,
      year: r.year,
      typeFamily: r.typeFamily,
      venue: r.venue,
      authorNamesDisplay: r.authorNamesDisplay,
      doi: r.doi,
      sources: orderedSources(r.sourceRecords),
      ...(citations && {
        scopusCitation: citations.get(id) ?? null,
        scopusCitationState: citationState(citations.get(id), r.sourceRecords.map((s) => s.source)),
      }),
    };
    if (admin) {
      row.status = r.status;
      row.isCurated = r.isCurated;
      row.professors = relationships
        .filter((rel) => rel.publicationId === id)
        .map((rel) => ({
          id: rel.professor.id,
          name: rel.professor.name,
          isActive: rel.professor.isActive,
          status: rel.status,
          origin: rel.origin,
          qualifying: isQualifying(link!, rel),
          selected: selected.has(rel.professor.id),
        }))
        .sort((a, b) => Number(b.selected) - Number(a.selected) || a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
    }
    return row;
  });
}

/** The query builder's description for a role (§24.8 `GET …/fields`): fields, link scope, sorts, limits and data availability. */
export async function queryFields(context: QueryContext, client: PrismaClient = defaultClient) {
  const available = await client.$transaction((tx) => scopusDataAvailable(tx));
  const role: Role = context.role;
  return {
    fields: describeFields(role, available),
    scopus: { available },
    sorts: SORT_KEYS.map((key) => ({ key, available: key !== 'scopusCitations' || available })),
    limits: { conditions: LIMITS.conditions, depth: LIMITS.depth, groupChildren: LIMITS.groupChildren, pageDefault: LIMITS.pageDefault, pageMax: LIMITS.pageMax },
    ...(role === 'ADMIN' && {
      link: {
        modes: LINK_MODES,
        statuses: ['APPROVED', 'PENDING', 'REJECTED'],
        origins: ['DISCOVERED', 'MANUAL', 'ADMIN'],
        maxProfessors: LIMITS.professors,
      },
    }),
  };
}
