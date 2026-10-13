import { Router } from 'express';
import { requireAuth, requirePasswordChanged, requireRole } from '../middleware/auth';

/**
 * Route groups for later phases (Project_plan.md §15.3). Protection is mounted now so every
 * future endpoint inherits it; no feature endpoints exist yet (unknown paths end in 404 after
 * the checks). /api/me endpoints derive the professor from req.auth, never from the URL.
 */

export function createMeRouter(): Router {
  const router = Router();
  router.use(requireAuth, requirePasswordChanged);
  return router;
}

export function createAdminRouter(): Router {
  const router = Router();
  router.use(requireAuth, requireRole('ADMIN'), requirePasswordChanged);
  return router;
}
