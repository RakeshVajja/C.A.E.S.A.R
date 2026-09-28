import { describe, expect, it } from 'vitest';
import { FetchError } from '../../src/integrations/http/httpClient';
import { normalizeOrcidId, ORCID_API_BASE_URL, OrcidClient, orcidCheckCharacter } from '../../src/integrations/orcid/client';
import { loadFixture, noSleep, RecordedResponse, replayFetch, Route, toResponse } from '../helpers/fixtures';

const fx = (name: string) => loadFixture('orcid', name);
const PIWOWAR = '0000-0003-1613-5981';
const piwowar = fx('works-piwowar');
const worksUrl = (orcid: string) => `${ORCID_API_BASE_URL}/${orcid}/works`;

function orcid(recorded: RecordedResponse[], overrides: Record<string, Route> = {}) {
  const inits: RequestInit[] = [];
  const replay = replayFetch(recorded, overrides);
  const fetchImpl = ((input: string | URL | Request, init?: RequestInit) => {
    inits.push(init ?? {});
    return replay.fetchImpl(input, init);
  }) as typeof fetch;
  return { client: new OrcidClient({ deps: { fetchImpl, sleep: noSleep } }), calls: replay.calls, inits };
}

async function fetchError(promise: Promise<unknown>): Promise<FetchError> {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(FetchError);
  return error as FetchError;
}

const jsonAt = (body: unknown, status = 200) =>
  toResponse({ status, contentType: 'application/json;charset=UTF-8', body });

describe('ORCID iD normalization and checksum (§6.3)', () => {
  it('computes the ISO 7064 MOD 11-2 check character, including X', () => {
    expect(orcidCheckCharacter('000000021825009')).toBe('7');
    expect(orcidCheckCharacter('000000021694233')).toBe('X'); // ORCID's documented example 0000-0002-1694-233X
  });

  it('accepts bare iDs, orcid.org URLs and a lowercase x', () => {
    expect(normalizeOrcidId('0000-0003-1613-5981')).toBe('0000-0003-1613-5981');
    expect(normalizeOrcidId(' https://orcid.org/0000-0003-1613-5981 ')).toBe('0000-0003-1613-5981');
    expect(normalizeOrcidId('0000-0002-1694-233x')).toBe('0000-0002-1694-233X');
  });

  it('rejects malformed iDs and checksum failures before any request', async () => {
    for (const bad of ['1234', '0000000316135981', '0000-0003-1613-598', 'https://example.org/0000-0003-1613-5981']) {
      expect(() => normalizeOrcidId(bad), bad).toThrow(/not a valid ORCID iD/);
    }
    const { client, calls } = orcid([]);
    expect((await fetchError(client.fetchWorks('0000-0003-1613-5982'))).message).toContain('checksum');
    expect(calls).toHaveLength(0);
  });
});

describe('works fetch (recorded)', () => {
  it('returns every work summary of the record from one JSON request', async () => {
    const { client, calls } = orcid([piwowar]);
    const result = await client.fetchWorks(PIWOWAR);
    expect(result.orcid).toBe(PIWOWAR);
    expect(result.summaries).toHaveLength(100);
    expect(result.duplicatePutCodes).toEqual([]);
    expect(calls).toHaveLength(1);
    expect(calls[0].headers.accept).toBe('application/json');
  });

  it('does not follow redirects', async () => {
    const { client, inits } = orcid([piwowar]);
    await client.fetchWorks(PIWOWAR);
    expect(inits[0].redirect).toBe('manual');
  });

  it('keeps each put-code once when it is listed twice', async () => {
    const duplicated = structuredClone(piwowar);
    const groups = (duplicated.body as { group: Array<{ 'work-summary': unknown[] }> }).group;
    groups.push({ ...groups[0], 'work-summary': [groups[0]['work-summary'][0]] });
    const { client } = orcid([duplicated]);
    const result = await client.fetchWorks(PIWOWAR);
    expect(result.summaries).toHaveLength(100);
    expect(result.duplicatePutCodes).toHaveLength(1);
  });

  it('returns a genuine empty result for an existing record without works', async () => {
    const empty = structuredClone(fx('works-vardi'));
    (empty.body as { group: unknown[] }).group = [];
    const { client } = orcid([empty]);
    await expect(client.fetchWorks('0000-0002-0661-5773')).resolves.toEqual({
      orcid: '0000-0002-0661-5773',
      summaries: [],
      duplicatePutCodes: [],
    });
  });
});

