import type { z } from 'zod';
import { FetchError, HttpDependencies, JsonRequestOptions, SourceHttpClient, SourceHttpConfig } from '../http/httpClient';
import { normalizeIssn } from '../../services/normalization/issn';
import {
  JcrJournalHistory,
  JcrJournalHistorySchema,
  JcrJournalListSchema,
  JcrJournalRecord,
  JcrJournalRecordSchema,
  JcrJournalReport,
  JcrJournalReportSchema,
  JcrLastUpdatedSchema,
} from './types';

/**
 * Clarivate Web of Science Journals API (Journal Citation Reports) client (Project_plan.md §13.8,
 * §22.4; stage 15.6). Journal metrics only — never a publication source.
 *  - authenticates with the `X-ApiKey` header only; the key never appears in URLs, errors or logs;
 *  - `GET /journals?q=<ISSN>` finds the journals of an ISSN ("a complete and valid ISSN code
 *    pattern"), paged with `limit` ≤ 50 until `metadata.total`;
 *  - `GET /journals/{id}` (profile, current/electronic/previous ISSNs, available report years),
 *    `GET /journals/{id}/history` (ISSNs with their years), `GET /journals/{id}/reports/year/{year}`
 *    (a yearly report; HTTP 404 is UNAVAILABLE — Clarivate documents both "not found" and a
 *    suppressed title as 404, so it does not establish that the report does not exist),
 *    `GET /last-updated` (the database-wide content date; the API has no per-report version);
 *  - classifies 401 → AUTH_FAILED, 403 → NOT_ENTITLED, 429 → QUOTA_EXCEEDED (retried first,
 *    honouring Retry-After); every failure message is fixed text plus validated values.
 * Built against Clarivate's OpenAPI specification and synthetic fixtures only; not run against the
 * live API (stage 15.9, after the §22.6 Clarivate gate).
 */

export const JCR_BASE_URL = 'https://api.clarivate.com/apis/wos-journals/v1';

/** The documented maximum of `limit` (1–50). */
export const JCR_PAGE_LIMIT = 50;

export const JCR_HTTP_CONFIG: SourceHttpConfig = {
  name: 'Journal Citation Reports',
  // One plan: 5 requests/s; one request at a time, ≤ 4/s.
  minIntervalMs: 250,
  timeoutMs: 30_000,
  maxRetries: 3,
  baseDelayMs: 1_000,
  maxDelayMs: 60_000,
};

/**
 * JCR journal identifiers are upper-case abbreviations such as "PLOS_ONE" or "4OR-Q_J_OPER_RES".
 * Clarivate documents no format; this pattern is the application's guard before an identifier is
 * put into a URL path.
 */
const JOURNAL_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,199}$/;

export function isJcrJournalId(value: string): boolean {
  return JOURNAL_ID.test(value);
}

/**
 * The outcome of a yearly-report request. `UNAVAILABLE` is HTTP 404, which Clarivate documents both
 * for a report that is not found and for a title suppressed in that year: the two cannot be told
 * apart, so it never means "confirmed not to exist" and never removes or changes stored data.
 */
export type JcrReportLookup = { kind: 'REPORT'; report: JcrJournalReport } | { kind: 'UNAVAILABLE'; status: 404 };

export interface JcrClientOptions {
  apiKey: string;
  baseUrl?: string;
  http?: Partial<SourceHttpConfig>;
  deps?: HttpDependencies;
}

export class JcrClient {
  private readonly http: SourceHttpClient;
  private readonly baseUrl: string;
  private readonly headers: Record<string, string>;

  constructor(options: JcrClientOptions) {
    this.http = new SourceHttpClient({ ...JCR_HTTP_CONFIG, ...options.http }, options.deps);
    this.baseUrl = options.baseUrl ?? JCR_BASE_URL;
    this.headers = { 'X-ApiKey': options.apiKey };
  }

