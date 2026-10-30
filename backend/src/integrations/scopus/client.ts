import type { z } from 'zod';
import { FetchError, HttpDependencies, JsonRequestOptions, SourceHttpClient, SourceHttpConfig } from '../http/httpClient';
import { ScopusAuthorResponseSchema, ScopusCursorPageSchema, ScopusSearchEntry, ScopusSearchEntrySchema, ScopusSearchPageSchema } from './types';

/**
 * Elsevier Scopus client (Project_plan.md §13.6, §13.9; Phase 15.3):
 *  - authenticates with `X-ELS-APIKey` and, when configured, `X-ELS-Insttoken` — headers only,
 *    never in URLs; credentials never appear in errors or logs;
 *  - validates the author identity with the Author Retrieval API (LIGHT view) before fetching;
 *    a replaced (merged) profile — HTTP 300/301 — is never followed or transferred;
 *  - fetches every document with the Scopus Search API, `query=AU-ID(<id>)`, STANDARD view,
 *    offset paging (`start`/`count`) in a fixed order (SCOPUS_SEARCH_SORT); an author with more
 *    results than offset paging can reach is fetched again with cursor pagination (fetchByCursor);
 *    the result must contain as many distinct documents as `opensearch:totalResults`, otherwise
 *    the fetch is INCOMPLETE;
 *  - classifies 401 → AUTH_FAILED, 403 → NOT_ENTITLED, 429 → QUOTA_EXCEEDED; an exhausted weekly
 *    quota (`X-ELS-Status: QUOTA_EXCEEDED`) is not retried, other 429s are retried by the shared
 *    client (honouring Retry-After);
 *  - every failure message is fixed text plus validated values (IDs, counts, statuses): no Scopus
 *    response body, header or free-text field is ever copied into an error, a task or a log.
 * Built against Elsevier's published documentation and synthetic fixtures only; it has not been run
 * against the live API (no confirmed institutional entitlement yet, §22.6 stage 15.9).
 */

export const SCOPUS_BASE_URL = 'https://api.elsevier.com';

/**
 * Elsevier's documented limit for offset paging: "5000 item total result limit without 'cursor
 * pagination'" (API key settings; Getting Started guide V1, 2023-09-07, p. 11). Authors beyond it
 * are fetched with cursor pagination (fetchByCursor); if that is refused or ends early, the fetch
 * fails as INCOMPLETE and nothing is written.
 */
export const SCOPUS_OFFSET_LIMIT = 5_000;

/**
 * Deterministic result order for offset paging, ascending (an unprefixed field sorts DESCENDING
 * per the Search API reference): date of first accession into Scopus, then cover date. Documents
 * newly loaded during a fetch sort after those already paged, so earlier pages do not shift. No
 * unique identifier is a documented sort field, so ties may still be ordered differently between
 * requests; the distinct-document and result-count checks turn any resulting gap into INCOMPLETE.
 */
export const SCOPUS_SEARCH_SORT = '+orig-load-date,+coverDate';

export const SCOPUS_HTTP_CONFIG: SourceHttpConfig = {
  name: 'Scopus',
  // Author Retrieval allows 3 requests/s and Scopus Search 9/s; one request at a time, ≤ ~3/s.
  minIntervalMs: 350,
  timeoutMs: 30_000,
  maxRetries: 3,
  baseDelayMs: 1_000,
  maxDelayMs: 60_000,
};

/** Upper bound on an opaque cursor value (an application safety limit, not an Elsevier rule). */
const CURSOR_MAX_LENGTH = 2_048;

export interface ScopusClientOptions {
  apiKey: string;
  /** Offset-paging limit; Elsevier's 5,000 by default (smaller only in tests). */
  offsetLimit?: number;
  instToken?: string | null;
  baseUrl?: string;
  /** Results per Search API page; the STANDARD view allows up to 200. */
  perPage?: number;
  http?: Partial<SourceHttpConfig>;
  deps?: HttpDependencies;
}

export interface ScopusAuthor {
  authorId: string;
  /** "Given Surname" from the preferred name, when Scopus provides it. */
  name: string | null;
  documentCount: number | null;
  profileUrl: string;
}

export interface ScopusFetchResult {
  author: ScopusAuthor;
  documents: ScopusSearchEntry[];
  reportedCount: number;
}

