import { JCR_BASE_URL, JCR_PAGE_LIMIT } from '../../../src/integrations/jcr/client';
import type { RecordedResponse } from '../../helpers/fixtures';

/**
 * SYNTHETIC Web of Science Journals API (JCR) responses (decision #119), built in code from the
 * shapes in Clarivate's OpenAPI specification (`JournalList`, `JournalRecord`,
 * `JournalHistoryRecord`, `JournalReports`, `/last-updated`). No real JCR response is recorded or
 * committed; every journal identifier, title, ISSN and metric below is invented. The ISSNs are
 * check-digit-valid values in an invented 9999- range.
 */

export const API_KEY = 'synthetic-jcr-api-key-0000';

export const ISSN = {
  A_PRINT: '9999-0016',
  A_ONLINE: '9999-0024',
  A_PREVIOUS: '9999-0032',
  B_PRINT: '9999-0040',
  SHARED: '9999-0059', // claimed by two journals: ambiguous
  C_PRINT: '9999-0067',
  NOT_IN_JCR: '9999-0075',
  D_PRINT: '9999-0083',
} as const;

const json = 'application/json';
const ok = (request: string, body: unknown): RecordedResponse => ({ request, status: 200, contentType: json, body });

export const lastUpdatedUrl = () => `${JCR_BASE_URL}/last-updated`;
export const searchUrl = (issn: string, page = 1) => `${JCR_BASE_URL}/journals?q=${encodeURIComponent(issn)}&limit=${JCR_PAGE_LIMIT}&page=${page}`;
export const journalUrl = (id: string) => `${JCR_BASE_URL}/journals/${encodeURIComponent(id)}`;
export const historyUrl = (id: string) => `${journalUrl(id)}/history`;
export const reportUrl = (id: string, year: number) => `${journalUrl(id)}/reports/year/${year}`;

export const lastUpdated = (date = '2026-06-18') => ok(lastUpdatedUrl(), { jcrDataUpdate: date });

export function search(issn: string, ids: string[], options: { total?: number; page?: number } = {}): RecordedResponse {
  return ok(searchUrl(issn, options.page ?? 1), {
    metadata: { total: options.total ?? ids.length, page: options.page ?? 1, limit: JCR_PAGE_LIMIT },
    hits: ids.map((id) => ({ id, self: `/journals/${id}`, name: `Synthetic journal ${id}` })),
  });
}

export interface JournalSpec {
  id: string;
  name?: string;
  issn?: string | null;
  eIssn?: string | null;
  previousIssn?: string[];
  reportYears?: number[];
}

export function journalRecord(spec: JournalSpec): RecordedResponse {
  return ok(journalUrl(spec.id), {
    id: spec.id,
    name: spec.name ?? `Synthetic Journal ${spec.id}`,
    jcrTitle: `SYNTH J ${spec.id}`,
    isoTitle: `Synth. J. ${spec.id}`,
    issn: spec.issn ?? null,
    eIssn: spec.eIssn ?? null,
    previousIssn: spec.previousIssn ?? [],
    publisher: { id: 'SYNTH_PUB', name: 'SYNTHETIC PUBLISHER LTD', address: 'NOWHERE', countryRegion: 'NOWHERE' },
    frequency: 12,
    firstIssueYear: 2001,
    language: 'English',
    categories: [{ url: '/categories/ZZ', name: 'SYNTHETIC SCIENCE', edition: 'SCIE' }],
    journalCitationReports: (spec.reportYears ?? [2020, 2021, 2022]).map((year) => ({ year, url: `/journals/${spec.id}/reports/year/${year}` })),
  });
}

export function history(id: string, issns: { issn: string; start?: number; end?: number }[] = []): RecordedResponse {
  return ok(historyUrl(id), {
    name: [{ name: `Synthetic Journal ${id}`, year: { start: 2001, end: 2022 } }],
    issn: issns.map((row) => ({ issn: row.issn, year: { start: row.start, end: row.end } })),
  });
}

/** A yearly report; `overrides` replace top-level fields, `impact` the impact metrics. */
export function report(id: string, year: number, options: { jif?: string; impact?: Record<string, unknown>; ranks?: Record<string, unknown>; overrides?: Record<string, unknown> } = {}): RecordedResponse {
  return ok(reportUrl(id, year), {
    year,
    suppressed: false,
    onHold: false,
    delisted: false,
    journal: { id, self: `/journals/${id}`, name: `Synthetic Journal ${id}` },
    metrics: {
      impactMetrics: { totalCites: 1200 + year, jif: options.jif ?? '2.345', jifWithoutSelfCitations: '2.100', jif5Years: 2.9, immediacyIndex: 0.4, jci: 1.1, ...options.impact },
      influenceMetrics: { eigenFactor: { score: 0.001, normalized: 0.2 }, articleInfluence: 0.5 },
      sourceMetrics: { citableItems: { total: 80, articlesPercentage: 95 }, jifPercentile: 71.5, halfLife: {} },
    },
    ranks: options.ranks ?? {
      jif: [
        { category: 'Synthetic  Science, Applied', edition: 'SCIE', self: '/categories/ZZ_SCIE', rank: '12/120', quartile: 'Q1', jifPercentile: 90.4 },
        { category: 'SYNTHETIC SOCIAL STUDIES', edition: 'SSCI', self: '/categories/ZY_SSCI', rank: '40/80', quartile: 'Q2', jifPercentile: 50.6 },
      ],
      jci: [{ category: 'SYNTHETIC SCIENCE, APPLIED', rank: '15/130', quartile: 'Q1', jciPercentile: 88.8 }],
      esiCitations: [],
    },
    journalData: {},
    sourceData: {},
    ...options.overrides,
  });
}

export function status(code: number, body: unknown = null): () => Response {
  return () => new Response(body === null ? null : JSON.stringify(body), { status: code, headers: { 'content-type': json } });
}
