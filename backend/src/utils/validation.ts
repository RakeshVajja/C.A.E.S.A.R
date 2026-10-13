import { z } from 'zod';
import { HttpError } from './httpError';

/**
 * Validates a request body with Zod (Project_plan.md §15.3). Errors list field paths and rules
 * only — never the submitted values, which may be passwords or codes. A missing or non-JSON body
 * fails validation, so form posts from other sites cannot drive these endpoints.
 */
export function parseBody<T extends z.ZodType>(schema: T, body: unknown): z.infer<T> {
  const result = schema.safeParse(body);
  if (!result.success) {
    throw new HttpError(
      400,
      'VALIDATION_ERROR',
      'Invalid request body',
      result.error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })),
    );
  }
  return result.data;
}
