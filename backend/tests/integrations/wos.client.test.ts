import { describe, expect, it } from 'vitest';
import { FetchError } from '../../src/integrations/http/httpClient';
import {
  attributedAuthors,
  normalizeResearcherId,
  researcherIdFromProfileUrl,
  researcherQuery,
  WOS_MAX_RESULTS,
  WOS_PAGE_LIMIT,
  WOS_SORT_FIELD,
  WosStarterClient,
  wosProfileUrl,
} from '../../src/integrations/wos/client';
import { WosDocumentSchema } from '../../src/integrations/wos/types';
import { noSleep, replayFetch, Route } from '../helpers/fixtures';
import { API_KEY, documentsPage, OTHER_RID, RID, searchUrl, status, threeDocumentPages, wosDocument } from '../fixtures/wos/synthetic';

/* Web of Science Starter client (stage 15.4) — synthetic responses only; no network, no real credentials. */

function wos(recorded = threeDocumentPages(), overrides: Record<string, Route> = {}, options: { maxRetries?: number; maxResults?: number; sleeps?: number[] } = {}) {
  const replay = replayFetch(recorded, overrides);
  const sleeps = options.sleeps ?? [];
  const client = new WosStarterClient({
    apiKey: API_KEY,
    perPage: 2,
    maxResults: options.maxResults,
    http: { maxRetries: options.maxRetries ?? 0, timeoutMs: 1_000 },
    deps: { fetchImpl: replay.fetchImpl, sleep: async (ms) => void sleeps.push(ms) },
  });
  return { client, calls: replay.calls, sleeps };
}

async function failure(promise: Promise<unknown>): Promise<FetchError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(FetchError);
    return error as FetchError;
  }
  throw new Error('expected a FetchError');
}

describe('ResearcherIDs', () => {
  it('accepts 1–3 letters, 4 digits and a year, upper-casing input, and author-record URLs naming the ResearcherID', () => {
    expect(normalizeResearcherId('A-1009-2008')).toBe('A-1009-2008');
    expect(normalizeResearcherId(' aag-1344-2019 ')).toBe('AAG-1344-2019');
    expect(normalizeResearcherId('GGU-9939-2022')).toBe('GGU-9939-2022');
    expect(normalizeResearcherId('https://www.webofscience.com/wos/author/record/AAG-1344-2019')).toBe('AAG-1344-2019');
    expect(normalizeResearcherId('https://www.webofscience.com/wos/author/rid/a-1009-2008/')).toBe('A-1009-2008');
  });

  it('rejects malformed ResearcherIDs', () => {
    const malformed = [
      '', '   ', 'A10092008', 'A-1009-08', 'A-109-2008', 'A-10090-2008', 'ABCD-1009-2008', '1-1009-2008', 'A-1009-1899', 'A-1009-2108',
      'A_1009_2008', 'A-1009-2008x', 'A–1009–2008', '57000000001', '0000-0002-1825-0097', 'Ä-1009-2008', 'A-1009-2008\nB-1009-2008',
      'https://www.webofscience.com/wos/author/record/1234567', 'https://publons.com/researcher/1234567/', 'https://example.org/wos/author/record/A-1009-2008',
    ];
    for (const bad of malformed) expect(() => normalizeResearcherId(bad), JSON.stringify(bad)).toThrow(FetchError);
  });

  it('reads evidence only from webofscience.com author-record URLs', () => {
    expect(researcherIdFromProfileUrl('https://webofscience.com/wos/author/record/AAG-1344-2019')).toBe('AAG-1344-2019');
    expect(researcherIdFromProfileUrl('http://www.webofscience.com/wos/author/rid/AAG-1344-2019')).toBe('AAG-1344-2019');
    expect(researcherIdFromProfileUrl('https://www.webofscience.com.evil.example/wos/author/record/AAG-1344-2019')).toBeNull();
    expect(researcherIdFromProfileUrl('https://user:pw@www.webofscience.com/wos/author/record/AAG-1344-2019')).toBeNull();
    expect(researcherIdFromProfileUrl('https://www.webofscience.com:8443/wos/author/record/AAG-1344-2019')).toBeNull();
    expect(researcherIdFromProfileUrl('https://www.webofscience.com/wos/woscc/full-record/WOS:000222526200005')).toBeNull();
    expect(researcherIdFromProfileUrl('https://www.webofscience.com/wos/author/record/AAG-1344-2019/extra')).toBeNull();
    expect(researcherIdFromProfileUrl('ftp://www.webofscience.com/wos/author/record/AAG-1344-2019')).toBeNull();
    expect(researcherIdFromProfileUrl('not a url')).toBeNull();
    expect(wosProfileUrl('AAG-1344-2019')).toBe('https://www.webofscience.com/wos/author/rid/AAG-1344-2019');
  });

  it('builds the AI= query and matches authors by ResearcherID, case-insensitively', () => {
    expect(researcherQuery('A-1009-2008')).toBe('AI=(A-1009-2008)');
    const document = WosDocumentSchema.parse(
      wosDocument(1, { names: { authors: [{ displayName: 'Verma, A', researcherId: ' zzz-0001-2020 ' }, { displayName: 'Rao, S', researcherId: OTHER_RID }, { displayName: 'Nobody' }] } }),
    );
    expect(attributedAuthors(document, RID).map((a) => a.displayName)).toEqual(['Verma, A']);
    expect(attributedAuthors(WosDocumentSchema.parse(wosDocument(1, { names: null })), RID)).toEqual([]);
  });
});

