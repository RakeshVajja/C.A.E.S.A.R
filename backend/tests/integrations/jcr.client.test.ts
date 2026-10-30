import { describe, expect, it } from 'vitest';
import { FetchError } from '../../src/integrations/http/httpClient';
import { isJcrJournalId, JcrClient } from '../../src/integrations/jcr/client';
import { noSleep, replayFetch, Route } from '../helpers/fixtures';
import { API_KEY, history, historyUrl, ISSN, journalRecord, journalUrl, lastUpdated, lastUpdatedUrl, report, reportUrl, search, searchUrl, status } from '../fixtures/jcr/synthetic';

/* Web of Science Journals API (JCR) client (stage 15.6) — synthetic responses only; no network, no real credentials. */

function jcr(recorded: ReturnType<typeof search>[] = [], overrides: Record<string, Route> = {}, maxRetries = 0) {
  const replay = replayFetch(recorded, overrides);
  const client = new JcrClient({ apiKey: API_KEY, http: { maxRetries, timeoutMs: 1_000 }, deps: { fetchImpl: replay.fetchImpl, sleep: noSleep } });
  return { client, calls: replay.calls };
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

describe('requests and authentication', () => {
  it('uses the documented endpoints with the API key in the X-ApiKey header only', async () => {
    const { client, calls } = jcr([lastUpdated(), search(ISSN.A_PRINT, ['SYNTH_A']), journalRecord({ id: 'SYNTH_A', issn: ISSN.A_PRINT }), history('SYNTH_A'), report('SYNTH_A', 2021)]);
    expect(await client.lastUpdated()).toBe('2026-06-18');
    expect(await client.searchByIssn('99990016')).toEqual(['SYNTH_A']);
    await client.journal('SYNTH_A');
    await client.history('SYNTH_A');
    await client.report('SYNTH_A', 2021);
    expect(calls.map((c) => c.url)).toEqual([
      'https://api.clarivate.com/apis/wos-journals/v1/last-updated',
      'https://api.clarivate.com/apis/wos-journals/v1/journals?q=9999-0016&limit=50&page=1',
      'https://api.clarivate.com/apis/wos-journals/v1/journals/SYNTH_A',
      'https://api.clarivate.com/apis/wos-journals/v1/journals/SYNTH_A/history',
      'https://api.clarivate.com/apis/wos-journals/v1/journals/SYNTH_A/reports/year/2021',
    ]);
    for (const call of calls) {
      expect(call.headers['x-apikey']).toBe(API_KEY);
      expect(call.url).not.toContain(API_KEY);
    }
  });

  it('refuses a malformed ISSN or journal identifier before any request', async () => {
    const { client, calls } = jcr();
    expect((await failure(client.searchByIssn('1234-5678'))).kind).toBe('INVALID_RESPONSE');
    for (const id of ['', '../x', 'A B', 'A/B', 'x'.repeat(201)]) {
      expect(isJcrJournalId(id), id).toBe(false);
      expect((await failure(client.journal(id))).kind).toBe('INVALID_RESPONSE');
    }
    expect((await failure(client.report('SYNTH_A', 1990))).kind).toBe('INVALID_RESPONSE');
    expect(calls).toHaveLength(0);
    expect(isJcrJournalId('4OR-Q_J_OPER_RES')).toBe(true);
  });
});

describe('ISSN search', () => {
  it('pages until the reported total and returns distinct journal identifiers', async () => {
    const ids = Array.from({ length: 52 }, (_, i) => `SYNTH_${i}`);
    const { client, calls } = jcr([search(ISSN.SHARED, ids.slice(0, 50), { total: 52 }), search(ISSN.SHARED, ids.slice(50), { total: 52, page: 2 })]);
    expect(await client.searchByIssn(ISSN.SHARED)).toEqual(ids);
    expect(calls).toHaveLength(2);
  });

  it('an ISSN with no journal is a valid empty result', async () => {
    expect(await jcr([search(ISSN.NOT_IN_JCR, [])]).client.searchByIssn(ISSN.NOT_IN_JCR)).toEqual([]);
  });

  it('incomplete, changing, repeated or malformed results fail', async () => {
    const cases: Record<string, Route>[] = [
      { [searchUrl(ISSN.SHARED)]: status(200, { metadata: { total: 2, page: 1, limit: 50 }, hits: [{ id: 'SYNTH_A' }] }) }, // fewer than reported
      { [searchUrl(ISSN.SHARED)]: status(200, { metadata: { total: 2, page: 1, limit: 50 }, hits: [{ id: 'SYNTH_A' }, { id: 'SYNTH_A' }] }) }, // repeated
      { [searchUrl(ISSN.SHARED)]: status(200, { metadata: { total: 1, page: 2, limit: 50 }, hits: [{ id: 'SYNTH_A' }] }) }, // wrong page
      { [searchUrl(ISSN.SHARED)]: status(200, { metadata: { total: 1, page: 1, limit: 50 }, hits: [{ id: '../ESCAPE' }] }) },
      { [searchUrl(ISSN.SHARED)]: status(200, { metadata: { total: 0, page: 1, limit: 50 }, hits: [{ id: 'SYNTH_A' }] }) },
      { [searchUrl(ISSN.SHARED)]: status(200, { hits: [] }) },
      { [searchUrl(ISSN.SHARED)]: status(200, { error: { status: 500, title: 'x', details: 'y' } }) },
    ];
    for (const overrides of cases) {
      const error = await failure(jcr([], overrides).client.searchByIssn(ISSN.SHARED));
      expect(['INCOMPLETE', 'INVALID_RESPONSE'], JSON.stringify(overrides)).toContain(error.kind);
    }
  });
});

describe('journals, history and reports', () => {
  it('an unknown journal is IDENTITY_NOT_FOUND; an answer for another journal is invalid', async () => {
    expect((await failure(jcr([], { [journalUrl('SYNTH_X')]: status(404, { error: { status: 404 } }) }).client.journal('SYNTH_X'))).kind).toBe('IDENTITY_NOT_FOUND');
    const other = journalRecord({ id: 'SYNTH_B' });
    expect((await failure(jcr([], { [journalUrl('SYNTH_A')]: status(200, other.body) }).client.journal('SYNTH_A'))).kind).toBe('INVALID_RESPONSE');
  });

  it('HTTP 404 on a report is UNAVAILABLE — the same for "not found" and a suppressed title, never a confirmed absence', async () => {
    const suppressed = status(404, { error: { status: 404, title: 'Suppressed Title', details: 'synthetic' } });
    const notFound = status(404, { error: { status: 404, title: "Resource couldn't be found", details: 'synthetic' } });
    const bare = status(404);
    for (const route of [suppressed, notFound, bare]) {
      expect(await jcr([], { [reportUrl('SYNTH_A', 2019)]: route }).client.report('SYNTH_A', 2019)).toEqual({ kind: 'UNAVAILABLE', status: 404 });
    }
    const found = await jcr([report('SYNTH_A', 2021)]).client.report('SYNTH_A', 2021);
    expect(found.kind).toBe('REPORT');
  });

  it('a report for another year or journal, or with mistyped metrics, is invalid', async () => {
    const cases = [
      report('SYNTH_A', 2020).body,
      report('SYNTH_B', 2021).body,
      report('SYNTH_A', 2021, { impact: { totalCites: '1200' } }).body,
      report('SYNTH_A', 2021, { overrides: { suppressed: 'no' } }).body,
      report('SYNTH_A', 2021, { ranks: { jif: [{ category: 42 }] } }).body,
    ];
    for (const body of cases) {
      const error = await failure(jcr([], { [reportUrl('SYNTH_A', 2021)]: status(200, body) }).client.report('SYNTH_A', 2021));
      expect(error.kind).toBe('INVALID_RESPONSE');
    }
  });

  it('a malformed content date is invalid', async () => {
    expect((await failure(jcr([], { [lastUpdatedUrl()]: status(200, { jcrDataUpdate: 'last week' }) }).client.lastUpdated())).kind).toBe('INVALID_RESPONSE');
  });
});

describe('failures', () => {
  it('classifies 401, 403 and 429 with fixed messages, and never echoes provider text or the key', async () => {
    const LEAK = 'SYNTHETIC-PROVIDER-TEXT-7f3a';
    const cases: [number, string, string][] = [
      [401, 'AUTH_FAILED', 'JCR: HTTP 401 (the API key was refused; check WOS_JOURNALS_API_KEY)'],
      [403, 'NOT_ENTITLED', 'JCR: HTTP 403 (this API key is not entitled to the Web of Science Journals API)'],
      [429, 'QUOTA_EXCEEDED', 'JCR: HTTP 429 (rate limit or quota still exceeded after retries; refresh again later)'],
      [400, 'HTTP_STATUS', 'JCR: HTTP 400 (request refused by JCR)'],
      [500, 'HTTP_STATUS', 'JCR: HTTP 500 (JCR service error, after retries; refresh again later)'],
    ];
    for (const [code, kind, message] of cases) {
      const body = { error: { status: code, title: LEAK, details: LEAK }, error_description: LEAK };
      const error = await failure(jcr([], { [lastUpdatedUrl()]: status(code, body) }).client.lastUpdated());
      expect(error, String(code)).toMatchObject({ kind, message });
      expect(error.message).not.toContain(LEAK);
      expect(error.message).not.toContain(API_KEY);
    }
    const html = () => new Response(`<!DOCTYPE html><html>${LEAK}</html>`, { status: 200, headers: { 'content-type': 'text/html' } });
    expect((await failure(jcr([], { [lastUpdatedUrl()]: html }).client.lastUpdated())).message).not.toContain(LEAK);
  });

  it('retries 5xx and honours Retry-After on 429 before giving up', async () => {
    let attempts = 0;
    const flaky = () => (++attempts < 3 ? status(attempts === 1 ? 503 : 429)() : status(200, { jcrDataUpdate: '2026-06-18' })());
    expect(await jcr([], { [lastUpdatedUrl()]: flaky }, 3).client.lastUpdated()).toBe('2026-06-18');
    expect(attempts).toBe(3);
  });

  it('history must be well formed', async () => {
    const bad = status(200, { issn: [{ issn: 9999 }] });
    expect((await failure(jcr([], { [historyUrl('SYNTH_A')]: bad }).client.history('SYNTH_A'))).kind).toBe('INVALID_RESPONSE');
  });
});
