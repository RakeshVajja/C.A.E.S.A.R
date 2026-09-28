import { FetchError, HttpDependencies, SourceHttpClient, SourceHttpConfig } from '../http/httpClient';
import { OrcidWorkSummary, OrcidWorksSchema } from './types';

/**
 * ORCID client (Project_plan.md §13.5): Public API v3.0, anonymous access, one request per identity.
 *
 * Verified against the live API (2026-09-28):
 *  - `/v3.0/{orcid}/works` returns the complete list of work summaries in one response (no paging:
 *    1,351 summaries for a large record, equal to the counts in `/record`), so completeness rests on
 *    full structural validation — a truncated body fails JSON parsing;
 *  - a nonexistent iD answers 404 (error-code 9016); a deactivated record answers 409 (9044); ORCID
 *    documents 409 for locked records and a 301 to the primary record for deprecated ones.
 * Identity validation therefore happens on this same request, before any work is processed: the iD's
 * checksum, then the status, then the response path must name the requested iD. A deprecated iD
 * fails safely (redirects are not followed, decision #43). Every failure is a FetchError, never
 * "zero works"; a well-formed response with no groups is a genuine empty result.
 */

export const ORCID_API_BASE_URL = 'https://pub.orcid.org/v3.0';

export const ORCID_HTTP_CONFIG: SourceHttpConfig = {
  name: 'ORCID',
  minIntervalMs: 200, // anonymous limit is 12 requests/s; one request per identity anyway
  timeoutMs: 60_000,
  maxRetries: 3,
  baseDelayMs: 1_000,
  maxDelayMs: 60_000,
};

/** ISO 7064 MOD 11-2 check character of an ORCID iD's first 15 digits. */
export function orcidCheckCharacter(baseDigits: string): string {
  let total = 0;
  for (const digit of baseDigits) total = (total + Number(digit)) * 2;
  const result = (12 - (total % 11)) % 11;
  return result === 10 ? 'X' : String(result);
}

/** Accepts "0000-0002-0661-5773", "https://orcid.org/0000-…", lowercase x; returns the canonical iD. */
export function normalizeOrcidId(value: string): string {
  const match = /^(?:https?:\/\/(?:www\.)?orcid\.org\/)?(\d{4})-(\d{4})-(\d{4})-(\d{3}[\dXx])$/.exec(value.trim());
  if (!match) throw new FetchError('INVALID_RESPONSE', `"${value}" is not a valid ORCID iD`);
  const orcid = `${match[1]}-${match[2]}-${match[3]}-${match[4].toUpperCase()}`;
  const digits = orcid.replace(/-/g, '');
  if (orcidCheckCharacter(digits.slice(0, 15)) !== digits[15]) {
    throw new FetchError('INVALID_RESPONSE', `"${value}" fails the ORCID iD checksum`);
  }
  return orcid;
}

export interface OrcidFetchResult {
  orcid: string;
  summaries: OrcidWorkSummary[];
  /** Work summaries whose put-code appeared more than once in the response (kept once). */
  duplicatePutCodes: number[];
}

export interface OrcidClientOptions {
  baseUrl?: string;
  http?: Partial<SourceHttpConfig>;
  deps?: HttpDependencies;
}

export class OrcidClient {
  private readonly http: SourceHttpClient;
  private readonly baseUrl: string;

  constructor(options: OrcidClientOptions = {}) {
    this.http = new SourceHttpClient({ ...ORCID_HTTP_CONFIG, ...options.http }, options.deps);
    this.baseUrl = options.baseUrl ?? ORCID_API_BASE_URL;
  }

  /** Validates the iD and fetches every work summary of the record. */
  async fetchWorks(externalId: string): Promise<OrcidFetchResult> {
    const orcid = normalizeOrcidId(externalId);
    const url = `${this.baseUrl}/${orcid}/works`;
    const response = await this.http.getJson(url, {
      headers: { Accept: 'application/json' },
      followRedirects: false,
      passThroughStatuses: [301, 302, 303, 307, 308, 404, 409],
    });

    if (response.status >= 300 && response.status < 400) {
      const primary = /(\d{4}-\d{4}-\d{4}-\d{3}[\dX])/.exec(response.location ?? '')?.[1];
      throw new FetchError(
        'IDENTITY_INVALID',
        `ORCID iD ${orcid} is deprecated${primary ? ` (merged into ${primary})` : ''}; update the identity`,
        { url, status: response.status },
      );
    }
    if (response.status === 404) {
      throw new FetchError('IDENTITY_NOT_FOUND', `ORCID iD ${orcid} does not exist`, { url, status: 404 });
    }
    if (response.status === 409) {
      const error = response.body as { 'user-message'?: unknown; 'error-code'?: unknown } | null;
      const detail = typeof error?.['user-message'] === 'string' ? error['user-message'] : 'record unavailable';
      throw new FetchError(
        'IDENTITY_INVALID',
        `ORCID record ${orcid} cannot be read: ${detail}${error?.['error-code'] ? ` (error ${String(error['error-code'])})` : ''}`,
        { url, status: 409 },
      );
    }

    const body = response.body;
    if (body !== null && typeof body === 'object' && ('error-code' in body || 'response-code' in body)) {
      const message = (body as { 'developer-message'?: unknown })['developer-message'];
      throw new FetchError('INVALID_RESPONSE', `ORCID returned an error payload for ${orcid}: ${String(message)}`, { url });
    }
    const parsed = OrcidWorksSchema.safeParse(body);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      throw new FetchError(
        'INVALID_RESPONSE',
        `ORCID returned an invalid works response for ${orcid}: ${issue.path.join('.') || '(root)'} ${issue.message}`,
        { url },
      );
    }

    // The response must describe the requested record (guards against any silent redirect).
    if (parsed.data.path !== `/${orcid}/works`) {
      throw new FetchError('INVALID_RESPONSE', `ORCID answered for "${parsed.data.path}" instead of /${orcid}/works`, { url });
    }

    const summaries: OrcidWorkSummary[] = [];
    const seen = new Set<number>();
    const duplicatePutCodes: number[] = [];
    for (const group of parsed.data.group) {
      for (const summary of group['work-summary']) {
        if (summary.path !== `/${orcid}/work/${summary['put-code']}`) {
          throw new FetchError(
            'INVALID_RESPONSE',
            `ORCID work ${summary['put-code']} has path "${summary.path}", not under /${orcid}/work/`,
            { url },
          );
        }
        if (seen.has(summary['put-code'])) {
          duplicatePutCodes.push(summary['put-code']);
          continue;
        }
        seen.add(summary['put-code']);
        summaries.push(summary);
      }
    }
    return { orcid, summaries, duplicatePutCodes };
  }
}
