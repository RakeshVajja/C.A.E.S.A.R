import type { z } from 'zod';
import { FetchError, HttpDependencies, SourceHttpClient, SourceHttpConfig } from '../http/httpClient';
import { WosAuthorNameSchema, WosDocument, WosDocumentSchema, WosDocumentsPageSchema } from './types';

/**
 * Clarivate Web of Science Starter API client (Project_plan.md §13.7, §13.9; Phase 15.4):
 *  - authenticates with the `X-ApiKey` header only — never in URLs; the key never appears in
 *    errors or logs;
 *  - searches the Core Collection by ResearcherID: `GET /documents?db=WOS&q=AI=(<ResearcherID>)`,
 *    `limit=50` (the documented maximum), pages numbered from 1, in a fixed order (WOS_SORT_FIELD);
 *    the result must contain as many distinct documents as `metadata.total`, otherwise the fetch
 *    is INCOMPLETE;
 *  - `AI` (Author Identifier) finds the documents *linked* to the ResearcherID in Web of Science,
 *    which need not be every publication of the researcher; each document's own author list is
 *    therefore checked for the ResearcherID (`attributedAuthors`) before it is attributed;
 *  - classifies 401 → AUTH_FAILED, 403 → NOT_ENTITLED, 429 → QUOTA_EXCEEDED (retried by the
 *    shared client first, honouring Retry-After); every failure message is fixed text plus
 *    validated values — no response body, header or free-text field is copied into an error.
 * Built against Clarivate's OpenAPI specification and synthetic fixtures only; it has not been run
 * against the live API (stage 15.9).
 */

export const WOS_STARTER_BASE_URL = 'https://api.clarivate.com/apis/wos-starter/v1';

/** The documented maximum of `limit` (1–50). */
export const WOS_PAGE_LIMIT = 50;

/**
 * Application safety limit on the documents of one ResearcherID (200 requests of the
 * Institutional Member plan's 5,000 per day). Clarivate documents no paging limit; this bound only
 * keeps a wrong identifier from exhausting the daily quota. Beyond it the fetch is INCOMPLETE.
 */
export const WOS_MAX_RESULTS = 10_000;

/**
 * Deterministic result order for page-number paging: load date ascending, then publication year
 * ascending (`sortField`, "Field name and order by clause separated by '+' … Multiple values are
 * separated by comma"). Documents loaded during a fetch sort after those already paged. No unique
 * identifier is a documented sort field, so ties may still be ordered differently between
 * requests; the distinct-document and total checks turn any resulting gap into INCOMPLETE.
 */
export const WOS_SORT_FIELD = 'LD+A,PY+A';

export const WOS_HTTP_CONFIG: SourceHttpConfig = {
  name: 'Web of Science',
  // Institutional Member plan: 5 requests/s and 5,000/day; one request at a time, ≤ 4/s.
  minIntervalMs: 250,
  timeoutMs: 30_000,
  maxRetries: 3,
  baseDelayMs: 1_000,
  maxDelayMs: 60_000,
};

export interface WosClientOptions {
  apiKey: string;
  baseUrl?: string;
  /** Documents per page; 50 (the maximum) by default. */
  perPage?: number;
  /** WOS_MAX_RESULTS by default (smaller only in tests). */
  maxResults?: number;
  http?: Partial<SourceHttpConfig>;
  deps?: HttpDependencies;
}

export interface WosResearcherPreview {
  researcherId: string;
  /** The display name of the first document author carrying this ResearcherID. */
  name: string | null;
  /** Documents found for the ResearcherID (`metadata.total`). */
  documentCount: number;
  profileUrl: string;
}

export interface WosFetchResult {
  documents: WosDocument[];
  reportedCount: number;
}

/**
 * Web of Science ResearcherID: 1–3 letters, 4 digits and the year of generation, e.g.
 * "A-1009-2008", "AAG-1344-2019" (Clarivate's examples). Clarivate's API specification does not
 * state the format; this pattern follows its examples and the published identifier registries,
 * and actual validity is established by the API or administrator-verified profile evidence.
 * Input is upper-cased (the identifiers are written in capitals).
 */
const RESEARCHER_ID = /^[A-Z]{1,3}-\d{4}-(?:19|20)\d{2}$/;

/** Accepts a ResearcherID or a Web of Science author-record URL naming it; returns the ResearcherID. */
export function normalizeResearcherId(value: string): string {
  const trimmed = value.trim();
  const candidate = /^https?:\/\//i.test(trimmed) ? (researcherIdFromProfileUrl(trimmed) ?? '') : trimmed.toUpperCase();
  if (!RESEARCHER_ID.test(candidate)) throw new FetchError('INVALID_RESPONSE', `"${value}" is not a valid Web of Science ResearcherID`);
  return candidate;
}

