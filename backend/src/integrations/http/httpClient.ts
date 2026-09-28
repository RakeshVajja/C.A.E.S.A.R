/**
 * Shared HTTP helper for external sources (Project_plan.md §13.1, §13.2).
 *
 * - native fetch, per-request timeout;
 * - retries with exponential backoff + jitter on 429, 5xx, network errors and timeouts,
 *   honouring Retry-After; never retries other 4xx;
 * - per-source throttling (minimum interval between requests, one request at a time);
 * - HTTP 200 is not success: the content type and body are validated, and HTML
 *   (e.g. bot-protection pages) or unparseable bodies are fetch failures.
 */

export type FetchErrorKind =
  | 'NETWORK'
  | 'TIMEOUT'
  | 'HTTP_STATUS'
  | 'CONTENT_TYPE'
  | 'MALFORMED_BODY'
  | 'INVALID_RESPONSE'
  | 'IDENTITY_NOT_FOUND'
  | 'INCOMPLETE';

/** Any failure to obtain a complete, valid response. Never to be read as "no publications". */
export class FetchError extends Error {
  constructor(
    public readonly kind: FetchErrorKind,
    message: string,
    public readonly details: { url?: string; status?: number } = {},
  ) {
    super(message);
    this.name = 'FetchError';
  }
}

export interface SourceHttpConfig {
  /** Source name used in error messages. */
  name: string;
  /** Minimum time between the start of two requests to this source. */
  minIntervalMs: number;
  /** Per-request timeout. */
  timeoutMs: number;
  /** Retries after the first attempt. */
  maxRetries: number;
  /** First backoff delay; doubled on each retry, plus up to 50% jitter. */
  baseDelayMs: number;
  /** Upper bound for any single wait, including Retry-After. */
  maxDelayMs: number;
}

export interface HttpDependencies {
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  random?: () => number;
}

export interface JsonResponse {
  status: number;
  /** Final URL after redirects. */
  url: string;
  redirected: boolean;
  body: unknown;
}

export interface JsonRequestOptions {
  headers?: Record<string, string>;
  /** Statuses returned to the caller instead of raising (e.g. 404 for identity checks). */
  passThroughStatuses?: readonly number[];
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export class SourceHttpClient {
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private readonly random: () => number;
  private queue: Promise<unknown> = Promise.resolve();
  private lastRequestAt = Number.NEGATIVE_INFINITY;

  constructor(
    private readonly config: SourceHttpConfig,
    deps: HttpDependencies = {},
  ) {
    this.fetchImpl = deps.fetchImpl ?? fetch;
    this.sleep = deps.sleep ?? defaultSleep;
    this.now = deps.now ?? Date.now;
    this.random = deps.random ?? Math.random;
  }

  /** GET a JSON document. Requests to one source run one at a time. */
  getJson(url: string, options: JsonRequestOptions = {}): Promise<JsonResponse> {
    const result = this.queue.then(() => this.getJsonWithRetries(url, options));
    this.queue = result.catch(() => undefined);
    return result;
  }

  private async getJsonWithRetries(url: string, options: JsonRequestOptions): Promise<JsonResponse> {
    for (let attempt = 0; ; attempt++) {
      const outcome = await this.attempt(url, options);
      if (outcome.kind === 'done') return outcome.response;
      if (outcome.kind === 'fail' || attempt >= this.config.maxRetries) throw outcome.error;
      await this.sleep(this.backoffDelay(attempt, outcome.retryAfterMs));
    }
  }

  private async attempt(
    url: string,
    options: JsonRequestOptions,
  ): Promise<
    | { kind: 'done'; response: JsonResponse }
    | { kind: 'retry'; error: FetchError; retryAfterMs?: number }
    | { kind: 'fail'; error: FetchError }
  > {
    await this.throttle();
    const { name } = this.config;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.timeoutMs);
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        headers: { Accept: 'application/json', ...options.headers },
        signal: controller.signal,
        redirect: 'follow',
      });
    } catch (error) {
      clearTimeout(timer);
      const timedOut = controller.signal.aborted;
      return {
        kind: 'retry',
        error: new FetchError(
          timedOut ? 'TIMEOUT' : 'NETWORK',
          timedOut
            ? `${name}: request timed out after ${this.config.timeoutMs} ms`
            : `${name}: network error (${(error as Error).message})`,
          { url },
        ),
      };
    }

    let text: string;
    try {
      text = await response.text();
    } catch (error) {
      clearTimeout(timer);
      return {
        kind: 'retry',
        error: new FetchError('NETWORK', `${name}: failed to read response body (${(error as Error).message})`, { url }),
      };
    }
    clearTimeout(timer);

    const status = response.status;
    if (status === 429 || status >= 500) {
      return {
        kind: 'retry',
        error: new FetchError('HTTP_STATUS', `${name}: HTTP ${status}`, { url, status }),
        retryAfterMs: parseRetryAfter(response.headers.get('retry-after'), this.now()),
      };
    }
    if (status >= 300 && !options.passThroughStatuses?.includes(status)) {
      return {
        kind: 'fail',
        error: new FetchError('HTTP_STATUS', `${name}: HTTP ${status}${describeErrorBody(text)}`, { url, status }),
      };
    }
    if (options.passThroughStatuses?.includes(status)) {
      return { kind: 'done', response: { status, url: response.url || url, redirected: response.redirected, body: null } };
    }

    // HTTP 2xx: the content must really be JSON.
    const contentType = response.headers.get('content-type') ?? '';
    if (!/\bjson\b/i.test(contentType) || looksLikeHtml(text)) {
      return {
        kind: 'fail',
        error: new FetchError(
          'CONTENT_TYPE',
          `${name}: expected JSON but received "${contentType || 'no content type'}"${looksLikeHtml(text) ? ' (HTML page)' : ''}`,
          { url, status },
        ),
      };
    }
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      return { kind: 'fail', error: new FetchError('MALFORMED_BODY', `${name}: response body is not valid JSON`, { url, status }) };
    }

    return { kind: 'done', response: { status, url: response.url || url, redirected: response.redirected, body } };
  }

  private async throttle(): Promise<void> {
    const wait = this.lastRequestAt + this.config.minIntervalMs - this.now();
    if (wait > 0) await this.sleep(wait);
    this.lastRequestAt = this.now();
  }

  private backoffDelay(attempt: number, retryAfterMs?: number): number {
    if (retryAfterMs !== undefined) return Math.min(retryAfterMs, this.config.maxDelayMs);
    const exponential = this.config.baseDelayMs * 2 ** attempt;
    const jitter = exponential * 0.5 * this.random();
    return Math.min(exponential + jitter, this.config.maxDelayMs);
  }
}

/** Retry-After is either delay-seconds or an HTTP date. */
export function parseRetryAfter(value: string | null, now: number): number | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1000;
  const date = Date.parse(trimmed);
  return Number.isNaN(date) ? undefined : Math.max(0, date - now);
}

function looksLikeHtml(text: string): boolean {
  return /^\s*(<!doctype html|<html[\s>])/i.test(text);
}

function describeErrorBody(text: string): string {
  if (looksLikeHtml(text)) return ' (HTML page)';
  try {
    const parsed = JSON.parse(text) as { message?: unknown; error?: unknown };
    const message = parsed.message ?? parsed.error;
    return typeof message === 'string' ? `: ${message}` : '';
  } catch {
    return '';
  }
}