/**
 * Scopus Author IDs are numeric strings; Elsevier publishes no length (the Author Retrieval API
 * types author_id as a plain string). The 20-digit maximum is this application's safety limit on
 * input, not an Elsevier rule: actual validity is established by the Author Retrieval API or by
 * administrator-verified profile evidence.
 */
export const SCOPUS_AUTHOR_ID_MAX_DIGITS = 20;
const AUTHOR_ID = new RegExp(`^\\d{1,${SCOPUS_AUTHOR_ID_MAX_DIGITS}}$`);

/**
 * Accepts "7004212771", "AUTHOR_ID:7004212771", "9-s2.0-7004212771" or a Scopus author profile URL
 * (…/authid/detail.uri?authorId=7004212771); returns the digits.
 */
export function normalizeScopusAuthorId(value: string): string {
  const trimmed = value.trim();
  let candidate = trimmed.replace(/^AUTHOR_ID:/i, '').replace(/^9-s2\.0-/i, '');
  if (/^https?:\/\//i.test(trimmed)) {
    const fromUrl = scopusAuthorIdFromUrl(trimmed);
    if (fromUrl) candidate = fromUrl;
  }
  if (!AUTHOR_ID.test(candidate)) throw new FetchError('INVALID_RESPONSE', `"${value}" is not a valid Scopus Author ID`);
  return candidate;
}

/** The authorId of a Scopus author profile URL on scopus.com, or null when it is not one. */
export function scopusAuthorIdFromUrl(value: string): string | null {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  if (url.hostname !== 'www.scopus.com' && url.hostname !== 'scopus.com') return null;
  const id = url.searchParams.get('authorId');
  return id && AUTHOR_ID.test(id) ? id : null;
}

export function scopusProfileUrl(authorId: string): string {
  return `https://www.scopus.com/authid/detail.uri?authorId=${authorId}`;
}

/** "SCOPUS_ID:85012345678" → "2-s2.0-85012345678" (the Scopus EID, used as external_id). */
export function scopusEid(identifier: string): string {
  return `2-s2.0-${identifier.slice('SCOPUS_ID:'.length)}`;
}

export class ScopusClient {
  private readonly http: SourceHttpClient;
  private readonly baseUrl: string;
  private readonly perPage: number;
  private readonly offsetLimit: number;
  private readonly headers: Record<string, string>;

  constructor(options: ScopusClientOptions) {
    this.http = new SourceHttpClient({ ...SCOPUS_HTTP_CONFIG, ...options.http }, options.deps);
    this.baseUrl = options.baseUrl ?? SCOPUS_BASE_URL;
    this.perPage = Math.min(Math.max(options.perPage ?? 200, 1), 200);
    this.offsetLimit = options.offsetLimit ?? SCOPUS_OFFSET_LIMIT;
    this.headers = { 'X-ELS-APIKey': options.apiKey, ...(options.instToken ? { 'X-ELS-Insttoken': options.instToken } : {}) };
  }

  /**
   * Validates an author ID with the Author Retrieval API. A missing profile is IDENTITY_NOT_FOUND;
   * a replaced (merged) one — 300 (several successors) or 301 (one successor) — is IDENTITY_INVALID
   * naming the successor where Scopus gives it. Redirects are never followed.
   */
  async validateAuthor(externalId: string): Promise<ScopusAuthor> {
    const authorId = normalizeScopusAuthorId(externalId);
    const url = `${this.baseUrl}/content/author/author_id/${authorId}?view=LIGHT`;
    const response = await this.get(url, { passThroughStatuses: [300, 301, 404], followRedirects: false });

    if (response.status === 404) {
      throw new FetchError('IDENTITY_NOT_FOUND', `Scopus author ${authorId} does not exist`, { url, status: 404 });
    }
    if (response.status === 300 || response.status === 301) {
      const successor = response.location ? /author_id\/(\d+)/.exec(response.location)?.[1] : undefined;
      throw new FetchError(
        'IDENTITY_INVALID',
        `Scopus author ${authorId} has been replaced` +
          (response.status === 301 && successor ? ` by author ${successor}` : ' by several author profiles') +
          '; the identity must be updated by the administrator',
        { url, status: response.status },
      );
    }

    const body = parse(ScopusAuthorResponseSchema, response.body, `author ${authorId}`, url);
    const raw = body['author-retrieval-response'];
    const profile = Array.isArray(raw) ? raw[0] : raw;
    if (profile['@status'] && profile['@status'] !== 'found') {
      throw new FetchError('IDENTITY_INVALID', `Scopus author ${authorId} is not available (its profile status is not "found")`, { url });
    }
    const returnedId = profile.coredata['dc:identifier'].slice('AUTHOR_ID:'.length);
    if (returnedId !== authorId) {
      // A different profile than requested is treated like a replacement: never silently accepted.
      throw new FetchError('IDENTITY_INVALID', `Scopus answered author ${returnedId} for requested author ${authorId}`, { url });
    }
    const preferred = profile['preferred-name'];
    const name = [preferred?.['given-name'], preferred?.surname].filter((part): part is string => Boolean(part?.trim())).join(' ');
    const count = profile.coredata['document-count'];
    return {
      authorId,
      name: name || preferred?.['indexed-name'] || null,
      documentCount: count === null || count === undefined ? null : Number(count),
      profileUrl: scopusProfileUrl(authorId),
    };
  }

