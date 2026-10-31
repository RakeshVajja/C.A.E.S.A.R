import { Prisma, PrismaClient, PublicationSource, VerificationStatus } from '@prisma/client';
import { prisma as defaultClient } from '../../config/database';
import { HttpError } from '../../utils/httpError';
import { scopusCitations, type ScopusCitation } from '../citations/scopusCitations';
import { SOURCE_PRIORITY } from '../matching/canonical';

/**
 * Professor verification of discovered publications (Project_plan.md §11, Phase 10; decisions
 * #72–#76). Decisions apply to one ProfessorPublication relationship, never to the publication.
 *
 *   PENDING → APPROVED | REJECTED,  APPROVED ⇄ REJECTED;  never back to PENDING.
 *
 * The professor is always the signed-in user's own professor record (resolved by the caller from
 * the session). Every decision is one conditional UPDATE on (relationship, owner, expected status),
 * so concurrent or stale decisions cannot silently overwrite each other. Relationships to
 * SUPPRESSED publications are hidden: not listed, not counted, not decidable.
 */

export type Decision = 'APPROVED' | 'REJECTED';

export const LIST_DEFAULT_LIMIT = 50;
export const LIST_MAX_LIMIT = 200;
export const BULK_APPROVE_MAX = 500;

/** Every source of a publication, in canonical priority order (Scopus and Web of Science included). */
const SOURCE_ORDER: readonly PublicationSource[] = SOURCE_PRIORITY;

/** Relationships the professor may see: their own, to a visible (ACTIVE) publication. */
function visible(professorId: string): Prisma.ProfessorPublicationWhereInput {
  return { professorId, publication: { status: 'ACTIVE' } };
}

const itemSelect = {
  id: true,
  status: true,
  origin: true,
  decidedAt: true,
  createdAt: true,
  publication: {
    select: {
      id: true,
      title: true,
      year: true,
      venue: true,
      typeFamily: true,
      doi: true,
      authorNamesDisplay: true,
      sourceRecords: { select: { source: true } },
    },
  },
} satisfies Prisma.ProfessorPublicationSelect;

type ItemRow = Prisma.ProfessorPublicationGetPayload<{ select: typeof itemSelect }>;

/**
 * The response item: relationship fields plus public publication fields (decision #76), and the
 * publication's Scopus citation count with its attribution links (#112; no other provider's count).
 */
function toItem(row: ItemRow, citations: Map<string, ScopusCitation>) {
  const { sourceRecords, ...publication } = row.publication;
  const present = new Set(sourceRecords.map((r) => r.source));
  return {
    id: row.id,
    status: row.status,
    origin: row.origin,
    decidedAt: row.decidedAt,
    createdAt: row.createdAt,
    publication: { ...publication, sources: SOURCE_ORDER.filter((s) => present.has(s)), scopusCitation: citations.get(publication.id) ?? null },
  };
}

const notFound = () => new HttpError(404, 'RELATIONSHIP_NOT_FOUND', 'Publication relationship not found');

/** One relationship in the professor-facing item shape (also used for manual entries, Phase 11). */
export async function readItem(relationshipId: string, client: PrismaClient = defaultClient) {
  const row = await client.professorPublication.findUniqueOrThrow({ where: { id: relationshipId }, select: itemSelect });
  return toItem(row, await scopusCitations([row.publication.id], client));
}

/**
 * One page of the professor's visible relationships. Order: PENDING first, then APPROVED, then
 * REJECTED; within a status, newest publication year first (unknown years last), then title, then
 * relationship id. `total` counts the visible relationships matching the filter (for paging);
 * `counts` are per status over all visible relationships, regardless of the filter.
 */
export async function listOwnPublications(
  professorId: string,
  query: { status?: VerificationStatus; limit: number; offset: number },
  client: PrismaClient = defaultClient,
) {
  const where: Prisma.ProfessorPublicationWhereInput = { ...visible(professorId), ...(query.status && { status: query.status }) };
  const [rows, total, grouped] = await client.$transaction([
    client.professorPublication.findMany({
      where,
      select: itemSelect,
      orderBy: [
        { status: 'asc' }, // enum order: PENDING, APPROVED, REJECTED
        { publication: { year: { sort: 'desc', nulls: 'last' } } },
        { publication: { title: 'asc' } },
        { id: 'asc' },
      ],
      take: query.limit,
      skip: query.offset,
    }),
    client.professorPublication.count({ where }),
    client.professorPublication.groupBy({ by: ['status'], where: visible(professorId), _count: { _all: true }, orderBy: { status: 'asc' } }),
  ]);
  const counts: Record<VerificationStatus, number> = { PENDING: 0, APPROVED: 0, REJECTED: 0 };
  for (const group of grouped) counts[group.status] = (group._count as { _all: number })._all;
  const citations = await scopusCitations(rows.map((row) => row.publication.id), client);
  return { items: rows.map((row) => toItem(row, citations)), total, limit: query.limit, offset: query.offset, counts };
}

/**
 * Applies one decision with optimistic concurrency (decision #72): the relationship must be the
 * professor's, visible, and currently `expected`. Outcomes:
 *   404 RELATIONSHIP_NOT_FOUND — missing, another professor's, or its publication is suppressed;
 *   409 STATUS_CONFLICT       — the current status is not `expected` (stale or concurrent change);
 *   409 INVALID_TRANSITION    — `status` equals the current status (decision #73).
 */
export async function decide(
  professorId: string,
  userId: string,
  relationshipId: string,
  status: Decision,
  expected: VerificationStatus,
  now: Date,
  client: PrismaClient = defaultClient,
) {
  // Every allowed transition changes the status, and none returns to PENDING (`status` is
  // APPROVED or REJECTED): PENDING→APPROVED/REJECTED, APPROVED→REJECTED, REJECTED→APPROVED.
  const attempted = status !== expected;
  if (attempted) {
    const { count } = await client.professorPublication.updateMany({
      where: { ...visible(professorId), id: relationshipId, status: expected },
      data: { status, decidedAt: now, decidedByUserId: userId },
    });
    if (count === 1) {
      return readItem(relationshipId, client);
    }
  }

  const current = await client.professorPublication.findFirst({
    where: { ...visible(professorId), id: relationshipId },
    select: { status: true },
  });
  if (!current) throw notFound();
  // A valid transition whose compare-and-set did not match lost to a concurrent or earlier change —
  // even if a later change has since restored the expected status before this lookup.
  if (attempted || current.status !== expected) {
    throw new HttpError(409, 'STATUS_CONFLICT', 'The relationship was changed meanwhile; reload and decide again', {
      currentStatus: current.status,
    });
  }
  throw new HttpError(409, 'INVALID_TRANSITION', `The relationship is already ${current.status}`, { currentStatus: current.status });
}

/**
 * Approves the given relationships that are the professor's, visible and PENDING, in one
 * conditional UPDATE (decision #74). Other IDs — not found, another professor's, not PENDING,
 * suppressed — are counted as skipped without saying which. Concurrent identical requests
 * approve each relationship once.
 */
export async function bulkApprove(
  professorId: string,
  userId: string,
  relationshipIds: readonly string[],
  now: Date,
  client: PrismaClient = defaultClient,
) {
  const { count } = await client.professorPublication.updateMany({
    where: { ...visible(professorId), id: { in: [...relationshipIds] }, status: 'PENDING' },
    data: { status: 'APPROVED', decidedAt: now, decidedByUserId: userId },
  });
  return { approved: count, skipped: relationshipIds.length - count };
}