  /** The database-wide content date ("YYYY-MM-DD"). */
  async lastUpdated(): Promise<string> {
    const url = `${this.baseUrl}/last-updated`;
    return parse(JcrLastUpdatedSchema, (await this.get(url)).body, 'last-updated response', url).jcrDataUpdate;
  }

  /** The identifiers of every journal the ISSN search returns (complete against `metadata.total`). */
  async searchByIssn(value: string): Promise<string[]> {
    const issn = normalizeIssn(value);
    if (!issn) throw new FetchError('INVALID_RESPONSE', `"${value}" is not a valid ISSN`);
    const ids: string[] = [];
    let total = -1;
    for (let page = 1; total < 0 || (page - 1) * JCR_PAGE_LIMIT < total; page++) {
      const url = `${this.baseUrl}/journals?q=${encodeURIComponent(issn)}&limit=${JCR_PAGE_LIMIT}&page=${page}`;
      const body = parse(JcrJournalListSchema, (await this.get(url)).body, `journal search page ${page} for ISSN ${issn}`, url);
      if (total < 0) total = body.metadata.total;
      else if (body.metadata.total !== total) {
        throw new FetchError('INCOMPLETE', `JCR result count for ISSN ${issn} changed during paging (${total} → ${body.metadata.total})`, { url });
      }
      if (body.metadata.page !== undefined && body.metadata.page !== page) {
        throw new FetchError('INVALID_RESPONSE', `JCR answered page ${body.metadata.page} for requested page ${page}`, { url });
      }
      const hits = body.hits ?? [];
      if (hits.length > JCR_PAGE_LIMIT) throw new FetchError('INVALID_RESPONSE', `JCR returned ${hits.length} journals on a page of ${JCR_PAGE_LIMIT}`, { url });
      if (total === 0) {
        if (hits.length > 0) throw new FetchError('INVALID_RESPONSE', `JCR reported 0 journals for ISSN ${issn} but returned some`, { url });
        break;
      }
      if (hits.length === 0) throw new FetchError('INCOMPLETE', `JCR returned no journals on page ${page} of ${total} results for ISSN ${issn}`, { url });
      for (const hit of hits) {
        if (!isJcrJournalId(hit.id)) throw new FetchError('INVALID_RESPONSE', `JCR returned a malformed journal identifier for ISSN ${issn}`, { url });
        ids.push(hit.id);
      }
    }
    const distinct = [...new Set(ids)];
    if (distinct.length !== total) {
      throw new FetchError('INCOMPLETE', `JCR reported ${total} journals for ISSN ${issn} but paging returned ${distinct.length} distinct journals`);
    }
    return distinct;
  }

  /** A journal's profile. An unknown identifier is IDENTITY_NOT_FOUND. */
  async journal(id: string): Promise<JcrJournalRecord> {
    const url = `${this.baseUrl}/journals/${this.journalPath(id)}`;
    const response = await this.get(url, { passThroughStatuses: [404] });
    if (response.status === 404) throw new FetchError('IDENTITY_NOT_FOUND', `JCR journal ${id} does not exist`, { url, status: 404 });
    const record = parse(JcrJournalRecordSchema, response.body, `journal ${id}`, url);
    if (record.id !== id) throw new FetchError('INVALID_RESPONSE', `JCR answered journal ${isJcrJournalId(record.id) ? record.id : '(malformed)'} for requested journal ${id}`, { url });
    return record;
  }

  /** A journal's ISSN history. */
  async history(id: string): Promise<JcrJournalHistory> {
    const url = `${this.baseUrl}/journals/${this.journalPath(id)}/history`;
    return parse(JcrJournalHistorySchema, (await this.get(url)).body, `history of journal ${id}`, url);
  }