/**
 * The ResearcherID of a Web of Science author-record URL — `https://www.webofscience.com/wos/author/
 * record/<ResearcherID>` or `…/wos/author/rid/<ResearcherID>` — or null when it is not one. Record
 * URLs with an internal numeric id do not name the ResearcherID and are not accepted as evidence.
 */
export function researcherIdFromProfileUrl(value: string): string | null {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  if (url.hostname !== 'www.webofscience.com' && url.hostname !== 'webofscience.com') return null;
  if (url.username || url.password || (url.port !== '' && url.port !== '443' && url.port !== '80')) return null;
  const match = /^\/wos\/author\/(?:record|rid)\/([^/]+)\/?$/.exec(url.pathname);
  if (!match) return null;
  const id = decodeURIComponent(match[1]).toUpperCase();
  return RESEARCHER_ID.test(id) ? id : null;
}

/** The canonical author-record link for a ResearcherID (it redirects to the author record). */
export function wosProfileUrl(researcherId: string): string {
  return `https://www.webofscience.com/wos/author/rid/${researcherId}`;
}

/** The `q` of a ResearcherID search: the `AI` (Author Identifier) field tag. */
export function researcherQuery(researcherId: string): string {
  return `AI=(${researcherId})`;
}

/** Authors of a document whose ResearcherID is this one (compared case-insensitively). */
export function attributedAuthors(document: WosDocument, researcherId: string): z.infer<typeof WosAuthorNameSchema>[] {
  const wanted = researcherId.toUpperCase();
  return (document.names?.authors ?? []).filter((author) => author.researcherId?.trim().toUpperCase() === wanted);
}

export class WosStarterClient {
  private readonly http: SourceHttpClient;
  private readonly baseUrl: string;
  private readonly perPage: number;
  private readonly maxResults: number;
  private readonly headers: Record<string, string>;

  constructor(options: WosClientOptions) {
    this.http = new SourceHttpClient({ ...WOS_HTTP_CONFIG, ...options.http }, options.deps);
    this.baseUrl = options.baseUrl ?? WOS_STARTER_BASE_URL;
    this.perPage = Math.min(Math.max(options.perPage ?? WOS_PAGE_LIMIT, 1), WOS_PAGE_LIMIT);
    this.maxResults = options.maxResults ?? WOS_MAX_RESULTS;
    this.headers = { 'X-ApiKey': options.apiKey };
  }

  /**
   * Identity preview: the first page of the ResearcherID search. No document → IDENTITY_NOT_FOUND
   * (the Starter API has no researcher-profile endpoint, so a ResearcherID without linked documents
   * cannot be checked); documents of which none lists the ResearcherID → IDENTITY_INVALID.
   */
  async previewResearcher(value: string): Promise<WosResearcherPreview> {
    const researcherId = normalizeResearcherId(value);
    const { total, documents, url } = await this.page(researcherId, 1);
    if (total === 0) {
      throw new FetchError('IDENTITY_NOT_FOUND', `No Web of Science document is linked to ResearcherID ${researcherId}`, { url });
    }
    const author = documents.flatMap((document) => attributedAuthors(document, researcherId))[0];
    if (!author) {
      throw new FetchError('IDENTITY_INVALID', `No Web of Science document found for ResearcherID ${researcherId} lists it among its authors`, { url });
    }
    return {
      researcherId,
      name: author.displayName?.trim() || author.wosStandard?.trim() || null,
      documentCount: total,
      profileUrl: wosProfileUrl(researcherId),
    };
  }

  /** Every document of the ResearcherID search, page by page; anything short of the total is INCOMPLETE. */
  async fetchResearcherDocuments(value: string): Promise<WosFetchResult> {
    const researcherId = normalizeResearcherId(value);
    const documents: WosDocument[] = [];
    let reportedCount = -1;

    for (let page = 1; reportedCount < 0 || (page - 1) * this.perPage < reportedCount; page++) {
      const { total, documents: hits, url } = await this.page(researcherId, page);
      if (reportedCount < 0) {
        reportedCount = total;
        if (total > this.maxResults) {
          throw new FetchError(
            'INCOMPLETE',
            `Web of Science reports ${total} documents for ResearcherID ${researcherId}, more than this application's safety limit of ` +
              `${this.maxResults}. The fetch is incomplete: no Web of Science records or Times Cited were saved for this identity in this ` +
              'run and existing data is unchanged; check that the ResearcherID is correct.',
            { url },
          );
        }
      } else if (total !== reportedCount) {
        throw new FetchError('INCOMPLETE', `Web of Science result count for ResearcherID ${researcherId} changed during paging (${reportedCount} → ${total})`, { url });
      }
      if (total === 0) break;
      if (hits.length === 0) {
        throw new FetchError('INCOMPLETE', `Web of Science returned no documents on page ${page} of ${total} results for ResearcherID ${researcherId}`, { url });
      }
      documents.push(...hits);
    }

    const distinct = new Set(documents.map((d) => d.uid)).size;
    if (distinct !== reportedCount) {
      throw new FetchError(
        'INCOMPLETE',
        `Web of Science reported ${reportedCount} documents for ResearcherID ${researcherId} but paging returned ${distinct} distinct documents` +
          (distinct < documents.length ? ` (${documents.length - distinct} repeated)` : ''),
      );
    }
    return { documents, reportedCount };
  }

