import { Router } from 'express';
import { z } from 'zod';
import { env } from '../config/env';
import { LIMITS, parseQuery } from '../services/publicationQuery/ast';
import { queryAnalytics } from '../services/publicationQuery/analytics';
import { queryFields, searchPublications } from '../services/publicationQuery/execute';
import { buildPreset, defaultAdminQuery, listPresets } from '../services/publicationQuery/presets';
import { HttpError } from '../utils/httpError';

/**
 * /api/admin/publication-queries (Project_plan.md §24.4–§24.8; decisions #154–#159, stage Q3): the
 * administrator's publication queries on the Analytics page. Mounted behind the admin guards
 * (session, ADMIN role from the database, password changed, no-store). The query engine
 * (services/publicationQuery) validates every body in full — admin field whitelist, link scope
 * (modes, statuses, ANY / ALL, at most 50 existing professors), limits, citation availability —
 * and builds the link scope on the server.
 *
 *   GET  /fields         admin fields, operators, sorts, limits, link-scope options, Scopus availability,
 *                        and the initial query (D2, D3: Any professor, APPROVED; ACTIVE; not PREPRINT)
 *   GET  /presets        shared and admin presets (availability included)
 *   GET  /presets/:id    the complete query a preset produces (?value= — a year, a text, or for the
 *                        professors parameter a comma-separated list of 2–50 different professor IDs)
 *   POST /search         run a query: { link, root?, sort?, limit?, offset? }
 *   POST /analytics      conditional analytics over exactly the publications the same query matches
 *                        (§24.6, stage Q4): { total, analytics } — analytics null with fewer than two matches
 */

const presetValue = z.strictObject({ value: z.string().trim().min(1).max(LIMITS.professors * 37).optional() });
// Joint publications need at least two distinct professors (SELECTED + ALL); at most 50 (D12).
const professorIds = z
  .array(z.uuid())
  .max(LIMITS.professors)
  .refine((ids) => new Set(ids.map((id) => id.toLowerCase())).size >= 2, 'Select at least two different professors');

export function createAdminPublicationQueriesRouter(deps: { now: () => Date }): Router {
  const router = Router();

  router.get('/fields', async (_req, res) => {
    res.json({ ...(await queryFields({ role: 'ADMIN' })), defaultQuery: defaultAdminQuery() });
  });

  router.get('/presets', async (_req, res) => {
    const { scopus } = await queryFields({ role: 'ADMIN' });
    res.json({ presets: listPresets('ADMIN', scopus.available) });
  });

  router.get('/presets/:id', async (req, res) => {
    const parsed = presetValue.safeParse(req.query);
    if (!parsed.success) throw new HttpError(400, 'VALIDATION_ERROR', 'Invalid preset value');
    const { scopus } = await queryFields({ role: 'ADMIN' });
    const preset = listPresets('ADMIN', scopus.available).find((p) => p.id === req.params.id);
    if (!preset) throw new HttpError(404, 'PRESET_NOT_FOUND', 'Unknown predefined filter');
    if (!preset.available) {
      throw new HttpError(409, 'CITATION_DATA_UNAVAILABLE', 'Scopus citation data is unavailable, so citation filters and sorting cannot be used');
    }
    const raw = parsed.data.value;
    let value: unknown = raw;
    if (raw !== undefined && preset.parameter === 'year' && /^\d{4}$/.test(raw)) value = Number(raw);
    if (raw !== undefined && preset.parameter === 'professors') {
      const ids = professorIds.safeParse(raw.split(',').map((id) => id.trim()));
      if (!ids.success) throw new HttpError(400, 'VALIDATION_ERROR', `Select between 2 and ${LIMITS.professors} different professors`);
      value = ids.data;
    }
    const query = buildPreset('ADMIN', preset.id, value, deps.now(), env.syncTimezone);
    // The built query goes through the shared validator like any other (unknown professors are refused by /search).
    parseQuery('ADMIN', query);
    res.json({ query });
  });

  router.post('/search', async (req, res) => {
    res.json(await searchPublications({ role: 'ADMIN' }, req.body));
  });

  router.post('/analytics', async (req, res) => {
    res.json(await queryAnalytics(req.body));
  });

  return router;
}
