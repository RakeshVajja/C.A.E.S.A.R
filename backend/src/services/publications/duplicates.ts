import { DuplicateCandidateStatus, Prisma, PrismaClient, VerificationStatus } from '@prisma/client';
import { prisma as defaultClient } from '../../config/database';
import { HttpError } from '../../utils/httpError';
import { recomputeCanonical, Tx } from '../matching/engine';
import { serializeByTitle } from '../matching/titleSerialization';
import { SyncService } from '../sync/syncService';
import { getPublication, toSummary } from './adminPublications';

/**
 * Duplicate-candidate resolution by professors (Project_plan.md §8.5; decisions #93, #96, #149–#151)
 * and source-record detachment by the administrator (§15.1; #94).
 *
 *   list     the OPEN candidates in which either publication has a relationship with the professor
 *            (any status; shared, suppressed and mismatched-status publications included).
 *   dismiss  OPEN → DISMISSED; both publications stay.
 *   merge    B into A in one transaction: source records and every professor's relationships move
 *            to A (one relationship per professor: APPROVED > PENDING > REJECTED), B's other open
 *            candidates are re-pointed to A, B is removed, A keeps its own status and is recomputed
 *            field by field. Moved records keep their match_method and match_detail; a merge note
 *            is appended to match_detail (#151). Any publication statuses may be merged (#150).
 *   detach   (administrator) a wrongly attached source record moves to its own new publication.
 *
 * Candidates are resolved only by a professor linked to either publication; the scope is checked
 * again inside the resolving transaction, and a candidate outside it is 404 (never disclosed). The
 * first resolution wins: the candidate is claimed while OPEN, so a concurrent or later attempt is
 * refused with CANDIDATE_NOT_OPEN and changes nothing. resolved_by_user_id / resolved_at record the
 * professor's user and the time.
 *
 * Merge and detach run through `SyncService.exclusive` (#91): refused with 409 while a
 * synchronization run executes, and a run cannot start before they have finished. A merge also
 * holds the per-title serialization of manual entries for every normalized title of both
 * publications (#96), so a manual entry matching either one by title runs entirely before or after it.
 */

export const CANDIDATE_DEFAULT_LIMIT = 50;
export const CANDIDATE_MAX_LIMIT = 200;

const candidateNotFound = () => new HttpError(404, 'CANDIDATE_NOT_FOUND', 'Duplicate candidate not found');
const recordNotFound = () => new HttpError(404, 'SOURCE_RECORD_NOT_FOUND', 'Source record not found');

const notOpen = (status: DuplicateCandidateStatus) =>
  new HttpError(409, 'CANDIDATE_NOT_OPEN', `The duplicate candidate is already ${status}`, { currentStatus: status });

const publicationSummary = {
  select: {
    id: true,
    title: true,
    year: true,
    venue: true,
    typeFamily: true,
    authorNamesDisplay: true,
    doi: true,
    status: true,
    isCurated: true,
    createdAt: true,
    updatedAt: true,
    sourceRecords: { select: { source: true } },
    professors: { select: { status: true, professorId: true } },
  },
} as const;

const candidateSelect = {
  id: true,
  reason: true,
  status: true,
  resolvedAt: true,
  createdAt: true,
  publicationA: publicationSummary,
  publicationB: publicationSummary,
} satisfies Prisma.DuplicateCandidateSelect;

type CandidateRow = Prisma.DuplicateCandidateGetPayload<{ select: typeof candidateSelect }>;

/** A candidate as the professor sees it: each side with the professor's own relationship status (null if none). */
function toCandidate(row: CandidateRow, professorId: string) {
  const side = (publication: CandidateRow['publicationA']) =>
    publication && { ...toSummary(publication), myRelationshipStatus: publication.professors.find((r) => r.professorId === professorId)?.status ?? null };
  return {
    id: row.id,
    reason: row.reason,
    status: row.status,
    resolvedAt: row.resolvedAt,
    createdAt: row.createdAt,
    // A side is null only when that publication was removed (§6.10).
    publicationA: side(row.publicationA),
    publicationB: side(row.publicationB),
  };
}

/** Candidates in which either publication has a relationship (any status) with the professor (#149). */
const linkedTo = (professorId: string): Prisma.DuplicateCandidateWhereInput => ({
  OR: [{ publicationA: { professors: { some: { professorId } } } }, { publicationB: { professors: { some: { professorId } } } }],
});

