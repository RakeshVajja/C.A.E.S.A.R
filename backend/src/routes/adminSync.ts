import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../config/database';
import { CLARIVATE_GATE_MESSAGE } from '../services/providers/clarivateGate';
import { DISCOVERY_PROVIDERS, PROVIDER_LABEL } from '../services/providers/providerStatus';
import { parseCoverageSnapshot, providerCoverage } from '../services/sync/runOutcome';
import { SyncService } from '../services/sync/syncService';
import { HttpError } from '../utils/httpError';

/**
 * /api/admin/sync (Project_plan.md §14, §15.3; Phase 12). Mounted behind the admin guards
 * (session, ADMIN role from the database, no temporary password).
 *
 *   POST /             start a manual run (202; 409 SYNC_ALREADY_RUNNING while one runs)
 *   GET  /runs         run history, newest first (limit/offset)
 *   GET  /runs/:runId  one run with its tasks and per-provider coverage
 *
 * These endpoints cover publication-discovery runs only (decision #123); journal-metrics (JCR) runs
 * are reported separately, so their status never appears here:
 *
 *   GET  /providers                   configuration state of the five discovery providers and JCR
 *                                     (credentials present or not — never values, never "access works")
 *                                     and whether the Clarivate gate is open (§22.6)
 *   POST /journal-metrics             start a JCR refresh (202; 409 SYNC_ALREADY_RUNNING; 409
 *                                     CLARIVATE_GATE_CLOSED while live Clarivate data is blocked)
 *   GET  /journal-metrics/runs        JCR run history, newest first (limit/offset)
 *   GET  /journal-metrics/runs/:runId one JCR run with its journal tasks
 *
 * JCR endpoints report run status and counters only — no metric values (their display waits for
 * Clarivate's written confirmation, §13.10).
 */

const DISCOVERY = { kind: 'PUBLICATION_DISCOVERY' } as const;
const JOURNAL_METRICS = { kind: 'JOURNAL_METRICS' } as const;

const journalRunSelect = {
  id: true,
  trigger: true,
  triggeredByUserId: true,
  status: true,
  tasksTotal: true,
  tasksSucceeded: true,
  tasksFailed: true,
  journalsChecked: true,
  snapshotsAdded: true,
  jcrDataUpdate: true,
  startedAt: true,
  finishedAt: true,
} as const;

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
      prisma.syncRun.findMany({ where: DISCOVERY, select: runSelect, orderBy: [{ startedAt: 'desc' }, { id: 'desc' }], take: parsed.data.limit, skip: parsed.data.offset }),
      prisma.syncRun.count({ where: DISCOVERY }),
    ]);
    res.json({ runs, total, limit: parsed.data.limit, offset: parsed.data.offset, running: deps.sync.running });
  });

  router.get('/runs/:runId', async (req, res) => {
    const id = z.uuid().safeParse(req.params.runId);
    const run = id.success
      ? await prisma.syncRun.findFirst({
          where: { id: id.data, ...DISCOVERY },
          select: {
            ...runSelect,
            providerCoverage: true,
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
    // Coverage comes from the snapshot stored at run start (null for runs before Phase 15).
    const { providerCoverage: stored, ...rest } = run;
    const snapshot = parseCoverageSnapshot(stored);
    res.json({ run: { ...rest, coverage: snapshot ? providerCoverage(snapshot, run.tasks) : null } });
  });

  router.get('/providers', (_req, res) => {
    const configuration = deps.sync.providerConfiguration;
    const entry = (provider: keyof typeof configuration, purpose: 'PUBLICATION_DISCOVERY' | 'JOURNAL_METRICS') => ({
      provider,
      label: PROVIDER_LABEL[provider],
      purpose,
      credentials: configuration[provider].credentials,
      issue: configuration[provider].issue,
    });
    res.json({
      providers: [...DISCOVERY_PROVIDERS.map((p) => entry(p, 'PUBLICATION_DISCOVERY')), entry('JCR', 'JOURNAL_METRICS')],
      // Web of Science and JCR stay blocked until this is open (§22.6), whatever their credentials.
      clarivateGate: { open: deps.sync.clarivateGateOpen, message: deps.sync.clarivateGateOpen ? null : CLARIVATE_GATE_MESSAGE },
    });
  });

  router.post('/journal-metrics', async (req, res) => {
    const run = await deps.sync.startJournalMetrics('MANUAL', req.auth!.user.id);
    const started = await prisma.syncRun.findUniqueOrThrow({ where: { id: run.id }, select: journalRunSelect });
    res.status(202).json({ run: started });
  });

  router.get('/journal-metrics/runs', async (req, res) => {
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
      prisma.syncRun.findMany({ where: JOURNAL_METRICS, select: journalRunSelect, orderBy: [{ startedAt: 'desc' }, { id: 'desc' }], take: parsed.data.limit, skip: parsed.data.offset }),
      prisma.syncRun.count({ where: JOURNAL_METRICS }),
    ]);
    res.json({ runs, total, limit: parsed.data.limit, offset: parsed.data.offset, running: deps.sync.running });
  });

  router.get('/journal-metrics/runs/:runId', async (req, res) => {
    const id = z.uuid().safeParse(req.params.runId);
    const run = id.success
      ? await prisma.syncRun.findFirst({
          where: { id: id.data, ...JOURNAL_METRICS },
          select: {
            ...journalRunSelect,
            tasks: {
              select: {
                id: true,
                status: true,
                recordsFetched: true,
                snapshotsAdded: true,
                warnings: true,
                errorMessage: true,
                startedAt: true,
                finishedAt: true,
                journal: { select: { id: true, jcrId: true, name: true } },
              },
              orderBy: [{ startedAt: { sort: 'asc', nulls: 'last' } }, { id: 'asc' }],
            },
          },
        })
      : null;
    if (!run) throw new HttpError(404, 'SYNC_RUN_NOT_FOUND', 'Journal metrics run not found');
    res.json({ run });
  });

  return router;
}
