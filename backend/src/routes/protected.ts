import { RequestHandler, Router } from 'express';
import { z } from 'zod';
import { requireAuth, requirePasswordChanged, requireRole } from '../middleware/auth';
import { IdentityClients } from '../services/identities/identities';
import { getOwnProfile, updateOwnName } from '../services/professors/professors';
import { HttpError } from '../utils/httpError';
import { parseBody } from '../utils/validation';
import { createAdminAnalyticsRouter } from './adminAnalytics';
import { createAdminPublicationQueriesRouter } from './adminPublicationQueries';
import { createAdminPublicationsRouter, createAdminSourceRecordsRouter } from './adminPublications';
import { createMeDuplicateCandidatesRouter } from './meDuplicateCandidates';
import { createMeIdentitiesRouter } from './meIdentities';
import { createMePublicationQueriesRouter } from './mePublicationQueries';
import { createAdminProfessorsRouter } from './adminProfessors';
import { createMePublicationsRouter } from './mePublications';
import { createAdminSyncRouter } from './adminSync';
import { SyncService } from '../services/sync/syncService';
import { Mailer } from '../services/email/mailer';

/**
 * Protected route groups (Project_plan.md §15.3). Every endpoint inherits the checks mounted here.
 * /api/me endpoints derive the professor from the session (req.auth), never from the URL or body.
 * Their responses may carry provider-derived data and are never cached (§22.4: no copies outside
 * the database, so provider-data removal reaches every copy).
 */

const noStore: RequestHandler = (_req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
};

const ownProfileBody = z.strictObject({ name: z.string().trim().min(1).max(200) });

export function createMeRouter(deps: { now: () => Date; sync: SyncService; identityClients: IdentityClients }): Router {
  const router = Router();
  router.use(noStore, requireAuth, requirePasswordChanged);

  // A professor's own profile: readable, and only the name is editable (decision #67).
  const professorOnly = (role: string) => {
    if (role !== 'PROFESSOR') throw new HttpError(403, 'FORBIDDEN', 'Only professors have a profile');
  };
  router.get('/profile', async (req, res) => {
    professorOnly(req.auth!.user.role);
    res.json({ profile: await getOwnProfile(req.auth!.user.id) });
  });
  router.patch('/profile', async (req, res) => {
    professorOnly(req.auth!.user.role);
    const body = parseBody(ownProfileBody, req.body);
    res.json({ profile: await updateOwnName(req.auth!.user.id, body.name) });
  });

  // Verification of the professor's own publication relationships (Phase 10).
  router.use('/publications', createMePublicationsRouter(deps));
  // Resolution of the professor's duplicate candidates (§8.5; #149–#151).
  router.use('/duplicate-candidates', createMeDuplicateCandidatesRouter(deps));
  // The professor's publication queries (§24, stage Q2): own APPROVED, ACTIVE publications only.
  router.use('/publication-queries', createMePublicationQueriesRouter(deps));
  // The professor's own external identities (#171): self-service, active at once, synchronized on their own.
  router.use('/identities', createMeIdentitiesRouter(deps));

  return router;
}

export function createAdminRouter(deps: { identityClients: IdentityClients; now: () => Date; sync: SyncService; mailer: Mailer | null }): Router {
  const router = Router();
  router.use(noStore, requireAuth, requireRole('ADMIN'), requirePasswordChanged);
  router.use('/professors', createAdminProfessorsRouter(deps));
  router.use('/sync', createAdminSyncRouter(deps));
  router.use('/analytics', createAdminAnalyticsRouter());
  router.use('/publication-queries', createAdminPublicationQueriesRouter(deps));
  router.use('/publications', createAdminPublicationsRouter());
  router.use('/source-records', createAdminSourceRecordsRouter(deps));
  return router;
}
