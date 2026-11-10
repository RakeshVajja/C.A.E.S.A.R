import { Router } from 'express';
import { z } from 'zod';
import { env } from '../config/env';
import { parseQuery } from '../services/publicationQuery/ast';
import { queryFields, searchPublications } from '../services/publicationQuery/execute';
import { buildPreset, listPresets } from '../services/publicationQuery/presets';
import { HttpError } from '../utils/httpError';
import { ownProfessor } from './mePublications';

/**
 * /api/me/publication-queries (Project_plan.md §24.8; decisions #154–#157, stage Q2): the signed-in
 * professor's publication queries. Mounted behind the /api/me checks (session, password changed,
 * no-store); every route also requires the PROFESSOR role with a profile (`ownProfessor`), and the
 * professor comes only from the session. The query engine (services/publicationQuery) validates
 * every body in full and applies the professor scope (own APPROVED links, ACTIVE publications).
 *
 *   GET  /fields         the professor's fields, operators, sorts, limits and Scopus availability
 *   GET  /presets        the shared presets (availability included)
 *   GET  /presets/:id    the complete query a preset produces (?value= for parameterized presets)
 *   POST /search         run a query: { root?, sort?, limit?, offset? }
 */

const presetValue = z.strictObject({ value: z.string().trim().min(1).max(300).optional() });

export function createMePublicationQueriesRouter(deps: { now: () => Date }): Router {
  const router = Router();

  router.get('/fields', async (req, res) => {
    const { professorId } = ownProfessor(req);
    res.json(await queryFields({ role: 'PROFESSOR', professorId }));
  });

  router.get('/presets', async (req, res) => {
    const { professorId } = ownProfessor(req);
    const { scopus } = await queryFields({ role: 'PROFESSOR', professorId });
    res.json({ presets: listPresets('PROFESSOR', scopus.available) });
  });

  router.get('/presets/:id', async (req, res) => {
    const { professorId } = ownProfessor(req);
    const parsed = presetValue.safeParse(req.query);
    if (!parsed.success) throw new HttpError(400, 'VALIDATION_ERROR', 'Invalid preset value');
    const { scopus } = await queryFields({ role: 'PROFESSOR', professorId });
    const preset = listPresets('PROFESSOR', scopus.available).find((p) => p.id === req.params.id);
    if (!preset) throw new HttpError(404, 'PRESET_NOT_FOUND', 'Unknown predefined filter');
    // A preset needing Scopus data is refused while the data is unavailable (D6).
    if (!preset.available) {
      throw new HttpError(409, 'CITATION_DATA_UNAVAILABLE', 'Scopus citation data is unavailable, so citation filters and sorting cannot be used');
    }
    // A year parameter is a number; the built query is then validated like any other query.
    const raw = parsed.data.value;
    const value = preset.parameter === 'year' && raw !== undefined && /^\d{4}$/.test(raw) ? Number(raw) : raw;
    const query = buildPreset('PROFESSOR', preset.id, value, deps.now(), env.syncTimezone);
    parseQuery('PROFESSOR', query);
    res.json({ query });
  });

  router.post('/search', async (req, res) => {
    const { professorId } = ownProfessor(req);
    res.json(await searchPublications({ role: 'PROFESSOR', professorId }, req.body));
  });

  return router;
}
