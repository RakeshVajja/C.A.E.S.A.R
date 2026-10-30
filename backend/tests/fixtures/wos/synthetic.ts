import { WOS_SORT_FIELD, WOS_STARTER_BASE_URL } from '../../../src/integrations/wos/client';
import type { RecordedResponse } from '../../helpers/fixtures';

/**
 * SYNTHETIC Web of Science Starter responses (decision #119): built here in code from the shapes in
 * Clarivate's OpenAPI specification (`DocumentsList`, `Document`, `AuthorName`). No real Clarivate
 * response is recorded or committed; every identifier, ResearcherID, title, DOI and count below is
 * invented.
 */

export const API_KEY = 'synthetic-wos-api-key-0000';
/** Well-formed but invented ResearcherIDs. */
export const RID = 'ZZZ-0001-2020';
export const OTHER_RID = 'ZZZ-0002-2020';

export const searchUrl = (rid: string, page: number, limit: number) =>
  `${WOS_STARTER_BASE_URL}/documents?db=WOS&q=${encodeURIComponent(`AI=(${rid})`)}&limit=${limit}&page=${page}&sortField=${encodeURIComponent(WOS_SORT_FIELD)}`;

const json = 'application/json';

/** One synthetic `Document`; n chooses distinct accession numbers, titles, DOIs and Times Cited. */
export function wosDocument(n: number, overrides: Record<string, unknown> = {}, rid = RID): Record<string, unknown> {
  const uid = `WOS:00090000000${String(n).padStart(4, '0')}`;
  const gateway = (type: string) =>
    `https://www.webofscience.com/api/gateway?GWVersion=2&SrcApp=&SrcAuth=WosAPI&KeyUT=${uid}&DestLinkType=${type}&DestApp=WOS`;
  return {
    uid,
    title: `Synthetic Web of Science study number ${n} on deterministic matching`,
    types: ['Article'],
    sourceTypes: ['Article'],
    source: {
      sourceTitle: 'JOURNAL OF SYNTHETIC RESULTS',
      publishYear: 2021,
      publishMonth: 'MAR',
      volume: '12',
      issue: '3',
      pages: { range: '100-110', begin: '100', end: '110', count: 11 },
    },
    names: {
      authors: [
        { displayName: 'Verma, A', wosStandard: 'Verma, A', researcherId: rid },
        { displayName: 'Rao, S', wosStandard: 'Rao, S' },
      ],
    },
    links: { record: gateway('FullRecord'), citingArticles: gateway('CitingArticles'), references: gateway('CitedReferences'), related: gateway('RelatedRecords') },
    citations: [{ db: 'WOS', count: n * 4 }],
    identifiers: { doi: `10.5555/synthetic.wos.${n}`, issn: '1234-5678', eissn: '8765-4321' },
    keywords: { authorKeywords: ['synthetic data'] },
    ...overrides,
  };
}

export function documentsPage(
  rid: string,
  page: number,
  limit: number,
  total: number,
  hits: Record<string, unknown>[],
  overrides: Record<string, unknown> = {},
): RecordedResponse {
  return {
    request: searchUrl(rid, page, limit),
    status: 200,
    contentType: json,
    body: { metadata: { total, page, limit }, hits, ...overrides },
  };
}

/** Three documents in two pages of two (pages 1 and 2). */
export function threeDocumentPages(rid = RID, documents = [wosDocument(1), wosDocument(2), wosDocument(3)]): RecordedResponse[] {
  return [documentsPage(rid, 1, 2, documents.length, documents.slice(0, 2)), documentsPage(rid, 2, 2, documents.length, documents.slice(2))];
}

export function status(code: number, headers: Record<string, string> = {}, body: unknown = null): () => Response {
  return () =>
    new Response(body === null ? null : JSON.stringify(body), {
      status: code,
      headers: { 'content-type': json, ...headers },
    });
}
