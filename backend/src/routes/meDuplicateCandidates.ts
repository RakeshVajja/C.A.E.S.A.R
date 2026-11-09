import { Router } from 'express';
import { z } from 'zod';
import { CANDIDATE_DEFAULT_LIMIT, CANDIDATE_MAX_LIMIT, dismissCandidate, listCandidates, mergeCandidate } from '../services/publications/duplicates';
import { SyncService } from '../services/sync/syncService';
import { HttpError } from '../utils/httpError';
import { parseBody } from '../utils/validation';
import { ownProfessor } from './mePublications';

/**
 * /api/me/duplicate-candidates (Project_plan.md §8.5; decisions #149–#151): the signed-in
 * professor's duplicate candidates — every OPEN candidate in which either publication has a
 * relationship with them, in any status. The professor comes from the session, never the client.
 *
 *   GET    /             OPEN candidates, oldest first, paged
 *   POST   /:id/dismiss  OPEN → DISMISSED; both publications stay
 *   POST   /:id/merge    { keepPublicationId } — the other publication is merged into it
 */

const listQuery = z.strictObject({
  limit: z.coerce.number().int().min(1).max(CANDIDATE_MAX_LIMIT).default(CANDIDATE_DEFAULT_LIMIT),
  offset: z.coerce.number().int().min(0).max(1_000_000).default(0),
});
const mergeBody = z.strictObject({ keepPublicationId: z.uuid() });

/** A malformed ID cannot name an existing candidate. */
function candidateId(value: unknown): string {
  const id = z.uuid().safeParse(value);
  if (!id.success) throw new HttpError(404, 'CANDIDATE_NOT_FOUND', 'Duplicate candidate not found');
  return id.data;
}

export function createMeDuplicateCandidatesRouter(deps: { sync: SyncService; now: () => Date }): Router {
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
    res.json(await listCandidates(professorId, parsed.data));
  });

  router.post('/:id/dismiss', async (req, res) => {
    const { professorId, userId } = ownProfessor(req);
    res.json(await dismissCandidate(candidateId(req.params.id), professorId, userId, deps.now()));
  });

  router.post('/:id/merge', async (req, res) => {
    const { professorId, userId } = ownProfessor(req);
    const id = candidateId(req.params.id);
    const body = parseBody(mergeBody, req.body);
    res.json(await mergeCandidate(id, body.keepPublicationId, professorId, userId, deps));
  });

  return router;
}
