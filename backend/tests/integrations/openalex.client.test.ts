import { describe, expect, it } from 'vitest';
import { FetchError } from '../../src/integrations/http/httpClient';
import {
  normalizeOpenAlexAuthorId,
  OPENALEX_BASE_URL,
  OPENALEX_WORK_FIELDS,
  OpenAlexClient,
} from '../../src/integrations/openalex/client';
import { loadFixture, noSleep, RecordedResponse, replayFetch, Route, toResponse } from '../helpers/fixtures';

const fx = (name: string) => loadFixture('openalex', name);
const AUTHOR = 'A5023888391';
const SELECT = OPENALEX_WORK_FIELDS.join(',');
const pages = [fx('works-page-1'), fx('works-page-2'), fx('works-page-3')];
const authorValid = fx('author-valid');

function openAlex(recorded: RecordedResponse[], overrides: Record<string, Route> = {}, options: { apiKey?: string; perPage?: number } = {}) {
  const replay = replayFetch(recorded, overrides);
  const client = new OpenAlexClient({
    apiKey: options.apiKey,
    perPage: options.perPage ?? 25, // the recorded paging fixtures use 25 per page
    deps: { fetchImpl: replay.fetchImpl, sleep: noSleep },
  });
  return { client, calls: replay.calls };
}

async function fetchError(promise: Promise<unknown>): Promise<FetchError> {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(FetchError);
  return error as FetchError;
}

const html200 = () =>
  new Response('<!DOCTYPE html><html><head><title>Just a moment...</title></head></html>', {
    status: 200,
    headers: { 'content-type': 'text/html; charset=UTF-8' },
  });

describe('normalizeOpenAlexAuthorId', () => {
  it('accepts short IDs, lowercase and URLs', () => {
    expect(normalizeOpenAlexAuthorId('A5023888391')).toBe('A5023888391');
    expect(normalizeOpenAlexAuthorId(' a5023888391 ')).toBe('A5023888391');
    expect(normalizeOpenAlexAuthorId('https://openalex.org/A5023888391')).toBe('A5023888391');
  });

  it('rejects anything else', () => {
    for (const bad of ['W123', 'A', '5023888391', 'https://example.org/A1', 'A12x']) {
      expect(() => normalizeOpenAlexAuthorId(bad), bad).toThrow(FetchError);
    }
  });
});