  /** One validated search page. */
  private async page(researcherId: string, page: number): Promise<{ total: number; documents: WosDocument[]; url: string }> {
    const url =
      `${this.baseUrl}/documents?db=WOS&q=${encodeURIComponent(researcherQuery(researcherId))}` +
      `&limit=${this.perPage}&page=${page}&sortField=${encodeURIComponent(WOS_SORT_FIELD)}`;
    const response = await this.get(url);
    const body = parse(WosDocumentsPageSchema, response.body, `search page ${page} for ResearcherID ${researcherId}`, url);
    const { total, page: answeredPage, limit } = body.metadata;
    if (answeredPage !== undefined && answeredPage !== page) {
      throw new FetchError('INVALID_RESPONSE', `Web of Science answered page ${answeredPage} for requested page ${page}`, { url });
    }
    if (limit !== undefined && limit !== this.perPage) {
      throw new FetchError('INVALID_RESPONSE', `Web of Science answered with ${limit} documents per page for a requested ${this.perPage}`, { url });
    }
    const hits = body.hits ?? [];
    if (hits.length > this.perPage) {
      throw new FetchError('INVALID_RESPONSE', `Web of Science returned ${hits.length} documents on a page of ${this.perPage}`, { url });
    }
    if (total === 0 && hits.length > 0) {
      throw new FetchError('INVALID_RESPONSE', `Web of Science reported 0 documents for ResearcherID ${researcherId} but returned some`, { url });
    }
    const position = (page - 1) * this.perPage;
    const documents = hits.map((hit, index) => parse(WosDocumentSchema, hit, `document ${position + index + 1} for ResearcherID ${researcherId}`, url));
    return { total, documents, url };
  }

  /**
   * GET with the API key header. Failures from the shared client are re-issued with fixed messages
   * (wosFailure), so no Web of Science response text reaches task errors or logs; the shared
   * client's behaviour for the other sources is unchanged.
   */
  private async get(url: string) {
    try {
      return await this.http.getJson(url, { headers: this.headers });
    } catch (error) {
      if (error instanceof FetchError) throw wosFailure(error);
      throw error;
    }
  }
}

/** The fixed, actionable message for each failure of the shared HTTP client. */
function wosFailure(error: FetchError): FetchError {
  const details = { url: error.details.url, status: error.details.status };
  const status = details.status;
  switch (error.kind) {
    case 'HTTP_STATUS':
      if (status === 401) return new FetchError('AUTH_FAILED', 'Web of Science: HTTP 401 (the API key was refused; check WOS_STARTER_API_KEY)', details);
      if (status === 403) {
        return new FetchError('NOT_ENTITLED', 'Web of Science: HTTP 403 (this API key is not entitled to the Web of Science Starter data requested)', details);
      }
      if (status === 429) {
        return new FetchError('QUOTA_EXCEEDED', 'Web of Science: HTTP 429 (rate limit or daily quota still exceeded after retries; synchronize again later)', details);
      }
      if (status !== undefined && status >= 500) {
        return new FetchError('HTTP_STATUS', `Web of Science: HTTP ${status} (Web of Science service error, after retries; synchronize again later)`, details);
      }
      return new FetchError('HTTP_STATUS', `Web of Science: HTTP ${status} (request refused by Web of Science)`, details);
    case 'CONTENT_TYPE':
      return new FetchError('CONTENT_TYPE', 'Web of Science: expected JSON but received another kind of response (for example an HTML page)', details);
    case 'MALFORMED_BODY':
      return new FetchError('MALFORMED_BODY', 'Web of Science: response body is not valid JSON', details);
    case 'TIMEOUT':
      return new FetchError('TIMEOUT', 'Web of Science: request timed out', details);
    case 'NETWORK':
      return new FetchError('NETWORK', 'Web of Science: network error (Web of Science could not be reached)', details);
    default:
      return new FetchError(error.kind, `Web of Science: request failed (${error.kind})`, details);
  }
}

function parse<T extends z.ZodType>(schema: T, body: unknown, what: string, url: string): z.infer<T> {
  if (body !== null && typeof body === 'object' && !Array.isArray(body) && 'error' in body && !('metadata' in body) && !('uid' in body)) {
    throw new FetchError('INVALID_RESPONSE', `Web of Science returned an error payload for ${what}`, { url });
  }
  const result = schema.safeParse(body);
  if (!result.success) {
    const issue = result.error.issues[0];
    throw new FetchError('INVALID_RESPONSE', `Web of Science returned an invalid ${what}: ${issue.path.join('.') || '(root)'} ${issue.message}`, { url });
  }
  return result.data;
}