describe('identity failures (recorded where ORCID provides a real example)', () => {
  it('treats the real 404 (error 9016) as IDENTITY_NOT_FOUND', async () => {
    const { client } = orcid([fx('works-not-found')]);
    expect((await fetchError(client.fetchWorks('0000-0001-2345-6789'))).kind).toBe('IDENTITY_NOT_FOUND');
  });

  it('treats the real deactivated record (409, error 9044) as IDENTITY_INVALID', async () => {
    const { client } = orcid([fx('works-deactivated')]);
    const error = await fetchError(client.fetchWorks('0000-0002-0155-3227'));
    expect(error.kind).toBe('IDENTITY_INVALID');
    expect(error.message).toContain('deactivated');
    expect(error.message).toContain('9044');
  });

  it('fails safely on a deprecated iD (documented 301; simulated — no real example found)', async () => {
    const { client, calls } = orcid([], {
      [worksUrl(PIWOWAR)]: () =>
        new Response('', { status: 301, headers: { location: 'https://orcid.org/0000-0002-1825-0097' } }),
    });
    const error = await fetchError(client.fetchWorks(PIWOWAR));
    expect(error.kind).toBe('IDENTITY_INVALID');
    expect(error.message).toContain('deprecated (merged into 0000-0002-1825-0097)');
    expect(calls).toHaveLength(1); // the redirect was not followed
  });
});

describe('response validation (§13.1): HTTP 200 is not success', () => {
  const cases: Array<[string, () => Response, FetchError['kind']]> = [
    ['an HTML page', () => new Response('<!DOCTYPE html><html><body>Maintenance</body></html>', { status: 200, headers: { 'content-type': 'text/html' } }), 'CONTENT_TYPE'],
    ['XML (ORCID\'s default format)', () => new Response('<?xml version="1.0"?><activities:works/>', { status: 200, headers: { 'content-type': 'application/vnd.orcid+xml;charset=UTF-8' } }), 'CONTENT_TYPE'],
    ['malformed JSON', () => new Response('{"group": [', { status: 200, headers: { 'content-type': 'application/json' } }), 'MALFORMED_BODY'],
    ['an ORCID error payload', () => jsonAt(fx('works-not-found').body), 'INVALID_RESPONSE'],
    ['a response without groups', () => jsonAt({ path: `/${PIWOWAR}/works` }), 'INVALID_RESPONSE'],
    ['a group without work summaries', () => jsonAt({ path: `/${PIWOWAR}/works`, group: [{ 'work-summary': [] }] }), 'INVALID_RESPONSE'],
    ['a response for another record', () => jsonAt({ ...(piwowar.body as object), path: '/0000-0002-1825-0097/works' }), 'INVALID_RESPONSE'],
  ];

  it.each(cases)('fails on %s', async (_label, route, kind) => {
    const { client } = orcid([], { [worksUrl(PIWOWAR)]: route });
    expect((await fetchError(client.fetchWorks(PIWOWAR))).kind).toBe(kind);
  });

  it('fails when a work summary belongs to another record', async () => {
    const foreign = structuredClone(piwowar);
    const summary = (foreign.body as { group: Array<{ 'work-summary': Array<{ path: string }> }> }).group[0]['work-summary'][0];
    summary.path = '/0000-0002-1825-0097/work/1';
    const { client } = orcid([foreign]);
    expect((await fetchError(client.fetchWorks(PIWOWAR))).message).toContain('not under');
  });

  it('retries 503 (ORCID burst limit) and 429', async () => {
    let calls = 0;
    const { client } = orcid([], {
      [worksUrl(PIWOWAR)]: () => {
        calls++;
        if (calls === 1) return new Response('', { status: 503 });
        if (calls === 2) return new Response('', { status: 429, headers: { 'retry-after': '1' } });
        return toResponse(piwowar);
      },
    });
    await expect(client.fetchWorks(PIWOWAR)).resolves.toMatchObject({ orcid: PIWOWAR });
    expect(calls).toBe(3);
  });
});
