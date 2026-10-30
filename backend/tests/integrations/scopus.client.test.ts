import { describe, expect, it } from 'vitest';
import { FetchError } from '../../src/integrations/http/httpClient';
import {
  normalizeScopusAuthorId,
  ScopusClient,
  scopusAuthorIdFromUrl,
  scopusEid,
  SCOPUS_AUTHOR_ID_MAX_DIGITS,
  SCOPUS_OFFSET_LIMIT,
  SCOPUS_SEARCH_SORT,
} from '../../src/integrations/scopus/client';
import { noSleep, replayFetch, Route } from '../helpers/fixtures';
import {
  API_KEY,
  AUTHOR,
  authorFound,
  authorUrl,
  cursorPage,
  cursorUrl,
  emptySearch,
  INST_TOKEN,
  nextLink,
  OTHER_AUTHOR,
  scopusEntry,
  searchPage,
  searchUrl,
  status,
  threeDocumentPages,
} from '../fixtures/scopus/synthetic';

/* Scopus client (stage 15.3) — synthetic responses only; no network, no real credentials. */

function scopus(recorded = [authorFound(), ...threeDocumentPages()], overrides: Record<string, Route> = {}, options: { instToken?: string | null; maxRetries?: number; sleeps?: number[] } = {}) {
  const replay = replayFetch(recorded, overrides);
  const sleeps = options.sleeps ?? [];
  const client = new ScopusClient({
    apiKey: API_KEY,
    instToken: options.instToken === undefined ? INST_TOKEN : options.instToken,
    perPage: 2,
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

describe('Scopus identifiers', () => {
  it('normalizes Author IDs from digits, prefixed forms and profile URLs', () => {
    expect(normalizeScopusAuthorId(' 57000000001 ')).toBe('57000000001');
    expect(normalizeScopusAuthorId('AUTHOR_ID:57000000001')).toBe('57000000001');
    expect(normalizeScopusAuthorId('9-s2.0-57000000001')).toBe('57000000001');
    expect(normalizeScopusAuthorId('https://www.scopus.com/authid/detail.uri?authorId=57000000001')).toBe('57000000001');
  });

  it('accepts any numeric Author ID up to the application safety limit (no Elsevier length rule)', () => {
    expect(SCOPUS_AUTHOR_ID_MAX_DIGITS).toBe(20);
    expect(normalizeScopusAuthorId('7')).toBe('7');
    expect(normalizeScopusAuthorId('100038831')).toBe('100038831'); // the 9-digit ID of Elsevier's own search example
    expect(normalizeScopusAuthorId('9'.repeat(20))).toBe('9'.repeat(20));
    expect(normalizeScopusAuthorId(`AUTHOR_ID:${'1'.repeat(20)}`)).toBe('1'.repeat(20));
    expect(() => normalizeScopusAuthorId('9'.repeat(21))).toThrow(FetchError);
    expect(normalizeScopusAuthorId('https://www.scopus.com/authid/detail.uri?authorId=123')).toBe('123');
    expect(scopusAuthorIdFromUrl(`https://www.scopus.com/authid/detail.uri?authorId=${'9'.repeat(21)}`)).toBeNull();
  });

  it('rejects malformed Author IDs', () => {
    const malformed = [
      '', '   ', 'abc', 'A-1009-2008', '57000000001x', '0000-0002-1825-0097', '-57000000001', '+57000000001', '5700 0000001',
      '57,000,000,001', '5.7e10', '0x1F', '５７０００', '57000000001\n2', 'AUTHOR_ID:', '9-s2.0-', 'https://example.org/?authorId=57000000001',
    ];
    for (const bad of malformed) {
      expect(() => normalizeScopusAuthorId(bad), JSON.stringify(bad)).toThrow(FetchError);
    }
  });

  it('accepts evidence only from scopus.com profile URLs', () => {
    expect(scopusAuthorIdFromUrl('https://www.scopus.com/authid/detail.uri?authorId=57000000001&origin=x')).toBe('57000000001');
    expect(scopusAuthorIdFromUrl('https://scopus.com/authid/detail.uri?authorId=57000000001')).toBe('57000000001');
    expect(scopusAuthorIdFromUrl('https://www.scopus.com.evil.example/authid/detail.uri?authorId=57000000001')).toBeNull();
    expect(scopusAuthorIdFromUrl('ftp://www.scopus.com/?authorId=57000000001')).toBeNull();
    expect(scopusAuthorIdFromUrl('https://www.scopus.com/authid/detail.uri')).toBeNull();
    expect(scopusAuthorIdFromUrl('not a url')).toBeNull();
  });

  it('derives the EID from dc:identifier', () => {
    expect(scopusEid('SCOPUS_ID:85000000001')).toBe('2-s2.0-85000000001');
  });
});

describe('Scopus authentication', () => {
  it('sends the API key and institutional token as headers, never in the URL', async () => {
    const { client, calls } = scopus();
    await client.fetchAuthorDocuments(AUTHOR);
    expect(calls).toHaveLength(3);
    for (const call of calls) {
      expect(call.headers['x-els-apikey']).toBe(API_KEY);
      expect(call.headers['x-els-insttoken']).toBe(INST_TOKEN);
      expect(call.headers.accept).toBe('application/json');
      expect(call.url).not.toContain(API_KEY);
      expect(call.url).not.toContain(INST_TOKEN);
    }
  });

  it('omits the institutional token header when none is configured', async () => {
    const { client, calls } = scopus(undefined, {}, { instToken: null });
    await client.validateAuthor(AUTHOR);
    expect(calls[0].headers['x-els-insttoken']).toBeUndefined();
  });

  it('classifies 401, 403 and 429 with fixed, actionable messages', async () => {
    for (const [code, kind] of [[401, 'AUTH_FAILED'], [403, 'NOT_ENTITLED'], [429, 'QUOTA_EXCEEDED']] as const) {
      const body = { 'service-error': { status: { statusCode: 'AUTHORIZATION_ERROR', statusText: 'synthetic' } } };
      const { client, calls } = scopus([], { [authorUrl()]: status(code, {}, body) });
      const error = await failure(client.validateAuthor(AUTHOR));
      expect(error.kind, String(code)).toBe(kind);
      expect(error.details.status).toBe(code);
      expect(error.message).not.toContain(API_KEY);
      expect(calls).toHaveLength(1);
    }
  });

  it('does not retry an exhausted weekly quota (X-ELS-Status: QUOTA_EXCEEDED)', async () => {
    const { client, calls } = scopus([], { [authorUrl()]: status(429, { 'X-ELS-Status': 'QUOTA_EXCEEDED - Quota Exceeded', 'X-RateLimit-Reset': '1792000000' }) }, { maxRetries: 3 });
    const error = await failure(client.validateAuthor(AUTHOR));
    expect(error.kind).toBe('QUOTA_EXCEEDED');
    expect(error.message).toBe("Scopus: HTTP 429 (the API key's weekly quota is exhausted; synchronize again after it resets)");
    expect(calls).toHaveLength(1);
  });

  it('retries other 429s honouring Retry-After, then reports QUOTA_EXCEEDED', async () => {
    const { client, calls, sleeps } = scopus([], { [authorUrl()]: status(429, { 'Retry-After': '2' }) }, { maxRetries: 2 });
    const error = await failure(client.validateAuthor(AUTHOR));
    expect(error.kind).toBe('QUOTA_EXCEEDED');
    expect(error.message).toBe('Scopus: HTTP 429 (rate limit still exceeded after retries; synchronize again later)');
    expect(calls).toHaveLength(3);
    expect(sleeps.filter((ms) => ms === 2_000)).toHaveLength(2);
  });
});

describe('Scopus author validation', () => {
  it('returns the author with name, document count and profile URL', async () => {
    const { client } = scopus();
    expect(await client.validateAuthor(AUTHOR)).toEqual({
      authorId: AUTHOR,
      name: 'Asha Verma',
      documentCount: 3,
      profileUrl: `https://www.scopus.com/authid/detail.uri?authorId=${AUTHOR}`,
    });
  });

  it('a missing profile is IDENTITY_NOT_FOUND', async () => {
    const { client } = scopus([], { [authorUrl()]: status(404) });
    expect((await failure(client.validateAuthor(AUTHOR))).kind).toBe('IDENTITY_NOT_FOUND');
  });

  it('a replaced (merged) profile is IDENTITY_INVALID and the redirect is never followed', async () => {
    const successor = `https://api.elsevier.com/content/author/author_id/${OTHER_AUTHOR}`;
    const { client, calls } = scopus([], { [authorUrl()]: status(301, { location: successor }) });
    const error = await failure(client.validateAuthor(AUTHOR));
    expect(error).toMatchObject({ kind: 'IDENTITY_INVALID', details: { status: 301 } });
    expect(error.message).toContain(`replaced by author ${OTHER_AUTHOR}`);
    expect(calls.map((c) => c.url)).toEqual([authorUrl()]);

    const several = scopus([], { [authorUrl()]: status(300) });
    expect((await failure(several.client.validateAuthor(AUTHOR))).message).toContain('several author profiles');
  });

  it('a profile answering for a different Author ID is refused', async () => {
    const { client } = scopus([authorFound(AUTHOR, { returnedId: OTHER_AUTHOR })]);
    const error = await failure(client.validateAuthor(AUTHOR));
    expect(error.kind).toBe('IDENTITY_INVALID');
    expect(error.message).toContain(`answered author ${OTHER_AUTHOR}`);
  });

  it('HTML, malformed JSON and error payloads with HTTP 200 are failures', async () => {
    const html = () => new Response('<!DOCTYPE html><html>Sign in</html>', { status: 200, headers: { 'content-type': 'text/html' } });
    expect((await failure(scopus([], { [authorUrl()]: html }).client.validateAuthor(AUTHOR))).kind).toBe('CONTENT_TYPE');
    const broken = () => new Response('{"author-retrieval-response": [', { status: 200, headers: { 'content-type': 'application/json' } });
    expect((await failure(scopus([], { [authorUrl()]: broken }).client.validateAuthor(AUTHOR))).kind).toBe('MALFORMED_BODY');
    const serviceError = status(200, {}, { 'service-error': { status: { statusCode: 'GENERAL_SYSTEM_ERROR' } } });
    expect((await failure(scopus([], { [authorUrl()]: serviceError }).client.validateAuthor(AUTHOR))).kind).toBe('INVALID_RESPONSE');
  });
});

describe('Scopus provider text is never copied into errors', () => {
  const LEAK = 'SYNTHETIC-PROVIDER-TEXT-7f3a';
  const leakyBody = { message: LEAK, error: LEAK, exception: LEAK, 'developer-message': LEAK, 'service-error': { status: { statusCode: LEAK, statusText: LEAK } } };

  it('HTTP failures carry fixed messages whatever the response body and headers say', async () => {
    const cases: [number, string, string][] = [
      [400, 'HTTP_STATUS', 'Scopus: HTTP 400 (request refused by Scopus)'],
      [404, 'HTTP_STATUS', 'Scopus: HTTP 404 (request refused by Scopus)'],
      [500, 'HTTP_STATUS', 'Scopus: HTTP 500 (Scopus service error, after retries; synchronize again later)'],
      [401, 'AUTH_FAILED', 'Scopus: HTTP 401 (the API key or institutional token was refused; check SCOPUS_API_KEY and SCOPUS_INST_TOKEN)'],
      [403, 'NOT_ENTITLED', "Scopus: HTTP 403 (these credentials are not entitled to this data; the institution's Scopus API access must cover it)"],
    ];
    for (const [code, kind, message] of cases) {
      const route = status(code, { 'x-els-status': LEAK, 'www-authenticate': LEAK }, leakyBody);
      const error = await failure(scopus([], { [searchUrl(AUTHOR, 0, 2)]: route }).client.fetchDocuments(AUTHOR));
      expect(error, String(code)).toMatchObject({ kind, message, details: { status: code } });
      expect(JSON.stringify({ message: error.message, details: error.details })).not.toContain(LEAK);
    }
  });

  it('non-JSON and malformed bodies, odd profile statuses and mismatching EIDs are reported without their content', async () => {
    const html = () => new Response(`<!DOCTYPE html><html>${LEAK}</html>`, { status: 200, headers: { 'content-type': `text/html; ${LEAK}` } });
    const text = () => new Response(LEAK, { status: 200, headers: { 'content-type': `text/plain; ${LEAK}` } });
    const broken = () => new Response(`{"${LEAK}": [`, { status: 200, headers: { 'content-type': 'application/json' } });
    const oddStatus = authorFound();
    ((oddStatus.body as Record<string, Record<string, unknown>[]>)['author-retrieval-response'][0])['@status'] = LEAK;
    const errors = [
      await failure(scopus([], { [authorUrl()]: html }).client.validateAuthor(AUTHOR)),
      await failure(scopus([], { [authorUrl()]: text }).client.validateAuthor(AUTHOR)),
      await failure(scopus([], { [authorUrl()]: broken }).client.validateAuthor(AUTHOR)),
      await failure(scopus([oddStatus]).client.validateAuthor(AUTHOR)),
      await failure(scopus([searchPage(AUTHOR, 0, 2, 1, [scopusEntry(1, { eid: LEAK })])]).client.fetchDocuments(AUTHOR)),
      await failure(scopus([], { [authorUrl()]: status(400, {}, leakyBody) }).client.validateAuthor(AUTHOR)),
    ];
    expect(errors.map((e) => e.kind)).toEqual(['CONTENT_TYPE', 'CONTENT_TYPE', 'MALFORMED_BODY', 'IDENTITY_INVALID', 'INVALID_RESPONSE', 'HTTP_STATUS']);
    for (const error of errors) expect(error.message).not.toContain(LEAK);
  });

  it('network failures do not echo the underlying error text', async () => {
    const thrower = () => {
      throw new TypeError(LEAK);
    };
    const error = await failure(scopus([], { [authorUrl()]: thrower }).client.validateAuthor(AUTHOR));
    expect(error).toMatchObject({ kind: 'NETWORK', message: 'Scopus: network error (Scopus could not be reached)' });
  });
});

describe('Scopus document search', () => {
  it('requests a deterministic ascending order: first accession into Scopus, then cover date', async () => {
    expect(SCOPUS_SEARCH_SORT).toBe('+orig-load-date,+coverDate');
    const { client, calls } = scopus();
    await client.fetchAuthorDocuments(AUTHOR);
    const searches = calls.map((c) => new URL(c.url)).filter((u) => u.pathname === '/content/search/scopus');
    expect(searches).toHaveLength(2);
    for (const url of searches) {
      // "+" is percent-encoded: a literal "+" would be read as a space, and an unprefixed field sorts descending.
      expect(url.search).toContain('sort=%2Borig-load-date%2C%2BcoverDate');
      expect(url.searchParams.get('sort')).toBe('+orig-load-date,+coverDate');
      expect(url.searchParams.get('view')).toBe('STANDARD');
      expect(url.searchParams.has('cursor')).toBe(false);
    }
    expect(searches.map((u) => u.searchParams.get('start'))).toEqual(['0', '2']);
  });

  it('pages through every result and keeps the entries complete', async () => {
    const { client, calls } = scopus();
    const result = await client.fetchAuthorDocuments(AUTHOR);
    expect(result.reportedCount).toBe(3);
    expect(result.documents.map((d) => d['dc:identifier'])).toEqual(['SCOPUS_ID:85000000001', 'SCOPUS_ID:85000000002', 'SCOPUS_ID:85000000003']);
    expect(calls.map((c) => c.url)).toEqual([authorUrl(), searchUrl(AUTHOR, 0, 2), searchUrl(AUTHOR, 2, 2)]);
  });

  it('an empty result is a valid zero, with or without the empty-result marker', async () => {
    expect((await scopus([emptySearch(AUTHOR, 2)]).client.fetchDocuments(AUTHOR)).documents).toEqual([]);
    expect((await scopus([searchPage(AUTHOR, 0, 2, 0, [])]).client.fetchDocuments(AUTHOR)).reportedCount).toBe(0);
  });

  it('a page without entries before the reported total is INCOMPLETE', async () => {
    const pages = [searchPage(AUTHOR, 0, 2, 3, [scopusEntry(1), scopusEntry(2)]), searchPage(AUTHOR, 2, 2, 3, [])];
    expect((await failure(scopus(pages).client.fetchDocuments(AUTHOR))).kind).toBe('INCOMPLETE');
  });

  it('a document repeated across pages cannot hide a missing one', async () => {
    const pages = [searchPage(AUTHOR, 0, 2, 3, [scopusEntry(1), scopusEntry(2)]), searchPage(AUTHOR, 2, 2, 3, [scopusEntry(2)])];
    const error = await failure(scopus(pages).client.fetchDocuments(AUTHOR));
    expect(error.kind).toBe('INCOMPLETE');
    expect(error.message).toContain('2 distinct documents (1 repeated)');
  });

  it('a result count that changes between pages is INCOMPLETE', async () => {
    const pages = [searchPage(AUTHOR, 0, 2, 3, [scopusEntry(1), scopusEntry(2)]), searchPage(AUTHOR, 2, 2, 4, [scopusEntry(3)])];
    expect((await failure(scopus(pages).client.fetchDocuments(AUTHOR))).kind).toBe('INCOMPLETE');
  });

  it('exactly the offset-paging limit is still fetched', async () => {
    const { client } = scopus([searchPage(AUTHOR, 0, 2, SCOPUS_OFFSET_LIMIT, [scopusEntry(1), scopusEntry(2)]), searchPage(AUTHOR, 2, 2, SCOPUS_OFFSET_LIMIT, [])]);
    // The limit itself is not refused up front; this synthetic page then runs short and is INCOMPLETE for that reason.
    expect((await failure(client.fetchDocuments(AUTHOR))).message).toContain('returned no entries at start 2');
  });

  it('malformed pages and entries are invalid responses', async () => {
    const cases: Record<string, unknown>[] = [
      { 'search-results': { entry: [] } }, // no totalResults
      { 'search-results': { 'opensearch:totalResults': 'many', entry: [] } },
      { notSearchResults: {} },
    ];
    for (const body of cases) {
      const error = await failure(scopus([], { [searchUrl(AUTHOR, 0, 2)]: status(200, {}, body) }).client.fetchDocuments(AUTHOR));
      expect(error.kind, JSON.stringify(body)).toBe('INVALID_RESPONSE');
    }
    const badEntries: Record<string, unknown>[] = [
      { error: 'Result set was empty' }, // marker while totalResults > 0
      scopusEntry(1, { 'dc:identifier': 'SCOPUS:85000000001' }),
      scopusEntry(1, { eid: '2-s2.0-99999999999' }),
      scopusEntry(1, { 'dc:title': 42 }),
    ];
    for (const entry of badEntries) {
      const error = await failure(scopus([searchPage(AUTHOR, 0, 2, 1, [entry])]).client.fetchDocuments(AUTHOR));
      expect(error.kind, JSON.stringify(entry)).toBe('INVALID_RESPONSE');
    }
    const shifted = searchPage(AUTHOR, 0, 2, 1, [scopusEntry(1)], { 'opensearch:startIndex': '5' });
    expect((await failure(scopus([shifted]).client.fetchDocuments(AUTHOR))).kind).toBe('INVALID_RESPONSE');
  });

  it('retries 5xx and network errors, then succeeds', async () => {
    let attempts = 0;
    const flaky = () => {
      attempts++;
      if (attempts === 1) return status(503)();
      if (attempts === 2) throw new TypeError('synthetic network failure');
      return status(200, {}, threeDocumentPages()[1].body)();
    };
    const { client } = scopus([threeDocumentPages()[0]], { [searchUrl(AUTHOR, 2, 2)]: flaky }, { maxRetries: 2 });
    expect((await client.fetchDocuments(AUTHOR)).documents).toHaveLength(3);
    expect(attempts).toBe(3);
  });

  it('a request that never answers times out', async () => {
    const hanging = new ScopusClient({
      apiKey: API_KEY,
      http: { timeoutMs: 20, maxRetries: 0 },
      deps: {
        sleep: noSleep,
        fetchImpl: ((_url: string, init?: RequestInit) =>
          new Promise((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(new Error('aborted'))))) as typeof fetch,
      },
    });
    expect((await failure(hanging.validateAuthor(AUTHOR))).kind).toBe('TIMEOUT');
  });
});

describe('Scopus cursor pagination (beyond the offset limit)', () => {
  // A small offset limit stands in for Elsevier's 5,000: 5 documents, 2 per page, limit 4.
  const LIMIT = 4;
  const docs = [1, 2, 3, 4, 5].map((n) => scopusEntry(n));
  const probe = searchPage(AUTHOR, 0, 2, 5, docs.slice(0, 2));
  const C2 = 'AoJ+synthetic/cursor=2';
  const C3 = 'AoJsyntheticCursor3';

  function cursorClient(recorded: ReturnType<typeof searchPage>[], overrides: Record<string, Route> = {}) {
    const replay = replayFetch(recorded, overrides);
    const client = new ScopusClient({ apiKey: API_KEY, perPage: 2, offsetLimit: LIMIT, http: { maxRetries: 0 }, deps: { fetchImpl: replay.fetchImpl, sleep: noSleep } });
    return { client, calls: replay.calls };
  }
  const pages = (third: ReturnType<typeof cursorPage> = cursorPage(AUTHOR, C3, 2, 5, docs.slice(4), null)) => [
    probe,
    cursorPage(AUTHOR, '*', 2, 5, docs.slice(0, 2), { cursor: C2, via: 'link' }),
    cursorPage(AUTHOR, C2, 2, 5, docs.slice(2, 4), { cursor: C3, via: 'element' }),
    third,
  ];

  it('restarts with cursor=* (no start), follows each next cursor and ends at the reported total', async () => {
    const { client, calls } = cursorClient(pages());
    const result = await client.fetchDocuments(AUTHOR);
    expect(result.reportedCount).toBe(5);
    expect(result.documents.map((d) => d['dc:identifier'])).toEqual(docs.map((d) => d['dc:identifier']));
    expect(calls.map((c) => c.url)).toEqual([searchUrl(AUTHOR, 0, 2), cursorUrl(AUTHOR, '*', 2), cursorUrl(AUTHOR, C2, 2), cursorUrl(AUTHOR, C3, 2)]);
    for (const call of calls.slice(1)) {
      const url = new URL(call.url);
      expect(url.origin).toBe('https://api.elsevier.com');
      expect(url.searchParams.has('start')).toBe(false);
      expect(url.searchParams.get('sort')).toBe('+orig-load-date,+coverDate');
      expect(call.headers['x-els-apikey']).toBe(API_KEY);
    }
    // The cursor is URL-encoded by the client ("+", "/" and "=" survive the round trip).
    expect(new URL(calls[2].url).searchParams.get('cursor')).toBe(C2);
  });

  it('a final page that still offers a next cursor ends the fetch once the total is reached', async () => {
    const { client, calls } = cursorClient(pages(cursorPage(AUTHOR, C3, 2, 5, docs.slice(4), { cursor: 'AoJsyntheticCursor4' })));
    expect((await client.fetchDocuments(AUTHOR)).documents).toHaveLength(5);
    expect(calls).toHaveLength(4);
  });

  it('accepts the http://…:80 form of Elsevier example links, but always requests the configured https base', async () => {
    const http = cursorPage(AUTHOR, '*', 2, 5, docs.slice(0, 2), null, { link: [nextLink(AUTHOR, C2, 2, 'http://api.elsevier.com:80')] });
    const { client, calls } = cursorClient([probe, http, ...pages().slice(2)]);
    expect((await client.fetchDocuments(AUTHOR)).documents).toHaveLength(5);
    expect(calls.every((c) => c.url.startsWith('https://api.elsevier.com/content/search/scopus?'))).toBe(true);
  });

  it('a missing continuation, an empty page or a page of repeats before the total is INCOMPLETE', async () => {
    const cases = [
      cursorPage(AUTHOR, C2, 2, 5, docs.slice(2, 4), null), // no next cursor
      cursorPage(AUTHOR, C2, 2, 5, [], { cursor: C3 }), // empty page
      cursorPage(AUTHOR, C2, 2, 5, docs.slice(0, 2), { cursor: C3 }), // only documents already received
      cursorPage(AUTHOR, C2, 2, 6, docs.slice(2, 4), { cursor: C3 }), // total changed
    ];
    for (const second of cases) {
      const { client, calls } = cursorClient([probe, pages()[1], second]);
      const error = await failure(client.fetchDocuments(AUTHOR));
      expect(error.kind).toBe('INCOMPLETE');
      expect(calls).toHaveLength(3);
    }
    const ended = await failure(cursorClient([probe, pages()[1], cases[0]]).client.fetchDocuments(AUTHOR));
    expect(ended.message).toBe(
      `Scopus ended cursor paging for author ${AUTHOR} after 4 of 5 documents (no next cursor). ` +
        'The fetch is incomplete: no Scopus records or citation counts were saved for this identity in this run and existing data is unchanged.',
    );
  });

  it('a repeated cursor is refused before it is requested again', async () => {
    for (const repeated of ['*', C2]) {
      const { client, calls } = cursorClient([probe, pages()[1], cursorPage(AUTHOR, C2, 2, 5, docs.slice(2, 4), { cursor: repeated, via: 'element' })]);
      const error = await failure(client.fetchDocuments(AUTHOR));
      expect(error.kind, repeated).toBe('INVALID_RESPONSE');
      expect(calls).toHaveLength(3);
    }
  });

  it('more pages than the total allows is INCOMPLETE', async () => {
    // One new document per page: 5 documents at 2 per page may take at most 4 pages.
    const one = (cursor: string, n: number, next: string) => cursorPage(AUTHOR, cursor, 2, 5, [docs[n]], { cursor: next });
    const { client, calls } = cursorClient([probe, one('*', 0, 'k1'), one('k1', 1, 'k2'), one('k2', 2, 'k3'), one('k3', 3, 'k4')]);
    const error = await failure(client.fetchDocuments(AUTHOR));
    expect(error).toMatchObject({ kind: 'INCOMPLETE' });
    expect(error.message).toContain('needed more pages than 5 documents allow');
    expect(calls).toHaveLength(5);
  });

  it('malformed cursors are refused and never quoted in the error', async () => {
    const LEAK = 'SYNTHETIC-CURSOR-TEXT-7f3a';
    for (const bad of ['', `${LEAK} with spaces`, `${LEAK}é`, 'x'.repeat(2_049), '*']) {
      for (const via of ['link', 'element'] as const) {
        const { client, calls } = cursorClient([probe, cursorPage(AUTHOR, '*', 2, 5, docs.slice(0, 2), { cursor: bad, via })]);
        const error = await failure(client.fetchDocuments(AUTHOR));
        expect(error.kind, `${via} ${JSON.stringify(bad.slice(0, 20))}`).toBe('INVALID_RESPONSE');
        expect(error.message).not.toContain(LEAK);
        expect(calls).toHaveLength(2);
      }
    }
    const disagree = cursorPage(AUTHOR, '*', 2, 5, docs.slice(0, 2), { cursor: C2 }, { cursor: { '@next': C3 } });
    expect((await failure(cursorClient([probe, disagree]).client.fetchDocuments(AUTHOR))).message).toContain('disagree');
  });

  it('navigation links are validated: never another host, endpoint, search or offset continuation', async () => {
    const enc = encodeURIComponent;
    const tail = `count=2&query=${enc(`AU-ID(${AUTHOR})`)}&view=STANDARD&sort=${enc('+orig-load-date,+coverDate')}`;
    const hrefs = [
      `https://evil.example/content/search/scopus?cursor=${C3}&${tail}`,
      `https://api.elsevier.com.evil.example/content/search/scopus?cursor=${C3}&${tail}`,
      `https://user:pass@api.elsevier.com/content/search/scopus?cursor=${C3}&${tail}`,
      `https://api.elsevier.com:8443/content/search/scopus?cursor=${C3}&${tail}`,
      `ftp://api.elsevier.com/content/search/scopus?cursor=${C3}&${tail}`,
      `javascript:alert(1)`,
      `https://api.elsevier.com/content/search/author?cursor=${C3}&${tail}`,
      `https://api.elsevier.com/content/abstract/scopus_id/85000000001?cursor=${C3}&${tail}`,
      `https://api.elsevier.com/content/search/scopus?cursor=${C3}&start=4&${tail}`,
      `https://api.elsevier.com/content/search/scopus?start=4&${tail}`,
      `https://api.elsevier.com/content/search/scopus?cursor=${C3}&cursor=other&${tail}`,
      `https://api.elsevier.com/content/search/scopus?cursor=${C3}&count=2&query=${enc(`AU-ID(${OTHER_AUTHOR})`)}`,
      `https://api.elsevier.com/content/search/scopus?cursor=${C3}&count=2&query=${enc(`AU-ID(${AUTHOR})`)}&view=COMPLETE`,
      `https://api.elsevier.com/content/search/scopus?cursor=${C3}&count=2&query=${enc(`AU-ID(${AUTHOR})`)}&sort=-coverDate`,
      `https://api.elsevier.com/content/search/scopus?cursor=${C3}&count=25&query=${enc(`AU-ID(${AUTHOR})`)}`,
      'not a url',
    ];
    for (const href of hrefs) {
      const link = { '@_fa': 'true', '@ref': 'next', '@href': href };
      const { client, calls } = cursorClient([probe, cursorPage(AUTHOR, '*', 2, 5, docs.slice(0, 2), null, { link: [link] })]);
      const error = await failure(client.fetchDocuments(AUTHOR));
      expect(error.kind, href).toBe('INVALID_RESPONSE');
      expect(error.message).not.toContain('evil');
      expect(calls, href).toHaveLength(2);
    }
    const twoNext = cursorPage(AUTHOR, '*', 2, 5, docs.slice(0, 2), null, { link: [nextLink(AUTHOR, C2, 2), nextLink(AUTHOR, C3, 2)] });
    expect((await failure(cursorClient([probe, twoNext]).client.fetchDocuments(AUTHOR))).message).toContain('several next links');
  });

  it('a refused cursor request keeps the offset fail-safe with an actionable message', async () => {
    for (const code of [403, 400]) {
      const { client, calls } = cursorClient([probe], { [cursorUrl(AUTHOR, '*', 2)]: status(code, {}, { message: 'SYNTHETIC-PROVIDER-TEXT' }) });
      const error = await failure(client.fetchDocuments(AUTHOR));
      expect(error.kind).toBe('INCOMPLETE');
      expect(error.message).toContain(`Scopus reports 5 documents for author ${AUTHOR}, more than the ${LIMIT} reachable by offset paging, and cursor pagination was refused by Scopus (HTTP ${code}`);
      expect(error.message).toContain('no Scopus records or citation counts were saved');
      expect(error.message).not.toContain('SYNTHETIC-PROVIDER-TEXT');
      expect(calls).toHaveLength(2);
    }
    expect(SCOPUS_OFFSET_LIMIT).toBe(5_000);
  });

  it('credential, quota and server failures in cursor mode keep their own kinds', async () => {
    const cases: [number, string][] = [[401, 'AUTH_FAILED'], [429, 'QUOTA_EXCEEDED'], [500, 'HTTP_STATUS']];
    for (const [code, kind] of cases) {
      const { client } = cursorClient([probe, pages()[1]], { [cursorUrl(AUTHOR, C2, 2)]: status(code) });
      expect((await failure(client.fetchDocuments(AUTHOR))).kind, String(code)).toBe(kind);
    }
    const html = () => new Response('<!DOCTYPE html><html></html>', { status: 200, headers: { 'content-type': 'text/html' } });
    expect((await failure(cursorClient([probe, pages()[1]], { [cursorUrl(AUTHOR, C2, 2)]: html }).client.fetchDocuments(AUTHOR))).kind).toBe('CONTENT_TYPE');
    const noTotal = status(200, {}, { 'search-results': { entry: [] } });
    expect((await failure(cursorClient([probe], { [cursorUrl(AUTHOR, '*', 2)]: noTotal }).client.fetchDocuments(AUTHOR))).kind).toBe('INVALID_RESPONSE');
  });

  it('within the offset limit no cursor is ever requested', async () => {
    const { client, calls } = scopus();
    await client.fetchAuthorDocuments(AUTHOR);
    expect(calls.some((c) => new URL(c.url).searchParams.has('cursor'))).toBe(false);
  });
});
