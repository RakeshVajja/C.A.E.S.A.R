import { Prisma, PrismaClient } from '@prisma/client';
import { prisma as defaultClient } from '../../config/database';
import { HttpError } from '../../utils/httpError';
import type { SyncService } from '../sync/syncService';

/**
 * Permanent deletion of an inactive professor's record (decision #170, an owner-approved
 * resolution of the deferred "hard deletion of professors", Project_plan.md §20). Irreversible.
 *
 * Preconditions: the professor exists, is INACTIVE (deactivate first), and the administrator has
 * typed the professor's exact name. Refused while a synchronization run is in progress — the whole
 * operation runs under the engine's exclusive guard, so no run can start until it has finished.
 *
 * In one transaction:
 *   1. lock the professor and every publication linked to them (FOR UPDATE), so a concurrent link to
 *      one of those publications waits and then fails instead of leaving it half deleted;
 *   2. sole-owner publications — linked to this professor only (no other professor has a
 *      relationship of any status) — are deleted with their source records (citation observations
 *      cascade); OPEN duplicate candidates involving them are closed as DISMISSED with a note (their
 *      publication references become NULL, as after provider-data removal);
 *   3. every relationship of the professor (any status), their external identities (sync-task
 *      references become NULL) and the professor are deleted, then their login account (audit
 *      references to that user become NULL).
 * Publications shared with another professor stay, with the other professors' relationships and
 * decisions untouched. Nothing is kept about the deleted professor (no audit table, §6).
 */

export interface DeletionResult {
  professor: { id: string; name: string };
  account: boolean;
  identities: number;
  relationships: number;
  publications: number;
  sourceRecords: number;
  candidatesClosed: number;
}

const notFound = () => new HttpError(404, 'PROFESSOR_NOT_FOUND', 'Professor not found');

export async function deleteProfessor(
  professorId: string,
  confirmName: string,
  deps: { sync: SyncService; now: () => Date; actorUserId: string; client?: PrismaClient },
): Promise<DeletionResult> {
  const client = deps.client ?? defaultClient;
  return deps.sync.exclusive(() =>
    client.$transaction(
      async (tx) => {
        const [locked] = await tx.$queryRaw<{ id: string; name: string; is_active: boolean; user_id: string | null }[]>(
          Prisma.sql`SELECT id, name, is_active, user_id FROM professors WHERE id = ${professorId}::uuid FOR UPDATE`,
        );
        if (!locked) throw notFound();
        if (locked.is_active) throw new HttpError(409, 'PROFESSOR_ACTIVE', 'Deactivate the professor before deleting their record');
        if (confirmName.trim() !== locked.name.trim()) {
          throw new HttpError(400, 'CONFIRMATION_MISMATCH', "Type the professor's name exactly to confirm the deletion");
        }

        const linkedIds = (await tx.professorPublication.findMany({ where: { professorId }, select: { publicationId: true } })).map((l) => l.publicationId);
        if (linkedIds.length > 0) {
          await tx.$queryRaw(Prisma.sql`SELECT id FROM publications WHERE id = ANY(${linkedIds}::uuid[]) FOR UPDATE`);
        }
        const shared = new Set(
          (
            await tx.professorPublication.findMany({
              where: { publicationId: { in: linkedIds }, professorId: { not: professorId } },
              select: { publicationId: true },
            })
          ).map((l) => l.publicationId),
        );
        const soleIds = linkedIds.filter((id) => !shared.has(id));

        // OPEN candidates that would lose a publication cannot be resolved any more: close them.
        const open = await tx.duplicateCandidate.findMany({
          where: { status: 'OPEN', OR: [{ publicationAId: { in: soleIds } }, { publicationBId: { in: soleIds } }] },
          select: { id: true, reason: true },
        });
        for (const candidate of open) {
          await tx.duplicateCandidate.update({
            where: { id: candidate.id },
            data: {
              status: 'DISMISSED',
              resolvedByUserId: deps.actorUserId,
              resolvedAt: deps.now(),
              reason: `${candidate.reason} · Closed: a publication was deleted with its professor's record (#170)`,
            },
          });
        }

        const relationships = await tx.professorPublication.deleteMany({ where: { professorId } });
        const sourceRecords = await tx.publicationSourceRecord.deleteMany({ where: { publicationId: { in: soleIds } } });
        const publications = await tx.publication.deleteMany({ where: { id: { in: soleIds } } });
        const identities = await tx.externalIdentity.deleteMany({ where: { professorId } });
        await tx.professor.delete({ where: { id: professorId } });
        const account = locked.user_id ? (await tx.user.deleteMany({ where: { id: locked.user_id, role: 'PROFESSOR' } })).count > 0 : false;

        return {
          professor: { id: locked.id, name: locked.name },
          account,
          identities: identities.count,
          relationships: relationships.count,
          publications: publications.count,
          sourceRecords: sourceRecords.count,
          candidatesClosed: open.length,
        };
      },
      { timeout: 60_000, maxWait: 10_000 },
    ),
  );
}
