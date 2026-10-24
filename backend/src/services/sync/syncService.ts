import { IdentitySource, Prisma, PrismaClient, SyncRunStatus, SyncTrigger } from '@prisma/client';
import { prisma as defaultClient } from '../../config/database';
import { env } from '../../config/env';
import { DblpClient } from '../../integrations/dblp/client';
import { FetchError } from '../../integrations/http/httpClient';
import { OpenAlexClient } from '../../integrations/openalex/client';
import { OrcidClient } from '../../integrations/orcid/client';
import { HttpError } from '../../utils/httpError';
import { discoverDblpIdentity } from '../discovery/dblpDiscovery';
import { discoverOpenAlexIdentity } from '../discovery/openAlexDiscovery';
import { discoverOrcidIdentity } from '../discovery/orcidDiscovery';
import { DiscoveryPreconditionError } from '../discovery/discoveryIdentity';
import type { DiscoverySummary } from '../discovery/ingestDiscoveredRecords';

/**
 * Synchronization engine (Project_plan.md §14, Phase 12; decisions #81–#85). Independent of the
 * scheduler: manual triggers and node-cron call the same `start`.
 *
 *   SyncRun (RUNNING) → one SyncTask per active identity of an active professor
 *   → per task, sequentially: the existing discovery service (validate identity → fetch everything
 *     → validate → normalize → match → write) → SUCCESS with counters, or FAILED with a safe message
 *   → run SUCCESS (no task failed), PARTIAL_SUCCESS (some failed), FAILED (all failed)
 *
 * A failed or incomplete fetch writes nothing (the discovery services fetch and validate before
 * writing) and never deletes or unlinks anything. Retries are those of the source HTTP clients
 * (backoff, Retry-After); a failed task is retried by the next run (#83). Only one run at a time
 * per process, also checked against RUNNING rows in the database (#82).
 *
 * Administrator merge/detach operations (Phase 13B, #91) run through `exclusive`: they are refused
 * while a run executes, run one at a time, and a run started meanwhile waits until they finish.
 */

export interface SyncClients {
  openAlex: OpenAlexClient;
  dblp: DblpClient;
  orcid: OrcidClient;
}

export function createSyncClients(): SyncClients {
  return { openAlex: new OpenAlexClient({ apiKey: env.openAlexApiKey }), dblp: new DblpClient(), orcid: new OrcidClient() };
}

export interface SyncServiceOptions {
  clients: SyncClients;
  now: () => Date;
  client?: PrismaClient;
}

const MESSAGE_LIMIT = 500;

export class SyncAlreadyRunningError extends HttpError {
  constructor() {
    super(409, 'SYNC_ALREADY_RUNNING', 'A synchronization run is already in progress');
  }
}

export class SyncService {
  private readonly client: PrismaClient;
  private current: Promise<void> | null = null;
  /** Settles when every queued `exclusive` operation has finished; never rejects. */
  private exclusiveQueue: Promise<void> = Promise.resolve();

  constructor(private readonly options: SyncServiceOptions) {
    this.client = options.client ?? defaultClient;
  }

  /** True while a run started by this process is executing. */
  get running(): boolean {
    return this.current !== null;
  }

  /** Resolves when the run in progress (if any) has finished. */
  async idle(): Promise<void> {
    await this.current;
  }

  /**
   * Starts a run and returns it immediately; tasks execute in the background (`idle()` awaits
   * them). Refuses with SYNC_ALREADY_RUNNING while another run is executing.
   */
  async start(trigger: SyncTrigger, triggeredByUserId: string | null = null) {
    // The in-process guard is taken synchronously, before any await, so two starts cannot both pass.
    if (this.current) throw new SyncAlreadyRunningError();
    let release!: () => void;
    this.current = new Promise<void>((resolve) => (release = resolve));
    try {
      // Administrator operations already in progress finish first; new ones are refused from now on.
      await this.exclusiveQueue;
      // A RUNNING row not owned by this process (another instance, or a run interrupted without
      // the startup recovery) also blocks a new run.
      if (await this.client.syncRun.findFirst({ where: { status: 'RUNNING' }, select: { id: true } })) {
        throw new SyncAlreadyRunningError();
      }
      const identities = await this.client.externalIdentity.findMany({
        where: { isActive: true, professor: { isActive: true } },
        select: { id: true, source: true },
        orderBy: [{ professorId: 'asc' }, { source: 'asc' }, { externalId: 'asc' }],
      });
      const run = await this.client.syncRun.create({
        data: {
          trigger,
          triggeredByUserId,
          status: 'RUNNING',
          startedAt: this.options.now(),
          tasksTotal: identities.length,
          tasks: { create: identities.map((i) => ({ identityId: i.id, source: i.source, status: 'PENDING' as const })) },
        },
      });
      void this.execute(run.id).finally(() => {
        this.current = null;
        release();
      });
      return run;
    } catch (error) {
      this.current = null;
      release();
      throw error;
    }
  }

