import { NextFunction, Request, Response } from 'express';
import { env } from '../config/env';
import { HttpError } from '../utils/httpError';

export interface ErrorBody {
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
}

export function notFoundHandler(req: Request, res: Response<ErrorBody>): void {
  res.status(404).json({
    error: { code: 'NOT_FOUND', message: `Route ${req.method} ${req.path} not found` },
  });
}

// Express recognises error handlers by their four-argument signature, so `next` must stay.
export function errorHandler(err: unknown, req: Request, res: Response<ErrorBody>, next: NextFunction): void {
  if (err instanceof HttpError) {
    res.status(err.status).json({
      error: { code: err.code, message: err.message, ...(err.details !== undefined && { details: err.details }) },
    });
    return;
  }

  // Client errors raised by Express middleware (e.g. malformed JSON bodies) carry a 4xx status.
  const status = (err as { status?: unknown })?.status;
  if (typeof status === 'number' && status >= 400 && status < 500) {
    res.status(status).json({
      error: { code: 'BAD_REQUEST', message: (err as Error).message || 'Bad request' },
    });
    return;
  }

  console.error('Unhandled server error:', err);
  res.status(500).json({
    error: {
      code: 'INTERNAL_ERROR',
      message: 'Internal server error',
      ...(env.nodeEnv === 'development' && err instanceof Error && { details: err.message }),
    },
  });
}
