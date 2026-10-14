import { createApp } from './app';
import { connectDatabase, disconnectDatabase } from './config/database';
import { env } from './config/env';
import { startSyncScheduler } from './services/sync/scheduler';
import { createSyncClients, recoverInterruptedRuns, SyncService } from './services/sync/syncService';

async function startServer(): Promise<void> {
  try {
    await connectDatabase();
  } catch (error) {
    console.error('Failed to connect to PostgreSQL:', error);
    process.exit(1);
  }

  if (!env.openAlexApiKey && env.nodeEnv !== 'test') {
    console.warn('OPENALEX_API_KEY is not set: OpenAlex requests will use the smaller keyless budget');
  }
  if (!env.smtp && env.nodeEnv !== 'test') {
    console.warn('SMTP is not configured: professor password recovery is unavailable');
  }

  // Runs left RUNNING by a crash or restart are marked failed before anything else (§14).
  const recovered = await recoverInterruptedRuns(new Date());
  if (recovered > 0) console.warn(`Marked ${recovered} interrupted synchronization run(s) as FAILED`);

  // One synchronization engine per process, shared by the admin trigger and the monthly schedule.
  const sync = new SyncService({ clients: createSyncClients(), now: () => new Date() });
  const scheduler = env.nodeEnv === 'test' ? null : startSyncScheduler(sync, { cronExpression: env.syncCron, timezone: env.syncTimezone });
  if (scheduler) console.log(`Monthly synchronization scheduled: "${env.syncCron}" (${env.syncTimezone})`);

  const server = createApp({ sync }).listen(env.port, () => {
    console.log(`CSE_Research_Hub backend listening on http://localhost:${env.port} (${env.nodeEnv})`);
  });

  let shuttingDown = false;
  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`${signal} received, shutting down`);
    void scheduler?.stop().catch(() => undefined);
    server.close(() => {
      disconnectDatabase().then(
        () => process.exit(0),
        (error: unknown) => {
          console.error('Failed to disconnect from PostgreSQL:', error);
          process.exit(1);
        },
      );
    });
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

startServer().catch((error: unknown) => {
  console.error('Failed to start server:', error);
  process.exit(1);
});