describe('identity validation (§13.3)', () => {
  it('validates an existing author (recorded response)', async () => {
    const { client } = openAlex([authorValid]);
    await expect(client.validateAuthor(AUTHOR)).resolves.toEqual({
      requestedId: AUTHOR,
      authorId: AUTHOR,
      merged: false,
      displayName: 'Jason R Priem',
    });
  });

  it('treats the recorded 404 (an HTML page) as IDENTITY_NOT_FOUND', async () => {
    const { client } = openAlex([fx('author-not-found')]);
    const error = await fetchError(client.validateAuthor('A5999999999'));
    expect(error.kind).toBe('IDENTITY_NOT_FOUND');
  });

  it('never fetches works for a nonexistent author, where OpenAlex would answer an empty 200', async () => {
    // The recorded works query for this ID really is a valid-looking 200 with count 0.
    const emptyWorks = fx('works-nonexistent-author');
    expect((emptyWorks.body as { meta: { count: number } }).meta.count).toBe(0);

    const { client, calls } = openAlex([fx('author-not-found'), emptyWorks]);
    const error = await fetchError(client.fetchAuthorWorks('A5999999999'));
    expect(error.kind).toBe('IDENTITY_NOT_FOUND');
    expect(calls.some((c) => c.url.includes('/works'))).toBe(false);
  });

  it("fails safely on OpenAlex's documented merged-author example, which really answers 404 (recorded)", async () => {
    // Docs: A5092938886 is merged into A5006060960 (301). Live on 2026-09-28 it returned 404 instead.
    const recorded = fx('author-merged-documented');
    expect(recorded).toMatchObject({ status: 404, contentType: expect.stringContaining('text/html') });

    const { client, calls } = openAlex([recorded]);
    const error = await fetchError(client.fetchAuthorWorks('A5092938886'));
    expect(error.kind).toBe('IDENTITY_NOT_FOUND');
    expect(calls.map((c) => c.url)).toEqual([recorded.request]); // no works query was sent
  });

  it('detects a merged author and fetches works with the new ID (simulated redirect)', async () => {
    const oldId = 'A1111111111';
    const authorUrl = `${OPENALEX_BASE_URL}/authors/${oldId}?select=id,display_name,orcid,works_count`;
    // Simulated: OpenAlex documents a 301 from a merged-away ID to the kept author, whose body carries
    // the kept ID. No real redirect could be recorded (see the recorded 404 test above).
    const { client, calls } = openAlex(pages, { [authorUrl]: authorValid });

    const result = await client.fetchAuthorWorks(oldId);
    expect(result.author).toMatchObject({ requestedId: oldId, authorId: AUTHOR, merged: true });
    expect(calls.filter((c) => c.url.includes('/works')).every((c) => c.url.includes(`author.id:${AUTHOR}`))).toBe(true);
  });

  it('rejects an author response with an invalid shape', async () => {
    const authorUrl = authorValid.request;
    const { client } = openAlex([], { [authorUrl]: () => toResponse({ status: 200, contentType: 'application/json', body: { id: 'W1' } }) });
    expect((await fetchError(client.validateAuthor(AUTHOR))).kind).toBe('INVALID_RESPONSE');
  });

  it('rejects a bot-protection HTML page on the author check', async () => {
    const { client } = openAlex([], { [authorValid.request]: html200 });
    expect((await fetchError(client.validateAuthor(AUTHOR))).kind).toBe('CONTENT_TYPE');
  });

  it('sends the API key as a Bearer token only when configured (decision #32)', async () => {
    const withKey = openAlex([authorValid], {}, { apiKey: 'secret-key' });
    await withKey.client.validateAuthor(AUTHOR);
    expect(withKey.calls[0].headers.authorization).toBe('Bearer secret-key');
    expect(withKey.calls[0].url).not.toContain('secret-key');

    const keyless = openAlex([authorValid]);
    await keyless.client.validateAuthor(AUTHOR);
    expect(keyless.calls[0].headers.authorization).toBeUndefined();
  });
});

describe('works fetch: cursor pagination (§13.3)', () => {
  it('follows the recorded cursor chain to the end and returns every work', async () => {
    const { client, calls } = openAlex([authorValid, ...pages]);
    const result = await client.fetchAuthorWorks(AUTHOR);

    expect(result.reportedCount).toBe(67);
    expect(result.works).toHaveLength(67);
    expect(new Set(result.works.map((w) => w.id)).size).toBe(67);
    const workCalls = calls.filter((c) => c.url.includes('/works'));
    expect(workCalls).toHaveLength(3);
    expect(workCalls[0].url).toContain('cursor=*');
    for (const call of workCalls) {
      expect(call.url).toContain(`filter=author.id:${AUTHOR}`);
      expect(call.url).toContain(`select=${SELECT}`);
    }
  });

  it('requests 100 works per page by default', async () => {
    const defaultPageUrl = `${OPENALEX_BASE_URL}/works?filter=author.id:${AUTHOR}&per-page=100&cursor=*&select=${SELECT}`;
    const replay = replayFetch([], { [defaultPageUrl]: () => toResponse(fx('works-nonexistent-author')) });
    const client = new OpenAlexClient({ deps: { fetchImpl: replay.fetchImpl, sleep: noSleep } });

    await client.fetchWorks(AUTHOR);
    expect(replay.calls.map((c) => c.url)).toEqual([defaultPageUrl]);
  });

  it('never selects abstracts, references or full text', () => {
    for (const excluded of ['abstract_inverted_index', 'referenced_works', 'related_works', 'content_urls', 'has_fulltext']) {
      expect(OPENALEX_WORK_FIELDS).not.toContain(excluded);
    }
  });

  it('returns a genuine empty result for a validated author with zero works', async () => {
    const emptyPageUrl = `${OPENALEX_BASE_URL}/works?filter=author.id:${AUTHOR}&per-page=25&cursor=*&select=${SELECT}`;
    const { client } = openAlex([authorValid], {
      [emptyPageUrl]: () => toResponse(fx('works-nonexistent-author')),
    });
    await expect(client.fetchAuthorWorks(AUTHOR)).resolves.toMatchObject({ works: [], reportedCount: 0 });
  });

  it('retries a 429 on a later page and still completes', async () => {
    let throttled = false;
    const { client } = openAlex([authorValid, pages[0], pages[2]], {
      [pages[1].request]: () => {
        if (!throttled) {
          throttled = true;
          return new Response('{}', { status: 429, headers: { 'content-type': 'application/json', 'retry-after': '1' } });
        }
        return toResponse(pages[1]);
      },
    });
    await expect(client.fetchAuthorWorks(AUTHOR)).resolves.toMatchObject({ reportedCount: 67 });
  });
});

