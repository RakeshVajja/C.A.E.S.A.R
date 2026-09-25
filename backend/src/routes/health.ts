import { Router } from 'express';
import { prisma } from '../config/database';
import { env } from '../config/env';

export const healthRouter = Router();

healthRouter.get('/', async (req, res) => {
  const timestamp = new Date().toISOString();

  try {
    const startTime = Date.now();
    await prisma.$queryRaw`SELECT 1`;

    res.status(200).json({
      status: 'ok',
      service: 'CSE_Research_Hub backend',
      environment: env.nodeEnv,
      database: { status: 'connected', latencyMs: Date.now() - startTime },
      timestamp,
    });
  } catch (error) {
    console.error('Health check: database unreachable:', error);
    res.status(503).json({
      status: 'error',
      service: 'CSE_Research_Hub backend',
      environment: env.nodeEnv,
      database: {
        status: 'disconnected',
        // Raw database errors are only exposed while developing locally.
        ...(env.nodeEnv === 'development' && { error: (error as Error).message }),
      },
      timestamp,
    });
  }
});
