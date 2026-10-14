import cron from 'node-cron';
import { describeFailure, SyncAlreadyRunningError, SyncService } from './syncService';

/**
 * Monthly synchronization schedule (Project_plan.md §14, decision #81). node-cron only decides
 * *when*; the run itself is the same `SyncService.start` the administrator triggers manually.
 * A tick while a run is in progress is skipped (single-run guard); there is no catch-up run at
 * startup (§20, decided as not needed).
 */

export interface SchedulerOptions {
  cronExpression: string;
  timezone: string;
  /** Injected in tests; defaults to node-cron. */
  schedule?: typeof cron.schedule;
}

export type ScheduledOutcome = 'started' | 'skipped' | 'failed';

/** What a scheduled tick does; never throws. */
export async function runScheduledSync(service: SyncService): Promise<ScheduledOutcome> {
  try {
    const run = await service.start('SCHEDULED', null);
    console.log(`Scheduled synchronization started (run ${run.id}, ${run.tasksTotal} identities)`);
    return 'started';
  } catch (error) {
    if (error instanceof SyncAlreadyRunningError) {
      console.warn('Scheduled synchronization skipped: a run is already in progress');
      return 'skipped';
    }
    console.error(`Scheduled synchronization could not start (${describeFailure(error)})`);
    return 'failed';
  }
}

export function startSyncScheduler(service: SyncService, options: SchedulerOptions): { stop: () => Promise<void> } {
  const schedule = options.schedule ?? cron.schedule;
  const task = schedule(options.cronExpression, () => runScheduledSync(service), {
    name: 'monthly-synchronization',
    timezone: options.timezone,
    noOverlap: true,
  });
  return { stop: async () => void (await task.stop()) };
}
