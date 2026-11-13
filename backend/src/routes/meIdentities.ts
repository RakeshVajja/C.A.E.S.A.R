import { Response, Router } from 'express';
import { z } from 'zod';
import { RateLimiter, RateLimitRule } from '../middleware/rateLimit';
import {
  deleteIdentity,
  IdentityClients,
  listOwnIdentities,
  ownIdentity,
  previewIdentity,
  registerManualIdentity,
  saveIdentity,
  setIdentityActive,
  startIdentitySync,
} from '../services/identities/identities';
import type { SyncService } from '../services/sync/syncService';
import { HttpError } from '../utils/httpError';
import { parseBody } from '../utils/validation';
import { ownProfessor } from './mePublications';

/**
 * /api/me/identities (decision #171): a professor manages the external identities of their own
 * profile — preview-first registration, manual Scopus / Web of Science registration from the public
 * profile when the provider's API is not configured, activation, deactivation and removal. The
 * professor comes only from the session (`ownProfessor`); every identity operation is scoped to
 * that professor, so another professor's identity is answered 404. Professor-added identities are
 * active at once (no approval) and are synchronized on their own right after they are saved.
 * Responses never disclose another professor's identity or ownership. The administrator's identity
 * routes are unchanged.
 *
 *   GET    /                   own identities, with who added them and their synchronization status
 *   POST   /preview            { source, externalId } → the provider's details (researcher name), a preview token
 *   POST   /                   { previewToken } → the identity and its synchronization start
 *   POST   /manual             { source: SCOPUS | WOS, externalId, evidenceUrl, checkedProfile: true }
 *   PATCH  /:identityId        { isActive }
 *   DELETE /:identityId
 */

/** Approved limits (#171), per professor: previews call the providers live; additions start synchronizations. */
export const PREVIEW_RULE: RateLimitRule = { windowMs: 10 * 60 * 1000, max: 10 };
export const ADDITION_RULE: RateLimitRule = { windowMs: 60 * 60 * 1000, max: 5 };

const SOURCES = ['OPENALEX', 'DBLP', 'ORCID', 'SCOPUS', 'WOS'] as const;
const previewBody = z.strictObject({ source: z.enum(SOURCES), externalId: z.string().trim().min(1).max(200) });
const saveBody = z.strictObject({ previewToken: z.string().min(1).max(4000) });
const manualBody = z.strictObject({
  source: z.enum(['SCOPUS', 'WOS']),
  externalId: z.string().trim().min(1).max(200),
  evidenceUrl: z.string().trim().min(1).max(2000),
  checkedProfile: z.literal(true, { error: 'Confirm that you checked the public profile' }),
});
const statusBody = z.strictObject({ isActive: z.boolean() });
const identityId = (value: unknown) => {
  const parsed = z.uuid().safeParse(value);
  if (!parsed.success) throw new HttpError(404, 'IDENTITY_NOT_FOUND', 'External identity not found for this professor');
  return parsed.data;
};

function noStore(res: Response): Response {
  return res.set('Cache-Control', 'no-store');
}

export function createMeIdentitiesRouter(deps: { identityClients: IdentityClients; now: () => Date; sync: SyncService }): Router {
  const router = Router();
  const limiter = new RateLimiter(() => deps.now().getTime());
  const limit = (res: Response, key: string, rule: RateLimitRule, message: string) => {
    const { allowed, retryAfterMs } = limiter.hit(key, rule);
    if (!allowed) {
      res.setHeader('Retry-After', String(Math.ceil(retryAfterMs / 1000)));
      throw new HttpError(429, 'RATE_LIMITED', message);
    }
  };

  router.get('/', async (req, res) => {
    const { professorId } = ownProfessor(req);
    noStore(res).json({ identities: await listOwnIdentities(professorId, deps.sync) });
  });

  router.post('/preview', async (req, res) => {
    const { professorId } = ownProfessor(req);
    const body = parseBody(previewBody, req.body);
    limit(res, `identity-preview:${professorId}`, PREVIEW_RULE, 'Too many identity checks; try again later');
    const result = await previewIdentity(professorId, body.source, body.externalId, { clients: deps.identityClients, now: deps.now });
    // Another professor's identity is never disclosed: only whether the identity is already taken.
    const assigned = result.alreadyAssigned;
    noStore(res).json({
      ...result,
      alreadyAssigned: assigned ? (assigned.sameProfessor ? 'YOURS' : 'ANOTHER_PROFESSOR') : null,
    });
  });

  router.post('/', async (req, res) => {
    const { professorId, userId } = ownProfessor(req);
    const body = parseBody(saveBody, req.body);
    limit(res, `identity-add:${professorId}`, ADDITION_RULE, 'Too many identities added recently; try again later');
    const saved = await saveIdentity(professorId, body.previewToken, { now: deps.now, verifiedByUserId: userId });
    const sync = await startIdentitySync(deps.sync, saved, userId);
    noStore(res).status(201).json({ identity: await ownIdentity(professorId, saved.id, deps.sync), sync });
  });

  router.post('/manual', async (req, res) => {
    const { professorId, userId } = ownProfessor(req);
    const body = parseBody(manualBody, req.body);
    // Manual registration replaces the preview only while the provider's API is not configured.
    const previewable = body.source === 'SCOPUS' ? deps.identityClients.scopus : deps.identityClients.wos;
    if (previewable) {
      throw new HttpError(409, 'PREVIEW_AVAILABLE', 'This provider can check the identity automatically; use the preview instead');
    }
    limit(res, `identity-add:${professorId}`, ADDITION_RULE, 'Too many identities added recently; try again later');
    const saved = await registerManualIdentity(professorId, body, { now: deps.now, verifiedByUserId: userId });
    const sync = await startIdentitySync(deps.sync, saved, userId);
    noStore(res).status(201).json({ identity: await ownIdentity(professorId, saved.id, deps.sync), sync });
  });

  router.patch('/:identityId', async (req, res) => {
    const { professorId } = ownProfessor(req);
    const body = parseBody(statusBody, req.body);
    const id = identityId(req.params.identityId);
    const result = await setIdentityActive(professorId, id, body.isActive);
    noStore(res).json({ identity: await ownIdentity(professorId, id, deps.sync), pendingLinksRemoved: result.pendingLinksRemoved });
  });

  router.delete('/:identityId', async (req, res) => {
    const { professorId } = ownProfessor(req);
    noStore(res).json(await deleteIdentity(professorId, identityId(req.params.identityId)));
  });

  return router;
}
