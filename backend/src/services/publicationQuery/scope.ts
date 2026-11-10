import { Prisma } from '@prisma/client';
import { HttpError } from '../../utils/httpError';
import type { Tx } from '../matching/engine';
import type { LinkScope } from './ast';
import { utcDayStart, utcNextDayStart } from './dates';

/**
 * Publication scopes of queries (Project_plan.md §24.4–§24.5; decisions #154, D1, D2, D10, D12).
 * The scope is always built here, on the server, and ANDed with the user's conditions, which can
 * therefore never widen it.
 */

/** D1: the session professor's APPROVED relationships, and ACTIVE publications only. */
export function professorScope(professorId: string): Prisma.PublicationWhereInput {
  return { status: 'ACTIVE', professors: { some: { professorId, status: 'APPROVED' } } };
}

/**
 * A qualifying link (§24.5): one relationship row whose status is in `statuses` and, when given,
 * whose origin is in `origins` and whose decision date lies within `decidedOn` — all on the same
 * row. Dates are UTC calendar days (dates.ts): `after` = later than that day, `before` = earlier than it.
 */
export function qualifyingLink(link: LinkScope): Prisma.ProfessorPublicationWhereInput {
  const decided: Prisma.DateTimeNullableFilter = {};
  if (link.decidedOn?.after) decided.gte = utcNextDayStart(link.decidedOn.after);
  if (link.decidedOn?.before) decided.lt = utcDayStart(link.decidedOn.before);
  return {
    status: { in: link.statuses },
    ...(link.origins && { origin: { in: link.origins } }),
    ...(link.decidedOn && { decidedAt: decided }),
  };
}

/**
 * The administrator's link scope as a publication filter (§24.5):
 *   ANY_PROFESSOR     some professor (active or inactive) has a qualifying link
 *   SELECTED + ANY    at least one selected professor has a qualifying link
 *   SELECTED + ALL    every selected professor has a qualifying link
 *   NO_LINK           no relationship of any status
 *   ALL_PUBLICATIONS  no restriction
 * Selected professors must exist (unknown → 400 PROFESSOR_NOT_FOUND); inactive ones are allowed.
 */
export async function adminLinkScope(link: LinkScope, db: Tx): Promise<Prisma.PublicationWhereInput> {
  const qualifying = qualifyingLink(link);
  switch (link.mode) {
    case 'ANY_PROFESSOR':
      return { professors: { some: qualifying } };
    case 'NO_LINK':
      return { professors: { none: {} } };
    case 'ALL_PUBLICATIONS':
      return {};
    case 'SELECTED': {
      const selected = link.professors!;
      const found = await db.professor.findMany({ where: { id: { in: selected } }, select: { id: true } });
      if (found.length !== selected.length) {
        const known = new Set(found.map((p) => p.id));
        throw new HttpError(400, 'PROFESSOR_NOT_FOUND', 'One or more selected professors do not exist', {
          professorIds: selected.filter((id) => !known.has(id)),
        });
      }
      if (link.match === 'ALL') return { AND: selected.map((professorId) => ({ professors: { some: { ...qualifying, professorId } } })) };
      return { professors: { some: { ...qualifying, professorId: { in: selected } } } };
    }
  }
}