  /**
   * Every document of an author, page by page; anything short of totalResults is INCOMPLETE. Offset
   * paging first; when the first page reports more results than offset paging can reach, the
   * author is fetched from the beginning with cursor pagination instead.
   */
  async fetchDocuments(authorId: string): Promise<{ documents: ScopusSearchEntry[]; reportedCount: number }> {
    const documents: ScopusSearchEntry[] = [];
    let reportedCount = -1;

    for (let start = 0; reportedCount < 0 || start < reportedCount; ) {
      const url = this.searchUrl(authorId, `start=${start}`);
      const response = await this.get(url);
      const page = parse(ScopusSearchPageSchema, response.body, `search page at ${start} for author ${authorId}`, url);
      const results = page['search-results'];
      const total = Number(results['opensearch:totalResults']);

      if (reportedCount < 0) {
        reportedCount = total;
        if (total > this.offsetLimit) return this.fetchByCursor(authorId, total);
      } else if (total !== reportedCount) {
        throw new FetchError('INCOMPLETE', `Scopus result count for author ${authorId} changed during paging (${reportedCount} → ${total})`, { url });
      }
      if (results['opensearch:startIndex'] !== undefined && Number(results['opensearch:startIndex']) !== start) {
        throw new FetchError('INVALID_RESPONSE', `Scopus returned start index ${results['opensearch:startIndex']} for requested start ${start}`, { url });
      }

      const entries = results.entry ?? [];
      if (total === 0) {
        // An empty result is a single entry {"error": "Result set was empty"}; anything else is invalid.
        if (entries.some((entry) => !isEmptyResultMarker(entry))) {
          throw new FetchError('INVALID_RESPONSE', `Scopus reported 0 documents for author ${authorId} but returned entries`, { url });
        }
        break;
      }
      if (entries.length === 0) {
        throw new FetchError('INCOMPLETE', `Scopus returned no entries at start ${start} of ${total} for author ${authorId}`, { url });
      }
      documents.push(...parseEntries(entries, start, authorId, url));
      start += entries.length;
    }

    const distinct = new Set(documents.map((d) => d['dc:identifier'])).size;
    if (distinct < reportedCount) {
      throw new FetchError(
        'INCOMPLETE',
        `Scopus reported ${reportedCount} documents for author ${authorId} but paging returned ${distinct} distinct documents` +
          (distinct < documents.length ? ` (${documents.length - distinct} repeated)` : ''),
      );
    }
    return { documents, reportedCount: Math.max(reportedCount, 0) };
  }

