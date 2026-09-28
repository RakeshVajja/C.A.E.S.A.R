import { describe, expect, it, vi } from 'vitest';
import {
  authorsQuery,
  DBLP_HTTP_CONFIG,
  DBLP_USER_AGENT,
  DblpClient,
  identityQuery,
  normalizeDblpPid,
  recordsQuery,
  sparqlUrl,
} from '../../src/integrations/dblp/client';
import { FetchError } from '../../src/integrations/http/httpClient';
import { loadFixture, noSleep, RecordedResponse, replayFetch, Route, toResponse } from '../helpers/fixtures';

const fx = (name: string) => loadFixture('dblp', name);
const PID = 'v/MosheYVardi';
const identityPerson = fx('identity-person');
const records = fx('records-person');
const authors = fx('authors-person');

function dblp(recorded: RecordedResponse[], overrides: Record<string, Route> = {}) {
  const replay = replayFetch(recorded, overrides);
  return { client: new DblpClient({ deps: { fetchImpl: replay.fetchImpl, sleep: noSleep } }), calls: replay.calls };
}

async function fetchError(promise: Promise<unknown>): Promise<FetchError> {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(FetchError);
  return error as FetchError;
}

const json = (body: unknown, status = 200) =>
  toResponse({ status, contentType: 'application/sparql-results+json', body });

describe('normalizeDblpPid', () => {
  it('accepts bare PIDs and dblp.org person URLs', () => {
    expect(normalizeDblpPid('v/MosheYVardi')).toBe('v/MosheYVardi');
    expect(normalizeDblpPid(' https://dblp.org/pid/v/MosheYVardi.html ')).toBe('v/MosheYVardi');
    expect(normalizeDblpPid('http://dblp.org/pid/129/1623.xml')).toBe('129/1623');
    expect(normalizeDblpPid('12/3456-1')).toBe('12/3456-1');
  });

  it('rejects anything that could not be a PID (including SPARQL injection)', () => {
    for (const bad of ['', 'MosheYVardi', 'v/Moshe Vardi', 'https://dblp.org/rec/conf/x/Y', 'v/X> ?p ?o . <x', 'V/X']) {
      expect(() => normalizeDblpPid(bad), bad).toThrow(FetchError);
    }
  });
});

describe('queries (§13.4)', () => {
  it('selects authored records only — never editedBy (editor-only records are excluded)', () => {
    for (const query of [recordsQuery(PID), authorsQuery(PID)]) {
      expect(query).toContain(`dblp:authoredBy <https://dblp.org/pid/${PID}>`);
      expect(query).not.toContain('editedBy');
    }
  });

  it('reads author names from author signatures only', () => {
    expect(authorsQuery(PID)).toContain('rdf:type dblp:AuthorSignature');
  });

  it('uses the sparql.dblp.org endpoint only', () => {
    expect(sparqlUrl(recordsQuery(PID))).toMatch(/^https:\/\/sparql\.dblp\.org\/sparql\?query=/);
  });

  it('throttles to one request at a time, 1–2 s apart', () => {
    expect(DBLP_HTTP_CONFIG.minIntervalMs).toBeGreaterThanOrEqual(1_000);
    expect(DBLP_HTTP_CONFIG.minIntervalMs).toBeLessThanOrEqual(2_000);
  });
});

describe('person validation (recorded)', () => {
  it('accepts a dblp:Person', async () => {
    const { client, calls } = dblp([identityPerson]);
    await expect(client.validatePerson(PID)).resolves.toEqual({ pid: PID, name: 'Moshe Y. Vardi' });
    expect(calls[0].headers).toMatchObject({ accept: 'application/sparql-results+json', 'user-agent': DBLP_USER_AGENT });
  });

  it('rejects a disambiguation page (AmbiguousCreator) before fetching any records', async () => {
    const { client, calls } = dblp([fx('identity-ambiguous'), records, authors]);
    const error = await fetchError(client.fetchPersonPublications('00/10049'));
    expect(error.kind).toBe('IDENTITY_INVALID');
    expect(error.message).toContain('disambiguation');
    expect(calls).toHaveLength(1);
  });

  it('treats a PID with no triples as IDENTITY_NOT_FOUND, never as zero publications', async () => {
    const missing = fx('identity-missing');
    expect((missing.body as { results: { bindings: unknown[] } }).results.bindings).toHaveLength(0);
    const { client, calls } = dblp([missing]);
    expect((await fetchError(client.fetchPersonPublications('00/0000000'))).kind).toBe('IDENTITY_NOT_FOUND');
    expect(calls).toHaveLength(1);
  });

  it('rejects a creator that is not a person (e.g. a group)', async () => {
    const group = json({
      head: { vars: ['type', 'name'] },
      results: { bindings: [{ type: { type: 'uri', value: 'https://dblp.org/rdf/schema#Group' } }] },
      meta: { 'result-size-total': 1 },
    });
    const { client } = dblp([], { [identityPerson.request]: () => group });
    expect((await fetchError(client.validatePerson(PID))).kind).toBe('IDENTITY_INVALID');
  });
});