describe('requests and authentication', () => {
  it('searches db=WOS by AI=, 50 per page by default, in a fixed order, with the API key only in a header', async () => {
    expect(WOS_PAGE_LIMIT).toBe(50);
    expect(WOS_SORT_FIELD).toBe('LD+A,PY+A');
    const replay = replayFetch([documentsPage(RID, 1, 50, 0, [])]);
    const client = new WosStarterClient({ apiKey: API_KEY, http: { maxRetries: 0 }, deps: { fetchImpl: replay.fetchImpl, sleep: noSleep } });
    await client.fetchResearcherDocuments(RID);
    const url = new URL(replay.calls[0].url);
    expect(url.origin + url.pathname).toBe('https://api.clarivate.com/apis/wos-starter/v1/documents');
    expect(Object.fromEntries(url.searchParams)).toEqual({ db: 'WOS', q: 'AI=(ZZZ-0001-2020)', limit: '50', page: '1', sortField: 'LD+A,PY+A' });
    expect(url.search).toContain('sortField=LD%2BA%2CPY%2BA'); // "+" encoded, or it would be read as a space
    expect(replay.calls[0].headers['x-apikey']).toBe(API_KEY);
    expect(replay.calls[0].headers.accept).toBe('application/json');
    expect(replay.calls[0].url).not.toContain(API_KEY);
  });

  it('never sends the key in a URL across pages', async () => {
    const { client, calls } = wos();
    await client.fetchResearcherDocuments(RID);
    expect(calls).toHaveLength(2);
    for (const call of calls) {
      expect(call.url).not.toContain(API_KEY);
      expect(call.headers['x-apikey']).toBe(API_KEY);
    }
  });
});