/** The professor's OPEN candidates, oldest first. */
export async function listCandidates(professorId: string, query: { limit: number; offset: number }, client: PrismaClient = defaultClient) {
  const where: Prisma.DuplicateCandidateWhereInput = { status: 'OPEN', ...linkedTo(professorId) };
  const [rows, total] = await client.$transaction([
    client.duplicateCandidate.findMany({
      where,
      select: candidateSelect,
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: query.limit,
      skip: query.offset,
    }),
    client.duplicateCandidate.count({ where }),
  ]);
  return { candidates: rows.map((row) => toCandidate(row, professorId)), total, limit: query.limit, offset: query.offset };
}

async function readCandidate(id: string, professorId: string, client: PrismaClient | Tx) {
  return toCandidate(await client.duplicateCandidate.findUniqueOrThrow({ where: { id }, select: candidateSelect }), professorId);
}

/** Whether the professor has a relationship (any status) with either of the publications. */
async function isLinked(db: PrismaClient | Tx, professorId: string, publicationIds: readonly (string | null)[]): Promise<boolean> {
  const ids = publicationIds.filter((x): x is string => !!x);
  return ids.length > 0 && (await db.professorPublication.count({ where: { professorId, publicationId: { in: ids } } })) > 0;
}

/**
 * OPEN → DISMISSED with the professor's user and time. The conditional update claims the candidate
 * only while it is OPEN and linked to the professor, so a concurrent resolution wins exactly once.
 */
export async function dismissCandidate(id: string, professorId: string, userId: string, now: Date, client: PrismaClient = defaultClient) {
  const { count } = await client.duplicateCandidate.updateMany({
    where: { id, status: 'OPEN', ...linkedTo(professorId) },
    data: { status: 'DISMISSED', resolvedByUserId: userId, resolvedAt: now },
  });
  if (count === 0) {
    const current = await client.duplicateCandidate.findUnique({ where: { id }, select: { status: true, publicationAId: true, publicationBId: true } });
    if (!current || !(await isLinked(client, professorId, [current.publicationAId, current.publicationBId]))) throw candidateNotFound();
    throw notOpen(current.status);
  }
  return { candidate: await readCandidate(id, professorId, client) };
}

const RANK: Record<VerificationStatus, number> = { APPROVED: 3, PENDING: 2, REJECTED: 1 };

interface LockedRelationship {
  id: string;
  professor_id: string;
  publication_id: string;
  status: VerificationStatus;
}

/**
 * Merges the candidate's other publication into `keepPublicationId`, chosen by the professor (§8.5;
 * #93, #149–#151). Everything happens in one transaction; any failure leaves all rows unchanged.
 */
