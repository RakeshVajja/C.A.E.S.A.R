import { NextFunction, Request, RequestHandler, Response } from 'express';
import { HttpError } from '../utils/httpError';

/**
 * Refuses state-changing requests sent by a browser from another origin (Project_plan.md §15.2,
 * decision #62). Browsers send an Origin header with cross-origin and POST requests; when it is
 * present it must be the configured frontend origin (CORS_ORIGIN). Requests without Origin
 * (non-browser clients such as curl or scripts) are not affected. This is in addition to the
 * SameSite=Lax cookies and the JSON-only request bodies; CORS alone is not relied on.
 */

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export function requireAllowedOrigin(allowedOrigin: string): RequestHandler {
  const allowed = new URL(allowedOrigin).origin;
  return (req: Request, res: Response, next: NextFunction) => {
    if (!SAFE_METHODS.has(req.method)) {
      const origin = req.get('origin');
      if (origin !== undefined && origin !== allowed) {
        throw new HttpError(403, 'ORIGIN_NOT_ALLOWED', 'Requests from this origin are not allowed');
      }
    }
    next();
  };
}