  /**
   * Runs `operation` while no synchronization run can execute (#91): refused with
   * SYNC_ALREADY_RUNNING while a run executes (in this process or as a RUNNING row), serialized
   * with other exclusive operations, and a run started meanwhile waits until it has finished. The
   * check and the operation cannot be separated by a run start, because `start` takes its guard
   * synchronously and then waits for this queue.
   */
  async exclusive<T>(operation: () => Promise<T>): Promise<T> {
    if (this.current) throw new SyncAlreadyRunningError();
    const previous = this.exclusiveQueue;
    let finished!: () => void;
    const done = new Promise<void>((resolve) => (finished = resolve));
    this.exclusiveQueue = previous.then(() => done);
    await previous;
    try {
      // A run may have been started while this operation waited behind another one.
      if (this.current) throw new SyncAlreadyRunningError();
      if (await this.client.syncRun.findFirst({ where: { status: 'RUNNING' }, select: { id: true } })) {
        throw new SyncAlreadyRunningError();
      }
      return await operation();
    } finally {
      finished();
    }
  }

  /** Runs the tasks one after another, then sets the run outcome. Never throws. */
  private async execute(runId: string): Promise<void> {
    try {
      // Deterministic order: professor, source, external ID (PostgreSQL sorts a removed identity's NULL last).
      const tasks = await this.client.syncTask.findMany({
        where: { syncRunId: runId, status: 'PENDING' },
        select: { id: true, identityId: true, source: true },
        orderBy: [
          { identity: { professorId: 'asc' } },
          { identity: { source: 'asc' } },
          { identity: { externalId: 'asc' } },
          { id: 'asc' },
        ],
      });

      for (const task of tasks) await this.runTask(task);
      await this.finishRun(runId);
    } catch (error) {
      // The original error is logged first; a failure to record it is logged separately and never
      // replaces it. If even that fails, the run stays RUNNING and startup recovery closes it.
      console.error(`Synchronization run ${runId} stopped unexpectedly (${describeFailure(error)})`);
      try {
        await closeFailedRun(this.client, runId, this.options.now(), 'Not completed: the synchronization run stopped unexpectedly');
      } catch (closeError) {
        console.error(`Synchronization run ${runId} could not be marked FAILED (${describeFailure(closeError)})`);
      }
    }
  }

  private async runTask(task: { id: string; identityId: string | null; source: IdentitySource }): Promise<void> {
    await this.client.syncTask.update({ where: { id: task.id }, data: { status: 'RUNNING', startedAt: this.options.now() } });
    if (!task.identityId) {
      await this.failTask(task.id, 'The identity was removed before its task ran');
      return;
    }
    try {
      const summary = await this.discover(task.source, task.identityId);
      await this.client.syncTask.update({
        where: { id: task.id },
        data: {
          status: 'SUCCESS',
          recordsFetched: summary.recordsFetched,
          recordsNew: summary.recordsNew,
          recordsUpdated: summary.recordsUpdated,
          linksCreated: summary.linksCreated,
          candidatesCreated: summary.candidatesCreated,
          warnings: summary.warnings.length,
          finishedAt: this.options.now(),
        },
      });
    } catch (error) {
      if (!(error instanceof DiscoveryPreconditionError) && !(error instanceof FetchError)) {
        console.error(`Synchronization task ${task.id} failed (${describeFailure(error)})`);
      }
      await this.failTask(task.id, describeFailure(error));
    } finally {
      await this.reconcileDeactivatedIdentity(task.identityId);
    }
  }

  private discover(source: IdentitySource, identityId: string): Promise<DiscoverySummary> {
    const { clients, now } = this.options;
    const client = this.client;
    if (source === 'OPENALEX') return discoverOpenAlexIdentity(identityId, { client, openAlex: clients.openAlex, now });
    if (source === 'DBLP') return discoverDblpIdentity(identityId, { client, dblp: clients.dblp, now });
    return discoverOrcidIdentity(identityId, { client, orcid: clients.orcid, now });
  }

