import { SCOPUS_BASE_URL, SCOPUS_SEARCH_SORT } from '../../../src/integrations/scopus/client';
import type { RecordedResponse } from '../../helpers/fixtures';

/**
 * SYNTHETIC Scopus responses (decision #119): built here in code from the shapes documented by
 * Elsevier (Scopus Search API STANDARD view, Author Retrieval API LIGHT view). No real Scopus
 * response is recorded or committed; every identifier, title, DOI and count below is invented.
 */

export const API_KEY = 'synthetic-test-api-key-0000';
export const INST_TOKEN = 'synthetic-test-inst-token-0000';
export const AUTHOR = '57000000001';
export const OTHER_AUTHOR = '57000000002';

export const authorUrl = (id = AUTHOR) => `${SCOPUS_BASE_URL}/content/author/author_id/${id}?view=LIGHT`;
export const searchUrl = (id: string, start: number, count: number) =>
  `${SCOPUS_BASE_URL}/content/search/scopus?query=${encodeURIComponent(`AU-ID(${id})`)}&view=STANDARD&sort=${encodeURIComponent(SCOPUS_SEARCH_SORT)}&start=${start}&count=${count}`;

/** A cursor-mode request as the client builds it: `cursor` in place of `start`. */
export const cursorUrl = (id: string, cursor: string, count: number) =>
  `${SCOPUS_BASE_URL}/content/search/scopus?query=${encodeURIComponent(`AU-ID(${id})`)}&view=STANDARD&sort=${encodeURIComponent(SCOPUS_SEARCH_SORT)}&cursor=${encodeURIComponent(cursor)}&count=${count}`;

/** A `next` navigation link for a cursor continuation, shaped like the links of Elsevier's search examples. */
export const nextLink = (id: string, cursor: string, count: number, base = SCOPUS_BASE_URL) => ({
  '@_fa': 'true',
  '@ref': 'next',
  '@href': `${base}/content/search/scopus?cursor=${encodeURIComponent(cursor)}&count=${count}&query=${encodeURIComponent(`AU-ID(${id})`)}&view=STANDARD&sort=${encodeURIComponent(SCOPUS_SEARCH_SORT)}`,
  '@type': 'application/json',
});

const json = 'application/json;charset=UTF-8';

export function authorFound(id = AUTHOR, options: { given?: string; surname?: string; documents?: number; returnedId?: string } = {}): RecordedResponse {
  return {
    request: authorUrl(id),
    status: 200,
    contentType: json,
    body: {
      'author-retrieval-response': [
        {
          '@status': 'found',
          '@_fa': 'true',
          coredata: {
            'prism:url': `${SCOPUS_BASE_URL}/content/author/author_id/${options.returnedId ?? id}`,
            'dc:identifier': `AUTHOR_ID:${options.returnedId ?? id}`,
            eid: `9-s2.0-${options.returnedId ?? id}`,
            'document-count': String(options.documents ?? 3),
            'cited-by-count': '42',
            'citation-count': '45',
          },
          'preferred-name': { 'given-name': options.given ?? 'Asha', surname: options.surname ?? 'Verma', 'indexed-name': 'Verma A.' },
        },
      ],
    },
  };
}

/** One synthetic STANDARD-view entry; n chooses distinct IDs, titles and DOIs. */
export function scopusEntry(n: number, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const scopusId = `85000000${String(n).padStart(3, '0')}`;
  return {
    '@_fa': 'true',
    link: [{ '@_fa': 'true', '@ref': 'self', '@href': `${SCOPUS_BASE_URL}/content/abstract/scopus_id/${scopusId}` }],
    'prism:url': `${SCOPUS_BASE_URL}/content/abstract/scopus_id/${scopusId}`,
    'dc:identifier': `SCOPUS_ID:${scopusId}`,
    eid: `2-s2.0-${scopusId}`,
    'dc:title': `Synthetic Scopus study number ${n} on deterministic matching`,
    'dc:creator': 'Verma A.',
    'prism:publicationName': 'Journal of Synthetic Results',
    'prism:issn': '12345678',
    'prism:eIssn': '87654321',
    'prism:volume': '12',
    'prism:issueIdentifier': '3',
    'prism:pageRange': '100-110',
    'prism:coverDate': '2021-03-01',
    'prism:coverDisplayDate': 'March 2021',
    'prism:doi': `10.5555/synthetic.${n}`,
    'citedby-count': String(n * 3),
    affiliation: [{ '@_fa': 'true', affilname: 'Synthetic Institute of Technology', 'affiliation-city': 'Dhanbad', 'affiliation-country': 'India' }],
    'prism:aggregationType': 'Journal',
    subtype: 'ar',
    subtypeDescription: 'Article',
    'source-id': '21100000000',
    openaccess: '0',
    openaccessFlag: false,
    ...overrides,
  };
}

export function searchPage(
  id: string,
  start: number,
  count: number,
  total: number,
  entries: Record<string, unknown>[],
  overrides: Record<string, unknown> = {},
): RecordedResponse {
  return {
    request: searchUrl(id, start, count),
    status: 200,
    contentType: json,
    body: {
      'search-results': {
        'opensearch:totalResults': String(total),
        'opensearch:startIndex': String(start),
        'opensearch:itemsPerPage': String(entries.length),
        'opensearch:Query': { '@role': 'request', '@searchTerms': `AU-ID(${id})`, '@startPage': String(start) },
        link: [],
        entry: entries,
        ...overrides,
      },
    },
  };
}

/** Elsevier's documented empty result: totalResults 0 with one entry {"error": "Result set was empty"}. */
export function emptySearch(id: string, count: number): RecordedResponse {
  return searchPage(id, 0, count, 0, [{ '@_fa': 'true', error: 'Result set was empty' }]);
}

/** Three documents in two pages of two (start 0 and 2). */
export function threeDocumentPages(id = AUTHOR, entries = [scopusEntry(1), scopusEntry(2), scopusEntry(3)]): RecordedResponse[] {
  return [searchPage(id, 0, 2, entries.length, entries.slice(0, 2)), searchPage(id, 2, 2, entries.length, entries.slice(2))];
}

export function status(code: number, headers: Record<string, string> = {}, body: unknown = null): () => Response {
  return () =>
    new Response(body === null ? null : JSON.stringify(body), {
      status: code,
      headers: { 'content-type': json, ...headers },
    });
}

/**
 * One SYNTHETIC cursor-mode page. `next` adds a `next` link carrying that cursor and/or the
 * `cursor/@next` element (in Elsevier's attribute convention; its JSON spelling is unconfirmed).
 */
export function cursorPage(
  id: string,
  cursor: string,
  count: number,
  total: number,
  entries: Record<string, unknown>[],
  next: { cursor: string; via?: 'link' | 'element' | 'both' } | null,
  overrides: Record<string, unknown> = {},
): RecordedResponse {
  const via = next?.via ?? 'both';
  const self = { '@_fa': 'true', '@ref': 'self', '@href': cursorUrl(id, cursor, count), '@type': 'application/json' };
  return {
    request: cursorUrl(id, cursor, count),
    status: 200,
    contentType: json,
    body: {
      'search-results': {
        'opensearch:totalResults': String(total),
        'opensearch:itemsPerPage': String(entries.length),
        'opensearch:Query': { '@role': 'request', '@searchTerms': `AU-ID(${id})` },
        link: next && via !== 'element' ? [self, nextLink(id, next.cursor, count)] : [self],
        ...(next && via !== 'link' ? { cursor: { '@next': next.cursor } } : {}),
        entry: entries,
        ...overrides,
      },
    },
  };
}