describe('document search', () => {
  it('pages through every result (pages from 1) and keeps the documents in order', async () => {
    const { client, calls } = wos();
    const result = await client.fetchResearcherDocuments(RID);
    expect(result.reportedCount).toBe(3);
    expect(result.documents.map((d) => d.uid)).toEqual(['WOS:000900000000001', 'WOS:000900000000002', 'WOS:000900000000003']);
    expect(calls.map((c) => c.url)).toEqual([searchUrl(RID, 1, 2), searchUrl(RID, 2, 2)]);
  });

  it('an empty result is a valid zero, with an empty or absent hits list', async () => {
    expect(await wos([documentsPage(RID, 1, 2, 0, [])]).client.fetchResearcherDocuments(RID)).toEqual({ documents: [], reportedCount: 0 });
    const absent = documentsPage(RID, 1, 2, 0, []);
    delete (absent.body as Record<string, unknown>).hits;
    expect((await wos([absent]).client.fetchResearcherDocuments(RID)).reportedCount).toBe(0);
  });

  it('a page without documents before the total, duplicate UIDs and a changing total are INCOMPLETE', async () => {
    const cases = [
      [documentsPage(RID, 1, 2, 3, [wosDocument(1), wosDocument(2)]), documentsPage(RID, 2, 2, 3, [])],
      [documentsPage(RID, 1, 2, 3, [wosDocument(1), wosDocument(2)]), documentsPage(RID, 2, 2, 3, [wosDocument(2)])],
      [documentsPage(RID, 1, 2, 3, [wosDocument(1), wosDocument(2)]), documentsPage(RID, 2, 2, 4, [wosDocument(3)])],
      [documentsPage(RID, 1, 2, 3, [wosDocument(1)]), documentsPage(RID, 2, 2, 3, [wosDocument(3)])], // a short page leaves a gap
    ];
    for (const pages of cases) {
      const error = await failure(wos(pages).client.fetchResearcherDocuments(RID));
      expect(error.kind).toBe('INCOMPLETE');
    }
    const repeated = await failure(wos(cases[1]).client.fetchResearcherDocuments(RID));
    expect(repeated.message).toBe(`Web of Science reported 3 documents for ResearcherID ${RID} but paging returned 2 distinct documents (1 repeated)`);
  });

  it('more documents than the application safety limit is INCOMPLETE without further requests', async () => {
    expect(WOS_MAX_RESULTS).toBe(10_000);
    const { client, calls } = wos([documentsPage(RID, 1, 2, 5, [wosDocument(1), wosDocument(2)])], {}, { maxResults: 4 });
    const error = await failure(client.fetchResearcherDocuments(RID));
    expect(error.kind).toBe('INCOMPLETE');
    expect(error.message).toContain('more than this application\'s safety limit of 4');
    expect(error.message).toContain('no Web of Science records or Times Cited were saved');
    expect(calls).toHaveLength(1);
  });

  it('malformed pages and documents are invalid responses', async () => {
    const pages: unknown[] = [
      { hits: [] }, // no metadata
      { metadata: { page: 1, limit: 2 }, hits: [] }, // no total
      { metadata: { total: '3', page: 1, limit: 2 }, hits: [] },
      { metadata: { total: -1 }, hits: [] },
      { metadata: { total: 3, page: 2, limit: 2 }, hits: [] }, // a different page answered
      { metadata: { total: 3, page: 1, limit: 10 }, hits: [] }, // a different page size answered
      { metadata: { total: 3, page: 1, limit: 2 }, hits: [wosDocument(1), wosDocument(2), wosDocument(3)] }, // more hits than the page size
      { metadata: { total: 0, page: 1, limit: 2 }, hits: [wosDocument(1)] },
      { error: { status: 500, title: 'synthetic', details: 'synthetic' } },
      [],
    ];
    for (const body of pages) {
      const error = await failure(wos([], { [searchUrl(RID, 1, 2)]: status(200, {}, body) }).client.fetchResearcherDocuments(RID));
      expect(error.kind, JSON.stringify(body).slice(0, 80)).toBe('INVALID_RESPONSE');
    }
    const documents = [
      wosDocument(1, { uid: '000900000000001' }),
      wosDocument(1, { uid: 'PPRN:000900000000001' }),
      wosDocument(1, { uid: 'WOS:abc' }),
      wosDocument(1, { title: 42 }),
      wosDocument(1, { source: { publishYear: '2021' } }),
      wosDocument(1, { citations: [{ db: 'WOS', count: -1 }] }),
      wosDocument(1, { names: { authors: 'Verma, A' } }),
      'not a document',
    ];
    for (const document of documents) {
      const error = await failure(wos([documentsPage(RID, 1, 2, 1, [document as Record<string, unknown>])]).client.fetchResearcherDocuments(RID));
      expect(error.kind, JSON.stringify(document).slice(0, 80)).toBe('INVALID_RESPONSE');
    }
  });

  it('HTML and malformed JSON with HTTP 200 are failures', async () => {
    const html = () => new Response('<!DOCTYPE html><html>Sign in</html>', { status: 200, headers: { 'content-type': 'text/html' } });
    expect((await failure(wos([], { [searchUrl(RID, 1, 2)]: html }).client.fetchResearcherDocuments(RID))).kind).toBe('CONTENT_TYPE');
    const broken = () => new Response('{"metadata": {', { status: 200, headers: { 'content-type': 'application/json' } });
    expect((await failure(wos([], { [searchUrl(RID, 1, 2)]: broken }).client.fetchResearcherDocuments(RID))).kind).toBe('MALFORMED_BODY');
  });

  it('a stored identifier that is not a ResearcherID is refused before any request', async () => {
    const { client, calls } = wos();
    expect((await failure(client.fetchResearcherDocuments('57000000001'))).kind).toBe('INVALID_RESPONSE');
    expect(calls).toHaveLength(0);
  });
});