  /**
   * Cursor pagination (deep pagination; release notes 2018-06-21, Getting Started guide V1 p. 51):
   * the first request sends `cursor=*` and never `start`; each next request sends the cursor of
   * the previous response's `next` link (and/or `cursor/@next`; both must agree), after the link
   * is validated (nextCursor). The link is never requested itself: every request is built here,
   * against the configured base URL. Forward only; the order stays SCOPUS_SEARCH_SORT.
   * Elsevier documents no end-of-results marker, so the fetch ends when the distinct documents
   * reach `opensearch:totalResults`; a page without new documents, a repeated cursor, a missing
   * continuation before that point, a changing total or more pages than the total allows fail the
   * fetch. Not yet validated against the live API.
   */
  private async fetchByCursor(authorId: string, offsetTotal: number): Promise<{ documents: ScopusSearchEntry[]; reportedCount: number }> {
    const documents: ScopusSearchEntry[] = [];
    const seen = new Set<string>();
    const usedCursors = new Set<string>();
    let reportedCount = -1;
    let cursor = '*';

    for (let pageNumber = 1; ; pageNumber++) {
      usedCursors.add(cursor);
      const url = this.searchUrl(authorId, `cursor=${encodeURIComponent(cursor)}`);
      let response;
      try {
        response = await this.get(url);
      } catch (error) {
        // A refused cursor request is "cursor pagination unavailable": the offset fail-safe applies.
        if (error instanceof FetchError && (error.kind === 'NOT_ENTITLED' || (error.kind === 'HTTP_STATUS' && error.details.status === 400))) {
          throw cursorUnavailable(
            authorId,
            offsetTotal,
            this.offsetLimit,
            error.details.status === 403
              ? 'was refused by Scopus (HTTP 403; Elsevier offers cursor pagination to Scopus subscribers only)'
              : `was refused by Scopus (HTTP ${error.details.status})`,
          );
        }
        throw error;
      }
      const page = parse(ScopusCursorPageSchema, response.body, `cursor page ${pageNumber} for author ${authorId}`, url);
      const results = page['search-results'];
      const total = Number(results['opensearch:totalResults']);
      if (reportedCount < 0) reportedCount = total;
      else if (total !== reportedCount) {
        throw new FetchError('INCOMPLETE', `Scopus result count for author ${authorId} changed during cursor paging (${reportedCount} → ${total})`, { url });
      }

      const entries = results.entry ?? [];
      if (total === 0) {
        if (entries.some((entry) => !isEmptyResultMarker(entry))) {
          throw new FetchError('INVALID_RESPONSE', `Scopus reported 0 documents for author ${authorId} but returned entries`, { url });
        }
        break;
      }
      if (entries.length === 0) {
        throw new FetchError('INCOMPLETE', `Scopus cursor page ${pageNumber} for author ${authorId} had no entries after ${seen.size} of ${total} documents`, { url });
      }
      const before = seen.size;
      for (const document of parseEntries(entries, documents.length, authorId, url)) {
        if (seen.has(document['dc:identifier'])) continue;
        seen.add(document['dc:identifier']);
        documents.push(document);
      }
      if (seen.size === before) {
        throw new FetchError('INCOMPLETE', `Scopus cursor page ${pageNumber} for author ${authorId} repeated only documents already received`, { url });
      }
      if (seen.size >= total) break;
      if (pageNumber >= Math.ceil(total / this.perPage) + 1) {
        throw new FetchError('INCOMPLETE', `Scopus cursor paging for author ${authorId} needed more pages than ${total} documents allow`, { url });
      }

      const next = this.nextCursor(results, authorId, url);
      if (next === null) {
        throw new FetchError(
          'INCOMPLETE',
          `Scopus ended cursor paging for author ${authorId} after ${seen.size} of ${total} documents (no next cursor). ` +
            'The fetch is incomplete: no Scopus records or citation counts were saved for this identity in this run and existing data is unchanged.',
          { url },
        );
      }
      if (usedCursors.has(next)) {
        throw new FetchError('INVALID_RESPONSE', `Scopus repeated a cursor at page ${pageNumber} for author ${authorId}`, { url });
      }
      cursor = next;
    }

    if (seen.size !== Math.max(reportedCount, 0)) {
      throw new FetchError('INCOMPLETE', `Scopus reported ${reportedCount} documents for author ${authorId} but cursor paging returned ${seen.size} distinct documents`);
    }
    return { documents, reportedCount: Math.max(reportedCount, 0) };
  }

