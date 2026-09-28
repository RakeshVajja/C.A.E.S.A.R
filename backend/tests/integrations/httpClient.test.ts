import { describe, expect, it, vi } from 'vitest';
import { FetchError, parseRetryAfter, SourceHttpClient, SourceHttpConfig } from '../../src/integrations/http/httpClient';

const config: SourceHttpConfig = {
  name: 'Test',
  minIntervalMs: 0,
  timeoutMs: 1_000,
  maxRetries: 3,
  baseDelayMs: 100,
  maxDelayMs: 5_000,
};

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

function client(responses: Array<Response | Error>, overrides: Partial<SourceHttpConfig> = {}) {
  const queue = [...responses];
  const fetchImpl = vi.fn(async () => {
    const next = queue.shift();
    if (!next) throw new Error('unexpected extra request');
    if (next instanceof Error) throw next;
    return next;
  });
  const sleep = vi.fn(async () => {});
  const http = new SourceHttpClient({ ...config, ...overrides }, {
    fetchImpl: fetchImpl as unknown as typeof fetch,
    sleep,
    random: () => 0,
  });
  return { http, fetchImpl, sleep };
}

async function expectFetchError(promise: Promise<unknown>, kind: FetchError['kind']) {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(FetchError);
  expect((error as FetchError).kind).toBe(kind);
  return error as FetchError;
}

describe('SourceHttpClient — success', () => {
  it('returns parsed JSON with status and URL', async () => {
    const { http } = client([json({ ok: true })]);
    await expect(http.getJson('https://example.test/a')).resolves.toMatchObject({ status: 200, body: { ok: true } });
  });

  it('sends Accept: application/json plus caller headers', async () => {
    const { http, fetchImpl } = client([json({})]);
    await http.getJson('https://example.test/a', { headers: { Authorization: 'Bearer k' } });
    const init = (fetchImpl.mock.calls[0] as unknown[])[1] as RequestInit;
    expect(init.headers).toMatchObject({ Accept: 'application/json', Authorization: 'Bearer k' });
  });
});

describe('SourceHttpClient — HTTP 200 is not success (§13.1)', () => {
  it('rejects an HTML page served with 200 (bot protection)', async () => {
    const html = new Response('<!DOCTYPE html><html><title>Making sure you are not a bot!</title></html>', {
      status: 200,
      headers: { 'content-type': 'text/html; charset=utf-8' },
    });
    const error = await expectFetchError(client([html]).http.getJson('https://example.test/a'), 'CONTENT_TYPE');
    expect(error.message).toContain('HTML');
  });

  it('rejects HTML even when labelled as JSON', async () => {
    const lying = new Response('<html><body>blocked</body></html>', { status: 200, headers: { 'content-type': 'application/json' } });
    await expectFetchError(client([lying]).http.getJson('https://example.test/a'), 'CONTENT_TYPE');
  });

  it('rejects a missing or non-JSON content type', async () => {
    const plain = new Response('{"a":1}', { status: 200, headers: { 'content-type': 'text/plain' } });
    await expectFetchError(client([plain]).http.getJson('https://example.test/a'), 'CONTENT_TYPE');
  });

  it('rejects malformed JSON', async () => {
    const broken = new Response('{"meta": ', { status: 200, headers: { 'content-type': 'application/json' } });
    await expectFetchError(client([broken]).http.getJson('https://example.test/a'), 'MALFORMED_BODY');
  });
});