describe('works fetch: response validation (§13.1)', () => {
  it('fails on a bot-protection HTML page served with 200 mid-pagination', async () => {
    const { client } = openAlex([authorValid, pages[0]], { [pages[1].request]: html200 });
    expect((await fetchError(client.fetchAuthorWorks(AUTHOR))).kind).toBe('CONTENT_TYPE');
  });

  it('fails on an API error payload returned with 200', async () => {
    const { client } = openAlex([authorValid], {
      [pages[0].request]: () =>
        toResponse({ status: 200, contentType: 'application/json', body: { error: 'Internal', message: 'upstream timeout' } }),
    });
    const error = await fetchError(client.fetchAuthorWorks(AUTHOR));
    expect(error.kind).toBe('INVALID_RESPONSE');
    expect(error.message).toContain('upstream timeout');
  });

  it('fails on the recorded 400 error payload without retrying', async () => {
    const { client, calls } = openAlex([authorValid], { [pages[0].request]: () => toResponse(fx('works-invalid-author-id')) });
    const error = await fetchError(client.fetchAuthorWorks(AUTHOR));
    expect(error).toMatchObject({ kind: 'HTTP_STATUS', details: { status: 400 } });
    expect(error.message).toContain('is not a valid OpenAlex ID');
    expect(calls.filter((c) => c.url.includes('/works'))).toHaveLength(1);
  });

  it('fails when a page has no meta', async () => {
    const { client } = openAlex([authorValid], {
      [pages[0].request]: () => toResponse({ status: 200, contentType: 'application/json', body: { results: [] } }),
    });
    expect((await fetchError(client.fetchAuthorWorks(AUTHOR))).kind).toBe('INVALID_RESPONSE');
  });

  it('fails when a work is structurally invalid', async () => {
    const broken = structuredClone(pages[0]);
    (broken.body as { results: Array<Record<string, unknown>> }).results[3] = { title: 'no id' };
    const { client } = openAlex([authorValid, broken, pages[1], pages[2]]);
    const error = await fetchError(client.fetchAuthorWorks(AUTHOR));
    expect(error.kind).toBe('INVALID_RESPONSE');
    expect(error.message).toContain('work 4 on page 1');
  });

  it('fails as INCOMPLETE when paging ends before the reported count', async () => {
    const truncated = structuredClone(pages[0]);
    (truncated.body as { meta: { next_cursor: string | null } }).meta.next_cursor = null;
    const { client } = openAlex([authorValid, truncated]);
    const error = await fetchError(client.fetchAuthorWorks(AUTHOR));
    expect(error.kind).toBe('INCOMPLETE');
    expect(error.message).toContain('reported 67 works');
  });

  it('stops at the page limit instead of looping forever', async () => {
    const replay = replayFetch([authorValid, pages[0]]);
    const client = new OpenAlexClient({ perPage: 25, maxPages: 1, deps: { fetchImpl: replay.fetchImpl, sleep: noSleep } });
    expect((await fetchError(client.fetchAuthorWorks(AUTHOR))).kind).toBe('INCOMPLETE');
  });
});
