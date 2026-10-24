import { Router } from 'express';
import { z } from 'zod';
import { approvedPerProfessor, overview, publicationsByYear, sourceStatistics, syncStatistics } from '../services/analytics/analytics';
import { HttpError } from '../utils/httpError';

/**
 * /api/admin/analytics (Project_plan.md §16; Phase 13). Mounted behind the admin guards (session,
 * ADMIN role from the database, no temporary password). Read-only; no query parameters.
 *
 *   GET /overview      professors, unique publications, pending verifications, last sync
 *   GET /professors    counted publications per active professor
 *   GET /years         counted publications per year (unknown year separate)
 *   GET /sources       source records against unique canonical publications
 *   GET /sync          synchronization runs, tasks and record counters
 */

const noQuery = z.strictObject({});

export function createAdminAnalyticsRouter(): Router {
  const router = Router();

  router.use((req, _res, next) => {
    const parsed = noQuery.safeParse(req.query);
    if (!parsed.success) {
      throw new HttpError(
        400,
        'VALIDATION_ERROR',
        'Invalid query parameters',
        parsed.error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })),
      );
    }
    next();
  });

  router.get('/overview', async (_req, res) => {
    res.json({ overview: await overview() });
  });
  router.get('/professors', async (_req, res) => {
    res.json(await approvedPerProfessor());
  });
  router.get('/years', async (_req, res) => {
    res.json(await publicationsByYear());
  });
  router.get('/sources', async (_req, res) => {
    res.json(await sourceStatistics());
  });
  router.get('/sync', async (_req, res) => {
    res.json(await syncStatistics());
  });

  return router;
}
