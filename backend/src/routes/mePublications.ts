import { Request, Router } from 'express';
import { z } from 'zod';
import {
  bulkApprove,
  BULK_APPROVE_MAX,
  decide,
  LIST_DEFAULT_LIMIT,
  LIST_MAX_LIMIT,
  listOwnPublications,
} from '../services/verification/verification';
import { addManualPublication } from '../services/manual/manualPublications';
import { HttpError } from '../utils/httpError';
import { parseBody } from '../utils/validation';

/**
 * /api/me/publications (Project_plan.md §11, §15.3; Phase 10). Mounted behind the /api/me checks
 * (session, active account, no temporary password). The professor is the signed-in user's own
 * professor record, loaded from the database for this request — never an ID from the client.
 */

const status = z.enum(['PENDING', 'APPROVED', 'REJECTED']);
const listQuery = z.strictObject({
  status: status.optional(),
  limit: z.coerce.number().int().min(1).max(LIST_MAX_LIMIT).default(LIST_DEFAULT_LIMIT),
  offset: z.coerce.number().int().min(0).max(1_000_000).default(0),
});
const decisionBody = z.strictObject({ status: z.enum(['APPROVED', 'REJECTED']), expectedStatus: status });
const bulkBody = z.strictObject({
  relationshipIds: z
    .array(z.uuid())
    .min(1)
    .max(BULK_APPROVE_MAX)
    .refine((ids) => new Set(ids).size === ids.length, 'Relationship IDs must be unique'),
});

/** The signed-in professor (403 for other roles, 404 for a professor account without a profile). */
// Manual entry (§12.1): title and type family required; DOI, year, venue and author names optional.
// Strict: abstracts, full text, files or other fields are refused, never stored.
const optionalText = (max: number) => z.string().trim().max(max).nullable().optional().transform((v) => (v ? v : null));
const manualBody = z.strictObject({
  title: z.string().trim().min(1).max(1000),
  typeFamily: z.enum(['PREPRINT', 'CONFERENCE', 'JOURNAL', 'BOOK_CHAPTER', 'BOOK', 'OTHER']),
  doi: optionalText(300),
  year: z.number().int().min(1000).max(2100).nullable().optional(),
  venue: optionalText(500),
  authorNames: optionalText(5000),
});

function ownProfessor(req: Request): { professorId: string; userId: string } {
  const user = req.auth!.user;
  if (user.role !== 'PROFESSOR') throw new HttpError(403, 'FORBIDDEN', 'Only professors verify publications');
  if (!user.professor) throw new HttpError(404, 'PROFILE_NOT_FOUND', 'No professor profile is linked to this account');
  return { professorId: user.professor.id, userId: user.id };
}

export function createMePublicationsRouter(deps: { now: () => Date }): Router {
  const router = Router();

  router.get('/', async (req, res) => {
    const { professorId } = ownProfessor(req);
    const parsed = listQuery.safeParse(req.query);
    if (!parsed.success) {
      throw new HttpError(
        400,
        'VALIDATION_ERROR',
        'Invalid query parameters',
        parsed.error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })),
      );
    }
    const query = parsed.data;
    res.json(await listOwnPublications(professorId, query));
  });

  // Manual publication addition (Phase 11): through the shared matching pipeline; APPROVED/MANUAL.
  router.post('/', async (req, res) => {
    const { professorId, userId } = ownProfessor(req);
    const body = parseBody(manualBody, req.body);
    res.status(201).json(await addManualPublication(professorId, userId, body, deps.now()));
  });

  // Registered before '/:relationshipId' so "approve" is never read as an ID.
  router.post('/approve', async (req, res) => {
    const { professorId, userId } = ownProfessor(req);
    const body = parseBody(bulkBody, req.body);
    res.json(await bulkApprove(professorId, userId, body.relationshipIds, deps.now()));
  });

  router.patch('/:relationshipId', async (req, res) => {
    const { professorId, userId } = ownProfessor(req);
    const body = parseBody(decisionBody, req.body);
    const id = z.uuid().safeParse(req.params.relationshipId);
    if (!id.success) throw new HttpError(404, 'RELATIONSHIP_NOT_FOUND', 'Publication relationship not found');
    res.json({ item: await decide(professorId, userId, id.data, body.status, body.expectedStatus, deps.now()) });
  });

  return router;
}
