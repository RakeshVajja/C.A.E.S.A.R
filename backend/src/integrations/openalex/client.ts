import type { z } from 'zod';
import { FetchError, HttpDependencies, SourceHttpClient, SourceHttpConfig } from '../http/httpClient';
import {
  OpenAlexAuthor,
  OpenAlexAuthorSchema,
  OpenAlexWork,
  OpenAlexWorkSchema,
  OpenAlexWorksPageSchema,
} from './types';

/**
 * OpenAlex client (Project_plan.md §13.3):
 *  - validates the author identity via /authors/{id} before fetching works;
 *  - fetches works with filter=author.id, cursor pagination and per-page=100;
 *  - selects only the fields the integration needs (no abstracts, references or full text);
 *  - validates every response; any problem is a FetchError, never "zero works".
 */

export const OPENALEX_BASE_URL = 'https://api.openalex.org';

/** Root-level work fields requested with select= (everything the mapper and raw_metadata need). */
export const OPENALEX_WORK_FIELDS = [
  'id',
  'doi',
  'ids',
  'title',
  'display_name',
  'publication_year',
  'type',
  'primary_location',
  'authorships',
] as const;

const OPENALEX_AUTHOR_FIELDS = ['id', 'display_name', 'orcid', 'works_count'] as const;

export const OPENALEX_HTTP_CONFIG: SourceHttpConfig = {
  name: 'OpenAlex',
  minIntervalMs: 200, // ~5 requests/s, far below the 100 requests/s limit
  timeoutMs: 30_000,
  maxRetries: 3,
  baseDelayMs: 1_000,
  maxDelayMs: 60_000,
};

export interface OpenAlexClientOptions {
  apiKey?: string | null;
  baseUrl?: string;
  perPage?: number;
  /** Safety bound against a cursor that never ends. */
  maxPages?: number;
  http?: Partial<SourceHttpConfig>;
  deps?: HttpDependencies;
}

export interface ValidatedAuthor {
  /** The ID requested (normalized). */
  requestedId: string;
  /** The ID OpenAlex answered with; differs from requestedId when the author was merged. */
  authorId: string;
  merged: boolean;
  displayName: string | null;
}

export interface OpenAlexFetchResult {
  author: ValidatedAuthor;
  works: OpenAlexWork[];
  /** meta.count reported by OpenAlex for the works query. */
  reportedCount: number;
}

/** Accepts "A123", "a123" or "https://openalex.org/A123"; returns "A123". */
export function normalizeOpenAlexAuthorId(value: string): string {
  const match = /^(?:https?:\/\/openalex\.org\/)?([aA]\d+)$/.exec(value.trim());
  if (!match) throw new FetchError('INVALID_RESPONSE', `"${value}" is not a valid OpenAlex author ID`);
  return match[1].toUpperCase();
}

/** "https://openalex.org/W123" → "W123". */
export function shortOpenAlexId(url: string): string {
  return url.slice(url.lastIndexOf('/') + 1).toUpperCase();
}

export class OpenAlexClient {
  private readonly http: SourceHttpClient;
  private readonly baseUrl: string;
  private readonly perPage: number;
  private readonly maxPages: number;
  private readonly headers: Record<string, string>;

  constructor(options: OpenAlexClientOptions = {}) {
    this.http = new SourceHttpClient({ ...OPENALEX_HTTP_CONFIG, ...options.http }, options.deps);
    this.baseUrl = options.baseUrl ?? OPENALEX_BASE_URL;
    this.perPage = options.perPage ?? 100;
    this.maxPages = options.maxPages ?? 500;
    this.headers = options.apiKey ? { Authorization: `Bearer ${options.apiKey}` } : {};
  }

  /** Validates the author ID. A nonexistent ID is a failure, never an empty author. */
  async validateAuthor(externalId: string): Promise<ValidatedAuthor> {
    const requestedId = normalizeOpenAlexAuthorId(externalId);
    const url = `${this.baseUrl}/authors/${requestedId}?select=${OPENALEX_AUTHOR_FIELDS.join(',')}`;
    const response = await this.http.getJson(url, { headers: this.headers, passThroughStatuses: [404] });

    if (response.status === 404) {
      throw new FetchError('IDENTITY_NOT_FOUND', `OpenAlex author ${requestedId} does not exist`, { url, status: 404 });
    }
    const author: OpenAlexAuthor = parse(OpenAlexAuthorSchema, response.body, `author ${requestedId}`, url);
    const authorId = shortOpenAlexId(author.id);
    return { requestedId, authorId, merged: authorId !== requestedId, displayName: author.display_name ?? null };
  }

  /** Fetches every work of a validated author, following the cursor to the end. */
  async fetchWorks(authorId: string): Promise<{ works: OpenAlexWork[]; reportedCount: number }> {
    const works: OpenAlexWork[] = [];
    let cursor: string | null = '*';
    let reportedCount = -1;

    for (let page = 1; cursor !== null; page++) {
      if (page > this.maxPages) {
        throw new FetchError('INCOMPLETE', `OpenAlex: more than ${this.maxPages} pages for ${authorId}; stopping`);
      }
      const url: string =
        `${this.baseUrl}/works?filter=author.id:${authorId}&per-page=${this.perPage}` +
        `&cursor=${encodeURIComponent(cursor)}&select=${OPENALEX_WORK_FIELDS.join(',')}`;
      const response = await this.http.getJson(url, { headers: this.headers });
      const body: z.infer<typeof OpenAlexWorksPageSchema> = parse(OpenAlexWorksPageSchema, response.body, `works page ${page} of ${authorId}`, url);

      if (reportedCount < 0) reportedCount = body.meta.count;
      for (const [index, item] of body.results.entries()) {
        works.push(parse(OpenAlexWorkSchema, item, `work ${index + 1} on page ${page} of ${authorId}`, url));
      }

      const next: string | null = body.meta.next_cursor ?? null;
      cursor = next && body.results.length > 0 ? next : null;
    }

    // Cursor paging must deliver everything OpenAlex reported; anything less is an incomplete fetch.
    if (works.length < reportedCount) {
      throw new FetchError(
        'INCOMPLETE',
        `OpenAlex reported ${reportedCount} works for ${authorId} but paging returned ${works.length}`,
      );
    }
    return { works, reportedCount };
  }

  /** Identity validation followed by the complete works fetch (fetch-then-write, §14). */
  async fetchAuthorWorks(externalId: string): Promise<OpenAlexFetchResult> {
    const author = await this.validateAuthor(externalId);
    // A merged-away ID matches no works; always page with the ID OpenAlex resolved it to.
    const { works, reportedCount } = await this.fetchWorks(author.authorId);
    return { author, works, reportedCount };
  }
}

function parse<T extends z.ZodType>(schema: T, body: unknown, what: string, url: string): z.infer<T> {
  if (body !== null && typeof body === 'object' && !Array.isArray(body) && 'error' in body) {
    const message = (body as { message?: unknown; error?: unknown }).message ?? (body as { error?: unknown }).error;
    throw new FetchError('INVALID_RESPONSE', `OpenAlex returned an error payload for ${what}: ${String(message)}`, { url });
  }
  const result = schema.safeParse(body);
  if (!result.success) {
    const issue = result.error.issues[0];
    throw new FetchError(
      'INVALID_RESPONSE',
      `OpenAlex returned an invalid ${what}: ${issue.path.join('.') || '(root)'} ${issue.message}`,
      { url },
    );
  }
  return result.data;
}