  /**
   * The next cursor of a cursor-mode page, or null when the page offers none. The `next` link must
   * be this search: the configured API host (http on port 80, as in Elsevier's examples, or https),
   * path /content/search/scopus, one `cursor`, no `start`, and — where present — the same query,
   * view, sort and count. Its cursor (or `cursor/@next`; both must agree) must be a plausible
   * opaque value. Anything else is INVALID_RESPONSE; no value from the link is quoted in errors.
   */
  private nextCursor(results: z.infer<typeof ScopusCursorPageSchema>['search-results'], authorId: string, url: string): string | null {
    const invalid = (what: string) => new FetchError('INVALID_RESPONSE', `Scopus cursor page for author ${authorId}: ${what}`, { url });
    const nextLinks = (results.link ?? []).filter((link) => link['@ref'] === 'next');
    if (nextLinks.length > 1) throw invalid('several next links');

    let fromLink: string | undefined;
    if (nextLinks.length === 1) {
      const href = nextLinks[0]['@href'];
      if (typeof href !== 'string' || href.length > 4 * CURSOR_MAX_LENGTH) throw invalid('malformed next link');
      let link: URL;
      try {
        link = new URL(href);
      } catch {
        throw invalid('malformed next link');
      }
      const base = new URL(this.baseUrl);
      const defaultPort = link.protocol === 'https:' ? '443' : link.protocol === 'http:' ? '80' : null;
      if (
        defaultPort === null ||
        link.hostname !== base.hostname ||
        (link.port !== '' && link.port !== defaultPort) ||
        link.username !== '' ||
        link.password !== '' ||
        link.pathname !== '/content/search/scopus'
      ) {
        throw invalid('next link points outside the Scopus Search API');
      }
      const params = link.searchParams;
      const expected: [string, string][] = [
        ['query', `AU-ID(${authorId})`],
        ['view', 'STANDARD'],
        ['sort', SCOPUS_SEARCH_SORT],
        ['count', String(this.perPage)],
      ];
      if (params.has('start') || params.getAll('cursor').length !== 1) throw invalid('next link is not a cursor continuation');
      if (params.getAll('query').length !== 1 || params.get('query') !== `AU-ID(${authorId})`) throw invalid('next link is for a different search');
      for (const [name, value] of expected.slice(1)) {
        if (params.getAll(name).length > 1 || (params.has(name) && params.get(name) !== value)) throw invalid('next link is for a different search');
      }
      fromLink = params.get('cursor')!;
      if (!isPlausibleCursor(fromLink)) throw invalid('malformed cursor in next link');
    }

    const element = results.cursor?.['@next'];
    let fromElement: string | undefined;
    if (element !== undefined && element !== null) {
      if (!isPlausibleCursor(element)) throw invalid('malformed cursor/@next');
      fromElement = element;
    }
    if (fromLink !== undefined && fromElement !== undefined && fromLink !== fromElement) throw invalid('next link and cursor/@next disagree');
    return fromLink ?? fromElement ?? null;
  }

  /** A Scopus Search request for an author, in the fixed order; `position` is `start=…` or `cursor=…`. */
  private searchUrl(authorId: string, position: string): string {
    const query = encodeURIComponent(`AU-ID(${authorId})`);
    const sort = encodeURIComponent(SCOPUS_SEARCH_SORT);
    return `${this.baseUrl}/content/search/scopus?query=${query}&view=STANDARD&sort=${sort}&${position}&count=${this.perPage}`;
  }

  /** Identity validation followed by the complete document fetch (fetch-then-write, §14). */
  async fetchAuthorDocuments(externalId: string): Promise<ScopusFetchResult> {
    const author = await this.validateAuthor(externalId);
    const { documents, reportedCount } = await this.fetchDocuments(author.authorId);
    return { author, documents, reportedCount };
  }

  /**
   * GET with credential headers. Failures from the shared client are re-issued with fixed messages
   * (scopusFailure), so no Scopus response text reaches task errors or logs; the shared client's
   * behaviour for the other sources is unchanged.
   */
  private async get(url: string, options: JsonRequestOptions = {}) {
    let quotaExhausted = false;
    try {
      return await this.http.getJson(url, {
        ...options,
        headers: this.headers,
        isFinal429: (headers) => (quotaExhausted = /QUOTA_EXCEEDED/i.test(headers.get('x-els-status') ?? '')),
      });
    } catch (error) {
      if (error instanceof FetchError) throw scopusFailure(error, quotaExhausted);
      throw error;
    }
  }
}

