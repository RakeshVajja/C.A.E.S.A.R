import { Router } from 'express';
import { z } from 'zod';
import {
  getPublication,
  LIST_DEFAULT_LIMIT,
  LIST_MAX_LIMIT,
  listPublications,
  setPublicationStatus,
  updatePublication,
} from '../services/publications/adminPublications';
import {
  CANDIDATE_DEFAULT_LIMIT,
  CANDIDATE_MAX_LIMIT,
  detachSourceRecord,
  dismissCandidate,
  listCandidates,
  mergeCandidate,
} from '../services/publications/duplicates';
import { SyncService } from '../services/sync/syncService';
import { HttpError } from '../utils/httpError';
import { parseBody } from '../utils/validation';

/**
 * Administrator publication and duplicate management (Project_plan.md §8.5, §15.1; Phase 13B).
 * Mounted behind the admin guards (session, ADMIN role from the database, no temporary password).
 *
 *   /api/admin/publications
 *     GET    /                 search and filter (suppressed included), paged
 *     GET    /:id              details: source records, relationships, duplicate candidates
 *     PATCH  /:id              edit canonical metadata (marks it curated)
 *     PATCH  /:id/status       ACTIVE ⇄ SUPPRESSED with the expected current status
 *   /api/admin/duplicate-candidates
 *     GET    /                 by status (default OPEN), paged
 *     POST   /:id/dismiss
 *     POST   /:id/merge        { keepPublicationId }
 *   /api/admin/source-records
 *     POST   /:id/detach
 */

const typeFamily = z.enum(['PREPRINT', 'CONFERENCE', 'JOURNAL', 'BOOK_CHAPTER', 'BOOK', 'OTHER']);
const publicationStatus = z.enum(['ACTIVE', 'SUPPRESSED']);
const optionalText = (max: number) =>
  z.string().trim().max(max).nullable().optional().transform((v) => (v === '' ? null : v));

const publicationQuery = z.strictObject({
  q: z.string().trim().min(1).max(300).optional(),
  status: publicationStatus.optional(),
  typeFamily: typeFamily.optional(),
  curated: z.enum(['true', 'false']).transform((v) => v === 'true').optional(),
  limit: z.coerce.number().int().min(1).max(LIST_MAX_LIMIT).default(LIST_DEFAULT_LIMIT),
  offset: z.coerce.number().int().min(0).max(1_000_000).default(0),
});
const candidateQuery = z.strictObject({
  status: z.enum(['OPEN', 'MERGED', 'DISMISSED']).default('OPEN'),
  limit: z.coerce.number().int().min(1).max(CANDIDATE_MAX_LIMIT).default(CANDIDATE_DEFAULT_LIMIT),
  offset: z.coerce.number().int().min(0).max(1_000_000).default(0),
});

const editBody = z
  .strictObject({
    title: z.string().trim().min(1).max(1000).optional(),
    year: z.number().int().min(1000).max(2100).nullable().optional(),
    venue: optionalText(500),
    typeFamily: typeFamily.optional(),
    authorNames: optionalText(5000),
    doi: optionalText(300),
  })
  .refine((body) => Object.keys(body).length > 0, 'Provide at least one field to change');
const statusBody = z.strictObject({ status: publicationStatus, expectedStatus: publicationStatus });
const mergeBody = z.strictObject({ keepPublicationId: z.uuid() });

function parseQuery<T extends z.ZodType>(schema: T, query: unknown): z.infer<T> {
  const parsed = schema.safeParse(query);
  if (!parsed.success) {
    throw new HttpError(
      400,
      'VALIDATION_ERROR',
      'Invalid query parameters',
      parsed.error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })),
    );
  }
  return parsed.data;
}

/** A malformed ID cannot name an existing row. */
function uuidParam(value: unknown, notFound: () => HttpError): string {
  const result = z.uuid().safeParse(value);
  if (!result.success) throw notFound();
  return result.data;
}
const publicationId = (v: unknown) => uuidParam(v, () => new HttpError(404, 'PUBLICATION_NOT_FOUND', 'Publication not found'));
const candidateId = (v: unknown) => uuidParam(v, () => new HttpError(404, 'CANDIDATE_NOT_FOUND', 'Duplicate candidate not found'));
const recordId = (v: unknown) => uuidParam(v, () => new HttpError(404, 'SOURCE_RECORD_NOT_FOUND', 'Source record not found'));

export function createAdminPublicationsRouter(): Router {
  const router = Router();

  router.get('/', async (req, res) => {
    res.json(await listPublications(parseQuery(publicationQuery, req.query)));
  });

  router.get('/:id', async (req, res) => {
    res.json({ publication: await getPublication(publicationId(req.params.id)) });
  });

  router.patch('/:id', async (req, res) => {
    const id = publicationId(req.params.id);
    const body = parseBody(editBody, req.body);
    res.json({ publication: await updatePublication(id, body) });
  });

  router.patch('/:id/status', async (req, res) => {
    const id = publicationId(req.params.id);
    const body = parseBody(statusBody, req.body);
    res.json({ publication: await setPublicationStatus(id, body.status, body.expectedStatus) });
  });

  return router;
}

export function createAdminDuplicatesRouter(deps: { sync: SyncService; now: () => Date }): Router {
  const router = Router();

  router.get('/', async (req, res) => {
    res.json(await listCandidates(parseQuery(candidateQuery, req.query)));
  });

  router.post('/:id/dismiss', async (req, res) => {
    res.json(await dismissCandidate(candidateId(req.params.id), req.auth!.user.id, deps.now()));
  });

  router.post('/:id/merge', async (req, res) => {
    const id = candidateId(req.params.id);
    const body = parseBody(mergeBody, req.body);
    res.json(await mergeCandidate(id, body.keepPublicationId, req.auth!.user.id, deps));
  });

  return router;
}

export function createAdminSourceRecordsRouter(deps: { sync: SyncService }): Router {
  const router = Router();

  router.post('/:id/detach', async (req, res) => {
    res.json(await detachSourceRecord(recordId(req.params.id), deps));
  });

  return router;
}