describe('failures, retries and rate limits', () => {
  it('classifies 401, 403 and 429 with fixed, actionable messages', async () => {
    const cases: [number, string, string][] = [
      [401, 'AUTH_FAILED', 'Web of Science: HTTP 401 (the API key was refused; check WOS_STARTER_API_KEY)'],
      [403, 'NOT_ENTITLED', 'Web of Science: HTTP 403 (this API key is not entitled to the Web of Science Starter data requested)'],
      [429, 'QUOTA_EXCEEDED', 'Web of Science: HTTP 429 (rate limit or daily quota still exceeded after retries; synchronize again later)'],
    ];
    for (const [code, kind, message] of cases) {
      const { client, calls } = wos([], { [searchUrl(RID, 1, 2)]: status(code, {}, { error_description: 'synthetic', error: 'invalid_request' }) });
      expect(await failure(client.fetchResearcherDocuments(RID)), String(code)).toMatchObject({ kind, message, details: { status: code } });
      expect(calls).toHaveLength(1);
    }
  });

  it('retries 429 honouring Retry-After, then reports QUOTA_EXCEEDED', async () => {
    const { client, calls, sleeps } = wos([], { [searchUrl(RID, 1, 2)]: status(429, { 'Retry-After': '3' }) }, { maxRetries: 2 });
    expect((await failure(client.fetchResearcherDocuments(RID))).kind).toBe('QUOTA_EXCEEDED');
    expect(calls).toHaveLength(3);
    expect(sleeps.filter((ms) => ms === 3_000)).toHaveLength(2);
  });

  it('retries 5xx, rate limits and network errors on a later page, then succeeds', async () => {
    let attempts = 0;
    const flaky = () => {
      attempts++;
      if (attempts === 1) return status(503)();
      if (attempts === 2) return status(429, { 'Retry-After': '1' })();
      if (attempts === 3) throw new TypeError('synthetic network failure');
      return status(200, {}, threeDocumentPages()[1].body)();
    };
    const { client } = wos([threeDocumentPages()[0]], { [searchUrl(RID, 2, 2)]: flaky }, { maxRetries: 3 });
    expect((await client.fetchResearcherDocuments(RID)).documents).toHaveLength(3);
    expect(attempts).toBe(4);
  });

  it('a request that never answers times out', async () => {
    const hanging = new WosStarterClient({
      apiKey: API_KEY,
      http: { timeoutMs: 20, maxRetries: 0 },
      deps: {
        sleep: noSleep,
        fetchImpl: ((_url: string, init?: RequestInit) =>
          new Promise((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(new Error('aborted'))))) as typeof fetch,
      },
    });
    expect(await failure(hanging.fetchResearcherDocuments(RID))).toMatchObject({ kind: 'TIMEOUT', message: 'Web of Science: request timed out' });
  });

  it('no provider text or credential reaches an error message', async () => {
    const LEAK = 'SYNTHETIC-PROVIDER-TEXT-7f3a';
    const body = { error: { status: 400, title: LEAK, details: LEAK }, message: LEAK, error_description: LEAK };
    const errors = [];
    for (const code of [400, 401, 403, 404, 405, 429, 500]) {
      errors.push(await failure(wos([], { [searchUrl(RID, 1, 2)]: status(code, { 'x-error': LEAK }, body) }).client.fetchResearcherDocuments(RID)));
    }
    const text = () => new Response(LEAK, { status: 200, headers: { 'content-type': `text/plain; ${LEAK}` } });
    errors.push(await failure(wos([], { [searchUrl(RID, 1, 2)]: text }).client.fetchResearcherDocuments(RID)));
    const thrower = () => {
      throw new TypeError(LEAK);
    };
    errors.push(await failure(wos([], { [searchUrl(RID, 1, 2)]: thrower }).client.fetchResearcherDocuments(RID)));
    errors.push(await failure(wos([], { [searchUrl(RID, 1, 2)]: status(200, {}, { error: { details: LEAK } }) }).client.fetchResearcherDocuments(RID)));
    expect(errors.map((e) => e.kind)).toEqual(['HTTP_STATUS', 'AUTH_FAILED', 'NOT_ENTITLED', 'HTTP_STATUS', 'HTTP_STATUS', 'QUOTA_EXCEEDED', 'HTTP_STATUS', 'CONTENT_TYPE', 'NETWORK', 'INVALID_RESPONSE']);
    for (const error of errors) {
      expect(error.message).not.toContain(LEAK);
      expect(error.message).not.toContain(API_KEY);
      expect(error.details.url ?? '').not.toContain(API_KEY);
    }
    expect(errors[0].message).toBe('Web of Science: HTTP 400 (request refused by Web of Science)');
  });
});

describe('identity preview', () => {
  it('returns the author name carried by the ResearcherID, the document total and the record link, with one request', async () => {
    const page = documentsPage(RID, 1, 2, 7, [
      wosDocument(1, { names: { authors: [{ displayName: 'Rao, S' }, { displayName: 'Verma, Asha', wosStandard: 'Verma, A', researcherId: RID }] } }),
      wosDocument(2),
    ]);
    const { client, calls } = wos([page]);
    expect(await client.previewResearcher(' zzz-0001-2020 ')).toEqual({
      researcherId: RID,
      name: 'Verma, Asha',
      documentCount: 7,
      profileUrl: `https://www.webofscience.com/wos/author/rid/${RID}`,
    });
    expect(calls).toHaveLength(1);
  });

  it('no linked document is IDENTITY_NOT_FOUND; documents not listing the ResearcherID are IDENTITY_INVALID', async () => {
    expect((await failure(wos([documentsPage(RID, 1, 2, 0, [])]).client.previewResearcher(RID))).kind).toBe('IDENTITY_NOT_FOUND');
    const others = documentsPage(RID, 1, 2, 2, [wosDocument(1, {}, OTHER_RID), wosDocument(2, {}, OTHER_RID)]);
    expect((await failure(wos([others]).client.previewResearcher(RID))).kind).toBe('IDENTITY_INVALID');
  });
});