describe('publications fetch (recorded)', () => {
  it('returns all 830 authored records with ordered authors from three requests', async () => {
    const { client, calls } = dblp([identityPerson, records, authors]);
    const result = await client.fetchPersonPublications(PID);

    expect(result.person).toEqual({ pid: PID, name: 'Moshe Y. Vardi' });
    expect(result.publications).toHaveLength(830);
    expect(calls.map((c) => c.url)).toEqual([identityPerson.request, records.request, authors.request]);

    const corr = result.publications.find((p) => p.publication.endsWith('/journals/corr/ChakrabortyMV13'))!;
    expect(corr.authors).toEqual(['Supratik Chakraborty', 'Kuldeep S. Meel', 'Moshe Y. Vardi']);
    expect(corr.dois).toEqual([]);
    expect(result.publications.every((p) => p.authors.length > 0)).toBe(true);
  });

  it('contains no editor-only Editorship records', async () => {
    const { client } = dblp([identityPerson, records, authors]);
    const { publications } = await client.fetchPersonPublications(PID);
    expect(publications.some((p) => p.types.some((t) => t.endsWith('#Editorship')))).toBe(false);
    expect(publications.some((p) => p.publication.endsWith('/conf/cav/1998'))).toBe(false);
  });

  it('sorts DOIs (their order in dblp results is not stable) and keeps every DOI', async () => {
    const { client } = dblp([identityPerson, records, authors]);
    const { publications } = await client.fetchPersonPublications(PID);
    const multi = publications.filter((p) => p.dois.length > 1);
    expect(multi).toHaveLength(4);
    for (const p of multi) expect(p.dois).toEqual([...p.dois].sort());
  });

  it('orders authors by signature ordinal whatever order rows arrive in', async () => {
    const shuffled = structuredClone(authors);
    (shuffled.body as { results: { bindings: unknown[] } }).results.bindings.reverse();
    const { client } = dblp([identityPerson, records, shuffled]);
    const { publications } = await client.fetchPersonPublications(PID);
    const corr = publications.find((p) => p.publication.endsWith('/journals/corr/ChakrabortyMV13'))!;
    expect(corr.authors).toEqual(['Supratik Chakraborty', 'Kuldeep S. Meel', 'Moshe Y. Vardi']);
  });

  it('waits the DBLP interval between its requests', async () => {
    let clock = 0;
    const sleep = vi.fn(async (ms: number) => {
      clock += ms;
    });
    const replay = replayFetch([identityPerson, records, authors]);
    const client = new DblpClient({ deps: { fetchImpl: replay.fetchImpl, sleep, now: () => clock } });
    await client.fetchPersonPublications(PID);
    expect(sleep.mock.calls.map((c) => (c as unknown[])[0])).toEqual([1_500, 1_500]);
  });
});