/** The fixed, actionable message for each failure of the shared HTTP client. */
function scopusFailure(error: FetchError, quotaExhausted: boolean): FetchError {
  const details = { url: error.details.url, status: error.details.status };
  const status = details.status;
  switch (error.kind) {
    case 'HTTP_STATUS':
      if (status === 401) {
        return new FetchError('AUTH_FAILED', 'Scopus: HTTP 401 (the API key or institutional token was refused; check SCOPUS_API_KEY and SCOPUS_INST_TOKEN)', details);
      }
      if (status === 403) {
        return new FetchError('NOT_ENTITLED', 'Scopus: HTTP 403 (these credentials are not entitled to this data; the institution\'s Scopus API access must cover it)', details);
      }
      if (status === 429) {
        return new FetchError(
          'QUOTA_EXCEEDED',
          quotaExhausted
            ? 'Scopus: HTTP 429 (the API key\'s weekly quota is exhausted; synchronize again after it resets)'
            : 'Scopus: HTTP 429 (rate limit still exceeded after retries; synchronize again later)',
          details,
        );
      }
      if (status !== undefined && status >= 500) return new FetchError('HTTP_STATUS', `Scopus: HTTP ${status} (Scopus service error, after retries; synchronize again later)`, details);
      return new FetchError('HTTP_STATUS', `Scopus: HTTP ${status} (request refused by Scopus)`, details);
    case 'CONTENT_TYPE':
      return new FetchError('CONTENT_TYPE', 'Scopus: expected JSON but received another kind of response (for example an HTML page)', details);
    case 'MALFORMED_BODY':
      return new FetchError('MALFORMED_BODY', 'Scopus: response body is not valid JSON', details);
    case 'TIMEOUT':
      return new FetchError('TIMEOUT', 'Scopus: request timed out', details);
    case 'NETWORK':
      return new FetchError('NETWORK', 'Scopus: network error (Scopus could not be reached)', details);
    default:
      return new FetchError(error.kind, `Scopus: request failed (${error.kind})`, details);
  }
}

/** The offset fail-safe when cursor pagination cannot be used for an author beyond the limit. */
function cursorUnavailable(authorId: string, total: number, limit: number, reason: string): FetchError {
  return new FetchError(
    'INCOMPLETE',
    `Scopus reports ${total} documents for author ${authorId}, more than the ${limit} reachable by offset paging, and cursor pagination ` +
      `${reason}. The fetch is incomplete: no Scopus records or citation counts were saved for this identity in this run and existing ` +
      'data is unchanged.',
  );
}

/** An opaque cursor: printable ASCII without spaces, bounded length, never the initial "*". */
function isPlausibleCursor(value: string): boolean {
  return value !== '*' && value.length <= CURSOR_MAX_LENGTH && /^[\x21-\x7e]+$/.test(value);
}

/** Validated entries of one page; `first` is the position of the first entry (for messages). */
function parseEntries(entries: unknown[], first: number, authorId: string, url: string): ScopusSearchEntry[] {
  return entries.map((entry, index) => {
    if (isEmptyResultMarker(entry)) {
      throw new FetchError('INVALID_RESPONSE', `Scopus returned an error entry at position ${first + index} for author ${authorId}`, { url });
    }
    const document = parse(ScopusSearchEntrySchema, entry, `document ${first + index + 1} for author ${authorId}`, url);
    if (document.eid && document.eid !== scopusEid(document['dc:identifier'])) {
      throw new FetchError('INVALID_RESPONSE', `Scopus document ${document['dc:identifier']} has an EID that does not match its identifier`, { url });
    }
    return document;
  });
}

function isEmptyResultMarker(entry: unknown): boolean {
  return entry !== null && typeof entry === 'object' && 'error' in entry;
}

function parse<T extends z.ZodType>(schema: T, body: unknown, what: string, url: string): z.infer<T> {
  if (body !== null && typeof body === 'object' && !Array.isArray(body) && 'service-error' in body) {
    throw new FetchError('INVALID_RESPONSE', `Scopus returned an error payload for ${what}`, { url });
  }
  const result = schema.safeParse(body);
  if (!result.success) {
    const issue = result.error.issues[0];
    throw new FetchError('INVALID_RESPONSE', `Scopus returned an invalid ${what}: ${issue.path.join('.') || '(root)'} ${issue.message}`, { url });
  }
  return result.data;
}