  /** A journal's report for one JCR year, or UNAVAILABLE (HTTP 404: not found or suppressed — ambiguous). */
  async report(id: string, year: number): Promise<JcrReportLookup> {
    if (!Number.isInteger(year) || year < 1997 || year > 2100) throw new FetchError('INVALID_RESPONSE', `${year} is not a JCR year`);
    const url = `${this.baseUrl}/journals/${this.journalPath(id)}/reports/year/${year}`;
    const response = await this.get(url, { passThroughStatuses: [404] });
    if (response.status === 404) return { kind: 'UNAVAILABLE', status: 404 };
    const report = parse(JcrJournalReportSchema, response.body, `${year} report of journal ${id}`, url);
    if (report.year !== null && report.year !== undefined && report.year !== year) {
      throw new FetchError('INVALID_RESPONSE', `JCR answered the ${report.year} report for requested year ${year} of journal ${id}`, { url });
    }
    const reportedId = report.journal?.id;
    if (reportedId !== null && reportedId !== undefined && reportedId !== id) {
      throw new FetchError('INVALID_RESPONSE', `JCR answered a report of another journal for requested journal ${id}`, { url });
    }
    return { kind: 'REPORT', report };
  }

  private journalPath(id: string): string {
    if (!isJcrJournalId(id)) throw new FetchError('INVALID_RESPONSE', 'Malformed JCR journal identifier');
    return encodeURIComponent(id);
  }

  /** GET with the API key header; failures re-issued with fixed messages (no provider text). */
  private async get(url: string, options: JsonRequestOptions = {}) {
    try {
      return await this.http.getJson(url, { ...options, headers: this.headers });
    } catch (error) {
      if (error instanceof FetchError) throw jcrFailure(error);
      throw error;
    }
  }
}

function jcrFailure(error: FetchError): FetchError {
  const details = { url: error.details.url, status: error.details.status };
  const status = details.status;
  switch (error.kind) {
    case 'HTTP_STATUS':
      if (status === 401) return new FetchError('AUTH_FAILED', 'JCR: HTTP 401 (the API key was refused; check WOS_JOURNALS_API_KEY)', details);
      if (status === 403) return new FetchError('NOT_ENTITLED', 'JCR: HTTP 403 (this API key is not entitled to the Web of Science Journals API)', details);
      if (status === 429) return new FetchError('QUOTA_EXCEEDED', 'JCR: HTTP 429 (rate limit or quota still exceeded after retries; refresh again later)', details);
      if (status !== undefined && status >= 500) return new FetchError('HTTP_STATUS', `JCR: HTTP ${status} (JCR service error, after retries; refresh again later)`, details);
      return new FetchError('HTTP_STATUS', `JCR: HTTP ${status} (request refused by JCR)`, details);
    case 'CONTENT_TYPE':
      return new FetchError('CONTENT_TYPE', 'JCR: expected JSON but received another kind of response (for example an HTML page)', details);
    case 'MALFORMED_BODY':
      return new FetchError('MALFORMED_BODY', 'JCR: response body is not valid JSON', details);
    case 'TIMEOUT':
      return new FetchError('TIMEOUT', 'JCR: request timed out', details);
    case 'NETWORK':
      return new FetchError('NETWORK', 'JCR: network error (JCR could not be reached)', details);
    default:
      return new FetchError(error.kind, `JCR: request failed (${error.kind})`, details);
  }
}

function parse<T extends z.ZodType>(schema: T, body: unknown, what: string, url: string): z.infer<T> {
  if (body !== null && typeof body === 'object' && !Array.isArray(body) && ('error' in body || 'error_description' in body) && !('id' in body) && !('metadata' in body)) {
    throw new FetchError('INVALID_RESPONSE', `JCR returned an error payload for ${what}`, { url });
  }
  const result = schema.safeParse(body);
  if (!result.success) {
    const issue = result.error.issues[0];
    throw new FetchError('INVALID_RESPONSE', `JCR returned an invalid ${what}: ${issue.path.join('.') || '(root)'} ${issue.message}`, { url });
  }
  return result.data;
}
