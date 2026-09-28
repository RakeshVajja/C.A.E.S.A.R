import { createApp } from './app';
import { connectDatabase, disconnectDatabase } from './config/database';
import { env } from './config/env';

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

  const server = createApp().listen(env.port, () => {
    console.log(`CSE_Research_Hub backend listening on http://localhost:${env.port} (${env.nodeEnv})`);
  });

  let shuttingDown = false;
  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`${signal} received, shutting down`);
    server.close(async () => {
      await disconnectDatabase();
      process.exit(0);
    });
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

startServer();