  private async failTask(taskId: string, message: string): Promise<void> {
    await this.client.syncTask.update({
      where: { id: taskId },
      data: { status: 'FAILED', errorMessage: message.slice(0, MESSAGE_LIMIT), finishedAt: this.options.now() },
    });
  }

  /**
   * An identity deactivated while its task was running may have gained PENDING links after the
   * administrator's §12.4 cleanup; they are removed again so the cleanup holds (#85).
   */
  private async reconcileDeactivatedIdentity(identityId: string | null): Promise<void> {
    if (!identityId) return;
    const identity = await this.client.externalIdentity.findUnique({ where: { id: identityId }, select: { isActive: true } });
    if (identity && !identity.isActive) {
      await this.client.professorPublication.deleteMany({ where: { discoveredViaIdentityId: identityId, status: 'PENDING' } });
    }
  }

  private async finishRun(runId: string): Promise<void> {
    const summary = await summarizeTasks(this.client, runId);
    const status: SyncRunStatus = summary.tasksFailed === 0 ? 'SUCCESS' : summary.tasksSucceeded === 0 ? 'FAILED' : 'PARTIAL_SUCCESS';
    await this.client.syncRun.update({ where: { id: runId }, data: { status, ...summary, finishedAt: this.options.now() } });
  }
}

type Db = PrismaClient | Prisma.TransactionClient;

/** Run counters derived from its tasks: task outcomes and summed record counters. */
async function summarizeTasks(db: Db, runId: string) {
  const tasks = await db.syncTask.findMany({ where: { syncRunId: runId } });
  const sum = (key: 'recordsFetched' | 'recordsNew' | 'recordsUpdated' | 'linksCreated' | 'candidatesCreated') =>
    tasks.reduce((n, t) => n + t[key], 0);
  return {
    tasksSucceeded: tasks.filter((t) => t.status === 'SUCCESS').length,
    tasksFailed: tasks.filter((t) => t.status === 'FAILED').length,
    recordsFetched: sum('recordsFetched'),
    recordsNew: sum('recordsNew'),
    recordsUpdated: sum('recordsUpdated'),
    linksCreated: sum('linksCreated'),
    candidatesCreated: sum('candidatesCreated'),
  };
}

/**
 * Closes a run that cannot finish normally, in one transaction: its unfinished (PENDING/RUNNING)
 * tasks become FAILED with `message`, completed tasks are left as they are, and the run becomes
 * FAILED with counters recomputed from its tasks. Publications and relationships are not touched.
 */
async function closeFailedRun(client: PrismaClient, runId: string, now: Date, message: string): Promise<void> {
  await client.$transaction((tx) => closeFailedRunIn(tx, runId, now, message));
}

async function closeFailedRunIn(tx: Prisma.TransactionClient, runId: string, now: Date, message: string): Promise<void> {
  await tx.syncTask.updateMany({
    where: { syncRunId: runId, status: { in: ['PENDING', 'RUNNING'] } },
    data: { status: 'FAILED', errorMessage: message, finishedAt: now },
  });
  await tx.syncRun.update({ where: { id: runId }, data: { status: 'FAILED', ...(await summarizeTasks(tx, runId)), finishedAt: now } });
}

/**
 * Runs left RUNNING by a crash or restart are marked FAILED at startup, with their unfinished
 * tasks (§14). Returns the number of runs recovered.
 */
export async function recoverInterruptedRuns(now: Date, client: PrismaClient = defaultClient): Promise<number> {
  return client.$transaction(async (tx) => {
    const runs = await tx.syncRun.findMany({ where: { status: 'RUNNING' }, select: { id: true } });
    for (const run of runs) {
      await closeFailedRunIn(tx, run.id, now, 'Interrupted: the backend stopped before this task finished');
    }
    return runs.length;
  });
}

/** A failure message safe for administrators: our own messages, error codes, no internals. */
export function describeFailure(error: unknown): string {
  if (error instanceof DiscoveryPreconditionError) return error.message;
  if (error instanceof FetchError) return `${error.kind}: ${error.message}`;
  if (error instanceof Prisma.PrismaClientKnownRequestError) return `Database error while writing records (Prisma ${error.code})`;
  if (error instanceof Prisma.PrismaClientUnknownRequestError || error instanceof Prisma.PrismaClientInitializationError) {
    return 'Database error while writing records';
  }
  return 'Unexpected error';
}
