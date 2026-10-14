import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../config/database';
import { SyncService } from '../services/sync/syncService';
import { HttpError } from '../utils/httpError';

/**
 * /api/admin/sync (Project_plan.md §14, §15.3; Phase 12). Mounted behind the admin guards
 * (session, ADMIN role from the database, no temporary password).
 *
 *   POST /             start a manual run (202; 409 SYNC_ALREADY_RUNNING while one runs)
 *   GET  /runs         run history, newest first (limit/offset)
 *   GET  /runs/:runId  one run with its tasks
 */

const listQuery = z.strictObject({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).max(1_000_000).default(0),
});

const runSelect = {
  id: true,
  trigger: true,
  triggeredByUserId: true,
  status: true,
  tasksTotal: true,
  tasksSucceeded: true,
  tasksFailed: true,
  recordsFetched: true,
  recordsNew: true,
  recordsUpdated: true,
  linksCreated: true,
  candidatesCreated: true,
  startedAt: true,
  finishedAt: true,
} as const;

export function createAdminSyncRouter(deps: { sync: SyncService }): Router {
  const router = Router();

  router.post('/', async (req, res) => {
    // No body: a manual run synchronizes every active identity of every active professor.
    const run = await deps.sync.start('MANUAL', req.auth!.user.id);
    const started = await prisma.syncRun.findUniqueOrThrow({ where: { id: run.id }, select: runSelect });
    res.status(202).json({ run: started });
  });

  router.get('/runs', async (req, res) => {
    const parsed = listQuery.safeParse(req.query);
    if (!parsed.success) {
      throw new HttpError(
        400,
        'VALIDATION_ERROR',
        'Invalid query parameters',
        parsed.error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })),
      );
    }
    const [runs, total] = await prisma.$transaction([
      prisma.syncRun.findMany({ select: runSelect, orderBy: [{ startedAt: 'desc' }, { id: 'desc' }], take: parsed.data.limit, skip: parsed.data.offset }),
      prisma.syncRun.count(),
    ]);
    res.json({ runs, total, limit: parsed.data.limit, offset: parsed.data.offset, running: deps.sync.running });
  });

  router.get('/runs/:runId', async (req, res) => {
    const id = z.uuid().safeParse(req.params.runId);
    const run = id.success
      ? await prisma.syncRun.findUnique({
          where: { id: id.data },
          select: {
            ...runSelect,
            tasks: {
              select: {
                id: true,
                source: true,
                status: true,
                recordsFetched: true,
                recordsNew: true,
                recordsUpdated: true,
                linksCreated: true,
                candidatesCreated: true,
                warnings: true,
                errorMessage: true,
                startedAt: true,
                finishedAt: true,
                identity: { select: { id: true, externalId: true, professor: { select: { id: true, name: true } } } },
              },
              orderBy: [{ startedAt: { sort: 'asc', nulls: 'last' } }, { id: 'asc' }],
            },
          },
        })
      : null;
    if (!run) throw new HttpError(404, 'SYNC_RUN_NOT_FOUND', 'Synchronization run not found');
    res.json({ run });
  });

  return router;
}