describe('failures (§13.1): never "zero publications"', () => {
  it('fails on the real dblp bot-protection page (HTML with HTTP 200)', async () => {
    const botPage = fx('dblp-org-pid-xml');
    expect(botPage).toMatchObject({ status: 200, contentType: expect.stringContaining('text/html') });
    const { client } = dblp([identityPerson], { [records.request]: () => toResponse(botPage) });
    const error = await fetchError(client.fetchPersonPublications(PID));
    expect(error.kind).toBe('CONTENT_TYPE');
    expect(error.message).toContain('HTML');
  });

  it('fails on the real SPARQL error (HTTP 400) without retrying', async () => {
    const { client, calls } = dblp([identityPerson], { [records.request]: () => toResponse(fx('sparql-syntax-error')) });
    const error = await fetchError(client.fetchPersonPublications(PID));
    expect(error).toMatchObject({ kind: 'HTTP_STATUS', details: { status: 400 } });
    expect(error.message).toContain('Invalid SPARQL query');
    expect(calls.filter((c) => c.url === records.request)).toHaveLength(1);
  });

  it('fails when the authors query fails after the records query succeeded', async () => {
    const { client } = dblp([identityPerson, records], {
      [authors.request]: () => new Response('<!doctype html><html></html>', { status: 200, headers: { 'content-type': 'text/html' } }),
    });
    expect((await fetchError(client.fetchPersonPublications(PID))).kind).toBe('CONTENT_TYPE');
  });

  it('retries 429 and 5xx', async () => {
    let calls = 0;
    const { client } = dblp([identityPerson, records], {
      [authors.request]: () => {
        calls++;
        if (calls === 1) return new Response('', { status: 429, headers: { 'retry-after': '3' } });
        if (calls === 2) return new Response('', { status: 503 });
        return toResponse(authors);
      },
    });
    await expect(client.fetchPersonPublications(PID)).resolves.toMatchObject({ publications: expect.any(Array) });
    expect(calls).toBe(3);
  });

  it('fails as INCOMPLETE when fewer rows arrive than dblp reports', async () => {
    const truncated = structuredClone(records);
    (truncated.body as { results: { bindings: unknown[] } }).results.bindings.splice(100);
    const { client } = dblp([identityPerson, truncated, authors]);
    const error = await fetchError(client.fetchPersonPublications(PID));
    expect(error.kind).toBe('INCOMPLETE');
    expect(error.message).toContain('reported 830 rows');
  });

  it('fails on a structurally invalid result', async () => {
    const { client } = dblp([identityPerson], { [records.request]: () => json({ results: { bindings: [] } }) });
    expect((await fetchError(client.fetchPersonPublications(PID))).kind).toBe('INVALID_RESPONSE');
  });

  it('fails when an expected variable is missing', async () => {
    const { client } = dblp([identityPerson], {
      [records.request]: () => json({ head: { vars: ['publication'] }, results: { bindings: [] }, meta: { 'result-size-total': 0 } }),
    });
    const error = await fetchError(client.fetchPersonPublications(PID));
    expect(error.kind).toBe('INVALID_RESPONSE');
    expect(error.message).toContain('lacks variables');
  });

  it('fails when meta.result-size-total is missing (the completeness check is never skipped)', async () => {
    const noMeta = structuredClone(records);
    delete (noMeta.body as { meta?: unknown }).meta;
    const { client } = dblp([identityPerson, noMeta, authors]);
    const error = await fetchError(client.fetchPersonPublications(PID));
    expect(error.kind).toBe('INVALID_RESPONSE');
    expect(error.message).toContain('meta');
  });

  it('fails when more rows arrive than dblp reports', async () => {
    const inflated = structuredClone(records);
    (inflated.body as { meta: Record<string, number> }).meta['result-size-total'] = 829;
    const { client } = dblp([identityPerson, inflated, authors]);
    expect((await fetchError(client.fetchPersonPublications(PID))).message).toContain('but reported 829');
  });

  it('fails as INCOMPLETE on a truncated author-signature response', async () => {
    const truncated = structuredClone(authors);
    (truncated.body as { results: { bindings: unknown[] } }).results.bindings.splice(1_000);
    const { client } = dblp([identityPerson, records, truncated]);
    const error = await fetchError(client.fetchPersonPublications(PID));
    expect(error.kind).toBe('INCOMPLETE');
    expect(error.message).toContain('reported 2396 rows for authors');
  });

  it('fails when author signatures refer to a record not in the records result', async () => {
    const extra = structuredClone(authors);
    const body = extra.body as { results: { bindings: Array<Record<string, unknown>> }; meta: Record<string, number> };
    body.results.bindings.push({
      publication: { type: 'uri', value: 'https://dblp.org/rec/conf/x/NotInRecords' },
      ordinal: { type: 'literal', value: '1' },
      name: { type: 'literal', value: 'Someone' },
    });
    body.meta['result-size-total'] += 1;
    const { client } = dblp([identityPerson, records, extra]);
    const error = await fetchError(client.fetchPersonPublications(PID));
    expect(error.kind).toBe('INVALID_RESPONSE');
    expect(error.message).toContain('not in the records result');
  });

  it('fails as INCOMPLETE when a record has no author signatures', async () => {
    const missing = structuredClone(authors);
    const body = missing.body as { results: { bindings: Array<{ publication: { value: string } }> }; meta: Record<string, number> };
    const target = 'https://dblp.org/rec/conf/cp/ChakrabortyMV13';
    body.results.bindings = body.results.bindings.filter((b) => b.publication.value !== target);
    body.meta['result-size-total'] = body.results.bindings.length;
    const { client } = dblp([identityPerson, records, missing]);
    const error = await fetchError(client.fetchPersonPublications(PID));
    expect(error.kind).toBe('INCOMPLETE');
    expect(error.message).toContain('missing for 1 record');
  });

  it('fails when a row has no dblp record URI', async () => {
    const broken = structuredClone(records);
    const bindings = (broken.body as { results: { bindings: Array<Record<string, unknown>> } }).results.bindings;
    bindings[5] = { ...bindings[5], publication: { type: 'uri', value: 'https://example.org/x' } };
    const { client } = dblp([identityPerson, broken, authors]);
    expect((await fetchError(client.fetchPersonPublications(PID))).message).toContain('row 6 has no dblp record URI');
  });

  it('fails when an author row has no valid ordinal', async () => {
    const broken = structuredClone(authors);
    const bindings = (broken.body as { results: { bindings: Array<Record<string, unknown>> } }).results.bindings;
    bindings[0] = { ...bindings[0], ordinal: { type: 'literal', value: 'first' } };
    const { client } = dblp([identityPerson, records, broken]);
    expect((await fetchError(client.fetchPersonPublications(PID))).kind).toBe('INVALID_RESPONSE');
  });

  it('builds the identity query with the normalized PID', () => {
    expect(identityQuery(normalizeDblpPid('https://dblp.org/pid/v/MosheYVardi.html'))).toContain(
      '<https://dblp.org/pid/v/MosheYVardi>',
    );
  });
});
