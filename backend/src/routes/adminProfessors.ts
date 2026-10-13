import { Response, Router } from 'express';
import { z } from 'zod';
import {
  deleteIdentity,
  IdentityClients,
  previewIdentity,
  saveIdentity,
  setIdentityActive,
} from '../services/identities/identities';
import {
  createProfessor,
  createProfessorAccount,
  getProfessor,
  listProfessors,
  setProfessorActive,
  updateProfessor,
} from '../services/professors/professors';
import { HttpError } from '../utils/httpError';
import { parseBody } from '../utils/validation';

/**
 * /api/admin/professors (Project_plan.md §15.3, Phase 9). Mounted behind the admin guards
 * (session, ADMIN role from the database, no temporary password). Bodies are strict: unknown
 * fields such as `role`, `userId` or `isActive` in a profile update are rejected.
 */

const name = z.string().trim().min(1).max(200);
const optionalText = z.string().trim().max(200).nullable().optional().transform((v) => (v === '' ? null : v));
const email = z.string().trim().toLowerCase().max(254).pipe(z.email());
const source = z.enum(['OPENALEX', 'DBLP', 'ORCID']);

const createBody = z.strictObject({ name, department: optionalText, designation: optionalText, email });
const updateBody = z
  .strictObject({ name: name.optional(), department: optionalText, designation: optionalText, email: email.optional() })
  .refine((body) => Object.keys(body).length > 0, 'Provide at least one field to change');
const statusBody = z.strictObject({ isActive: z.boolean() });
const accountBody = z.strictObject({ email });
const previewBody = z.strictObject({ source, externalId: z.string().trim().min(1).max(200) });
const saveBody = z.strictObject({ previewToken: z.string().min(1).max(4096) });

/** A malformed ID cannot name an existing row. */
function uuidParam(value: unknown, notFound: () => HttpError): string {
  const result = z.uuid().safeParse(value);
  if (!result.success) throw notFound();
  return result.data;
}
const professorId = (value: unknown) => uuidParam(value, () => new HttpError(404, 'PROFESSOR_NOT_FOUND', 'Professor not found'));
const identityId = (value: unknown) =>
  uuidParam(value, () => new HttpError(404, 'IDENTITY_NOT_FOUND', 'External identity not found for this professor'));

/** Responses carrying a temporary password must never be cached. */
function noStore(res: Response): Response {
  return res.set('Cache-Control', 'no-store');
}

export function createAdminProfessorsRouter(deps: { identityClients: IdentityClients; now: () => Date }): Router {
  const router = Router();

  router.get('/', async (req, res) => {
    res.json({ professors: await listProfessors() });
  });

  router.post('/', async (req, res) => {
    const body = parseBody(createBody, req.body);
    const result = await createProfessor(body);
    noStore(res).status(201).json(result);
  });

  router.get('/:professorId', async (req, res) => {
    res.json({ professor: await getProfessor(professorId(req.params.professorId)) });
  });

  router.patch('/:professorId', async (req, res) => {
    const body = parseBody(updateBody, req.body);
    res.json({ professor: await updateProfessor(professorId(req.params.professorId), body) });
  });

  router.patch('/:professorId/status', async (req, res) => {
    const body = parseBody(statusBody, req.body);
    res.json({ professor: await setProfessorActive(professorId(req.params.professorId), body.isActive) });
  });

  router.post('/:professorId/account', async (req, res) => {
    const body = parseBody(accountBody, req.body);
    const result = await createProfessorAccount(professorId(req.params.professorId), body.email);
    noStore(res).status(201).json(result);
  });

  router.post('/:professorId/identities/preview', async (req, res) => {
    const body = parseBody(previewBody, req.body);
    const result = await previewIdentity(professorId(req.params.professorId), body.source, body.externalId, {
      clients: deps.identityClients,
      now: deps.now,
    });
    noStore(res).json(result);
  });

  router.post('/:professorId/identities', async (req, res) => {
    const body = parseBody(saveBody, req.body);
    const identity = await saveIdentity(professorId(req.params.professorId), body.previewToken, { now: deps.now });
    res.status(201).json({ identity });
  });

  router.patch('/:professorId/identities/:identityId', async (req, res) => {
    const body = parseBody(statusBody, req.body);
    res.json(await setIdentityActive(professorId(req.params.professorId), identityId(req.params.identityId), body.isActive));
  });

  router.delete('/:professorId/identities/:identityId', async (req, res) => {
    res.json(await deleteIdentity(professorId(req.params.professorId), identityId(req.params.identityId)));
  });

  return router;
}