export async function mergeCandidate(
  id: string,
  keepPublicationId: string,
  professorId: string,
  userId: string,
  deps: { sync: SyncService; now: () => Date; client?: PrismaClient },
) {
  const client = deps.client ?? defaultClient;
  return deps.sync.exclusive(async () => {
    // The titles a manual entry could match either publication by (§8.1 rule 3 compares the
    // canonical and the source-record normalized titles). An unknown or resolved candidate locks
    // nothing and is refused inside the transaction.
    const pair = await client.duplicateCandidate.findUnique({ where: { id }, select: { publicationAId: true, publicationBId: true } });
    const lockedTitles = await titlesOf(client, [pair?.publicationAId, pair?.publicationBId]);
    const result = await withTitles(lockedTitles, () => client.$transaction(async (tx) => {
      const now = deps.now();
      // Claiming the candidate first also serializes concurrent resolutions of it.
      const claimed = await tx.duplicateCandidate.updateMany({
        where: { id, status: 'OPEN' },
        data: { status: 'MERGED', resolvedByUserId: userId, resolvedAt: now },
      });
      const candidate = await tx.duplicateCandidate.findUnique({ where: { id } });
      if (!candidate) throw candidateNotFound();
      // Outside the professor's scope the candidate is not disclosed, whatever its status.
      if (!(await isLinked(tx, professorId, [candidate.publicationAId, candidate.publicationBId]))) throw candidateNotFound();
      if (claimed.count === 0) throw notOpen(candidate.status);
      const { publicationAId: a, publicationBId: b } = candidate;
      if (!a || !b) {
        throw new HttpError(409, 'CANDIDATE_INCOMPLETE', 'One publication of this candidate no longer exists; dismiss it instead');
      }
      if (keepPublicationId !== a && keepPublicationId !== b) {
        throw new HttpError(400, 'INVALID_KEEP_PUBLICATION', 'keepPublicationId must be one of the candidate’s two publications');
      }
      const keep = keepPublicationId;
      const remove = keep === a ? b : a;

      // Row locks (in id order): concurrent writes referencing either publication wait for this merge.
      // Publications of any status may be merged; the kept one keeps its own status (#150).
      const locked = await tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM publications WHERE id = ANY(${[a, b]}::uuid[]) ORDER BY id FOR UPDATE`;
      if (locked.length !== 2) throw new HttpError(404, 'PUBLICATION_NOT_FOUND', 'Publication not found');
      // Revalidation under the row locks: a title that appeared after the locks were chosen (an
      // edit, or a record attached by DOI meanwhile) is not protected, so the merge is refused.
      if ((await titlesOf(tx, [a, b])).some((title) => !lockedTitles.includes(title))) {
        throw new HttpError(409, 'MERGE_CONFLICT', 'The publications changed while the merge was being prepared; try again');
      }

      // Both publications' relationships, locked: the professor must still be linked to either one
      // (authoritative scope check; a relationship removed meanwhile makes the candidate 404).
      const relationships = await tx.$queryRaw<LockedRelationship[]>`
        SELECT id, professor_id, publication_id, status::text AS status FROM professor_publications
        WHERE publication_id = ANY(${[keep, remove]}::uuid[]) ORDER BY id FOR UPDATE`;
      if (!relationships.some((r) => r.professor_id === professorId)) throw candidateNotFound();

      // 1. Source records move to the surviving publication. Their attachment provenance is kept:
      //    match_method unchanged, match_detail kept in full with a merge note appended (#151) — the
      //    note is the record's only link to the merge once the candidate's reference becomes NULL.
      //    Who resolved the candidate is recorded on the candidate, not here.
      const records = await tx.publicationSourceRecord.findMany({
        where: { publicationId: remove },
        select: { id: true, matchDetail: true },
      });
      for (const record of records) {
        await tx.publicationSourceRecord.update({
          where: { id: record.id },
          data: { publicationId: keep, matchDetail: withMergeNote(record.matchDetail, id, remove) },
        });
      }

      // 2. Relationships: one per professor, APPROVED > PENDING > REJECTED; a tie keeps the
      //    surviving publication's relationship. The winning row is kept with its decision metadata.
      let relationshipsMoved = 0;
      let relationshipsRemoved = 0;
      for (const moving of relationships.filter((r) => r.publication_id === remove)) {
        const staying = relationships.find((r) => r.publication_id === keep && r.professor_id === moving.professor_id);
        if (staying && RANK[staying.status] >= RANK[moving.status]) {
          await tx.professorPublication.delete({ where: { id: moving.id } });
        } else {
          if (staying) await tx.professorPublication.delete({ where: { id: staying.id } });
          await tx.professorPublication.update({ where: { id: moving.id }, data: { publicationId: keep } });
          relationshipsMoved++;
        }
        if (staying) relationshipsRemoved++;
      }

      // 3. Other OPEN candidates of the removed publication are re-pointed to the survivor. When the
      //    survivor already has that pair (in any status, so a dismissed pair is never reopened), the
      //    redundant one is closed as DISMISSED with a note. Resolved candidates keep their history
      //    (their reference becomes NULL when the publication is removed, §6.10).
      const others = await tx.duplicateCandidate.findMany({
        where: { id: { not: id }, status: 'OPEN', OR: [{ publicationAId: remove }, { publicationBId: remove }] },
        orderBy: { id: 'asc' },
      });
      let candidatesRepointed = 0;
      let candidatesClosed = 0;
      for (const other of others) {
        const partner = other.publicationAId === remove ? other.publicationBId : other.publicationAId;
        const pair = partner && partner !== keep ? (keep < partner ? [keep, partner] : [partner, keep]) : null;
        const existing =
          pair &&
          (await tx.duplicateCandidate.findUnique({
            where: { publicationAId_publicationBId: { publicationAId: pair[0], publicationBId: pair[1] } },
            select: { id: true },
          }));
        if (pair && !existing) {
          await tx.duplicateCandidate.update({ where: { id: other.id }, data: { publicationAId: pair[0], publicationBId: pair[1] } });
          candidatesRepointed++;
        } else {
          await tx.duplicateCandidate.update({
            where: { id: other.id },
            data: {
              status: 'DISMISSED',
              resolvedByUserId: userId,
              resolvedAt: now,
              reason: `${other.reason} [closed when publication ${remove} was merged into ${keep}: the pair already exists]`,
            },
          });
          candidatesClosed++;
        }
      }

      // 4. Remove the merged-away publication, then recompute the survivor (skipped when curated).
      await tx.publication.delete({ where: { id: remove } });
      await recomputeCanonical(tx, keep);

      return {
        removedPublicationId: remove,
        sourceRecordsMoved: records.length,
        relationshipsMoved,
        relationshipsRemoved,
        candidatesRepointed,
        candidatesClosed,
      };
    }));
    return { candidate: await readCandidate(id, professorId, client), merge: result };
  });
}

/** match_detail after a merge: the original text in full, then the merge reference (#151). */
export function withMergeNote(matchDetail: string | null, candidateId: string, fromPublicationId: string): string {
  const note = `moved by duplicate candidate ${candidateId} from publication ${fromPublicationId}`;
  return matchDetail ? `${matchDetail}; ${note}` : note.charAt(0).toUpperCase() + note.slice(1);
}

/** Distinct normalized titles of the publications and their source records, sorted. */
async function titlesOf(db: PrismaClient | Tx, ids: readonly (string | null | undefined)[]): Promise<string[]> {
  const present = ids.filter((x): x is string => !!x);
  if (present.length === 0) return [];
  const [publications, records] = await Promise.all([
    db.publication.findMany({ where: { id: { in: present } }, select: { normalizedTitle: true } }),
    db.publicationSourceRecord.findMany({ where: { publicationId: { in: present } }, select: { normalizedTitle: true } }),
  ]);
  return [...new Set([...publications, ...records].map((r) => r.normalizedTitle))].sort();
}

/**
 * Runs `operation` holding the per-title serialization for every title, acquired in sorted order.
 * Only merges hold several titles, and merges are serialized by `SyncService.exclusive`, so the
 * fixed order cannot deadlock with the single-title holders (manual entries, sync ingestion).
 */
function withTitles<T>(titles: readonly string[], operation: () => Promise<T>): Promise<T> {
  return titles.reduceRight<() => Promise<T>>((inner, title) => () => serializeByTitle(title, inner), operation)();
}

/**
 * Moves a wrongly attached source record to its own new publication (§8.5, #94). The new
 * publication is ACTIVE, gets its canonical metadata from the record, and has no relationships
 * (a later synchronization links the discovering professor as PENDING). Refused for the only
 * record of a publication (409 LAST_SOURCE_RECORD).
 */
export async function detachSourceRecord(
  recordId: string,
  deps: { sync: SyncService; client?: PrismaClient },
) {
  const client = deps.client ?? defaultClient;
  return deps.sync.exclusive(async () => {
    const moved = await client.$transaction(async (tx) => {
      const record = await tx.publicationSourceRecord.findUnique({ where: { id: recordId } });
      if (!record) throw recordNotFound();
      // Lock the publication so concurrent attachments and detachments see a stable record count.
      await tx.$queryRaw`SELECT id FROM publications WHERE id = ${record.publicationId}::uuid FOR UPDATE`;
      const current = await tx.publicationSourceRecord.findUnique({ where: { id: recordId }, select: { publicationId: true } });
      if (!current) throw recordNotFound();
      const from = current.publicationId;
      if ((await tx.publicationSourceRecord.count({ where: { publicationId: from } })) < 2) {
        throw new HttpError(409, 'LAST_SOURCE_RECORD', 'The only source record of a publication cannot be detached');
      }

      const created = await tx.publication.create({
        data: {
          title: record.title,
          normalizedTitle: record.normalizedTitle,
          year: record.year,
          venue: record.venue,
          typeFamily: record.typeFamily,
          authorNamesDisplay: record.authorNamesDisplay,
        },
      });
      await tx.publicationSourceRecord.update({
        where: { id: recordId },
        data: {
          publicationId: created.id,
          matchMethod: 'ADMIN',
          matchDetail: `Detached by the administrator from publication ${from}`,
        },
      });
      // The old publication first, so a DOI only this record carried is released for the new one.
      await recomputeCanonical(tx, from);
      await recomputeCanonical(tx, created.id);
      return { from, to: created.id };
    });
    return {
      publication: await getPublication(moved.to, client),
      previousPublication: await getPublication(moved.from, client),
    };
  });
}