describe('SourceHttpClient — retries (§13.2)', () => {
  it('retries 429 honouring Retry-After seconds', async () => {
    const { http, sleep, fetchImpl } = client([json({}, 429, { 'retry-after': '2' }), json({ ok: 1 })]);
    await expect(http.getJson('https://example.test/a')).resolves.toMatchObject({ body: { ok: 1 } });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(2_000);
  });

  it('caps Retry-After at maxDelayMs', async () => {
    const { http, sleep } = client([json({}, 429, { 'retry-after': '3600' }), json({})]);
    await http.getJson('https://example.test/a');
    expect(sleep).toHaveBeenCalledWith(5_000);
  });

  it('retries 5xx with exponential backoff', async () => {
    const { http, sleep } = client([json({}, 500), json({}, 502), json({}, 503), json({ ok: 1 })]);
    await expect(http.getJson('https://example.test/a')).resolves.toMatchObject({ body: { ok: 1 } });
    expect(sleep.mock.calls.map((c) => (c as unknown[])[0])).toEqual([100, 200, 400]);
  });

  it('adds up to 50% jitter to the backoff', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(json({}, 503)).mockResolvedValueOnce(json({}));
    const sleep = vi.fn(async () => {});
    const http = new SourceHttpClient(config, { fetchImpl, sleep, random: () => 1 });
    await http.getJson('https://example.test/a');
    expect(sleep).toHaveBeenCalledWith(150);
  });

  it('retries network errors', async () => {
    const { http, fetchImpl } = client([new TypeError('fetch failed'), json({ ok: 1 })]);
    await expect(http.getJson('https://example.test/a')).resolves.toMatchObject({ body: { ok: 1 } });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('gives up after maxRetries and reports the last failure', async () => {
    const { http, fetchImpl } = client([json({}, 503), json({}, 503), json({}, 503), json({}, 503)]);
    const error = await expectFetchError(http.getJson('https://example.test/a'), 'HTTP_STATUS');
    expect(error.details.status).toBe(503);
    expect(fetchImpl).toHaveBeenCalledTimes(4);
  });

  it('does not retry other 4xx errors', async () => {
    const { http, fetchImpl } = client([json({ error: 'Invalid query parameters error.', message: "'A1' is not valid" }, 400)]);
    const error = await expectFetchError(http.getJson('https://example.test/a'), 'HTTP_STATUS');
    expect(error.message).toContain("'A1' is not valid");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('passes through statuses the caller handles (e.g. 404 for identity checks)', async () => {
    const notFound = new Response('<!doctype html><html>404</html>', { status: 404, headers: { 'content-type': 'text/html' } });
    const { http } = client([notFound]);
    await expect(http.getJson('https://example.test/a', { passThroughStatuses: [404] })).resolves.toMatchObject({
      status: 404,
      body: null,
    });
  });

  it('times out slow requests and reports TIMEOUT', async () => {
    const fetchImpl = vi.fn(
      (_url: unknown, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
        }),
    );
    const http = new SourceHttpClient({ ...config, timeoutMs: 10, maxRetries: 1 }, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleep: async () => {},
    });
    await expectFetchError(http.getJson('https://example.test/a'), 'TIMEOUT');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});

describe('SourceHttpClient — throttling', () => {
  it('waits the minimum interval between requests', async () => {
    let clock = 1_000;
    const sleep = vi.fn(async (ms: number) => {
      clock += ms;
    });
    const http = new SourceHttpClient({ ...config, minIntervalMs: 200 }, {
      fetchImpl: vi.fn(async () => json({})) as unknown as typeof fetch,
      sleep,
      now: () => clock,
    });
    await http.getJson('https://example.test/1');
    clock += 50;
    await http.getJson('https://example.test/2');
    expect(sleep).toHaveBeenCalledWith(150);
  });

  it('runs requests to one source one at a time', async () => {
    let active = 0;
    let maxActive = 0;
    const fetchImpl = vi.fn(async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active--;
      return json({});
    });
    const http = new SourceHttpClient(config, { fetchImpl: fetchImpl as unknown as typeof fetch });
    await Promise.all([http.getJson('https://e.test/1'), http.getJson('https://e.test/2'), http.getJson('https://e.test/3')]);
    expect(maxActive).toBe(1);
  });

  it('keeps working after a failed request', async () => {
    const { http } = client([json({}, 400), json({ ok: 1 })]);
    await expect(http.getJson('https://example.test/a')).rejects.toBeInstanceOf(FetchError);
    await expect(http.getJson('https://example.test/b')).resolves.toMatchObject({ body: { ok: 1 } });
  });
});

describe('parseRetryAfter', () => {
  it('parses seconds and HTTP dates', () => {
    expect(parseRetryAfter('7', 0)).toBe(7_000);
    const now = Date.parse('2026-09-28T00:00:00Z');
    expect(parseRetryAfter('Mon, 28 Sep 2026 00:00:30 GMT', now)).toBe(30_000);
    expect(parseRetryAfter('Mon, 28 Sep 2026 00:00:00 GMT', now + 5_000)).toBe(0);
  });

  it('ignores missing or invalid values', () => {
    expect(parseRetryAfter(null, 0)).toBeUndefined();
    expect(parseRetryAfter('soon', 0)).toBeUndefined();
  });
});
