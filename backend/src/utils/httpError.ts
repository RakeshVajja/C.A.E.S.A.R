/**
 * An error that maps directly to an HTTP response in the standard error shape:
 * { error: { code, message, details? } }
 */
export class HttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}
