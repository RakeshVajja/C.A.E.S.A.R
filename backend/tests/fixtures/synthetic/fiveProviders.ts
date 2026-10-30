import { authorsQuery, DBLP_SPARQL_ENDPOINT, DblpClient, identityQuery, recordsQuery, sparqlUrl } from '../../../src/integrations/dblp/client';
import { OPENALEX_BASE_URL, OPENALEX_WORK_FIELDS, OpenAlexClient } from '../../../src/integrations/openalex/client';
import { ORCID_API_BASE_URL, OrcidClient } from '../../../src/integrations/orcid/client';
import { ScopusClient } from '../../../src/integrations/scopus/client';
import { WosStarterClient } from '../../../src/integrations/wos/client';
import type { SyncClients } from '../../../src/services/sync/syncService';
import { noSleep, replayFetch, type RecordedResponse, type Route } from '../../helpers/fixtures';
import * as scopus from '../scopus/synthetic';
import * as wos from '../wos/synthetic';

/**
 * SYNTHETIC responses of all five discovery providers for cross-provider tests (stage 15.5,
 * decision #119). Each provider's response is built in code from the shapes its client validates
 * (OpenAlex works, DBLP SPARQL results, ORCID works, Scopus Search, WoS Starter); the same paper is
 * described the way each provider would describe it (title case, punctuation, DOI form, type and
 * year conventions). No real response is recorded or committed; every identifier, title, DOI and
 * count is invented.
 */

export const IDS = {
  OPENALEX: 'A9000000001',
  DBLP: 'z/SyntheticVerma',
  ORCID: '0009-0000-0000-0017', // well-formed, checksum-valid, invented
  SCOPUS: scopus.AUTHOR,
  WOS: wos.RID,
} as const;

export type Kind = 'journal' | 'conference' | 'preprint' | 'other';

/** One provider's view of one paper. */
export interface ProviderRecord {
  /** Distinct per provider record (used to derive the provider's external ID). */
  n: number;
  title: string;
  year: number | null;
  doi: string | null;
  venue: string | null;
  kind: Kind;
  authors?: string[];
  /** Scopus cited-by / WoS Times Cited (ignored by the keyless providers). */
  cites?: number;
}

export interface ProviderWorld {
  OPENALEX?: ProviderRecord[];
  DBLP?: ProviderRecord[];
  ORCID?: ProviderRecord[];
  SCOPUS?: ProviderRecord[];
  WOS?: ProviderRecord[];
}

const json = 'application/json';
const sparqlJson = 'application/sparql-results+json';

/* ── OpenAlex ─────────────────────────────────────────────────────────────── */

export const openAlexWorkId = (n: number) => `W9${String(n).padStart(9, '0')}`;

function openAlexResponses(records: ProviderRecord[]): RecordedResponse[] {
  const authorUrl = `${OPENALEX_BASE_URL}/authors/${IDS.OPENALEX}?select=id,display_name,orcid,works_count`;
  const worksUrl = `${OPENALEX_BASE_URL}/works?filter=author.id:${IDS.OPENALEX}&per-page=100&cursor=*&select=${OPENALEX_WORK_FIELDS.join(',')}`;
  const sourceType = { journal: 'journal', conference: 'conference', preprint: 'repository', other: 'repository' };
  const workType = { journal: 'article', conference: 'article', preprint: 'preprint', other: 'dataset' };
  return [
    {
      request: authorUrl,
      status: 200,
      contentType: json,
      body: { id: `https://openalex.org/${IDS.OPENALEX}`, display_name: 'Asha Verma', orcid: null, works_count: records.length },
    },
    {
      request: worksUrl,
      status: 200,
      contentType: json,
      body: {
        meta: { count: records.length, next_cursor: null },
        results: records.map((r) => ({
          id: `https://openalex.org/${openAlexWorkId(r.n)}`,
          doi: r.doi ? `https://doi.org/${r.doi}` : null,
          ids: { openalex: `https://openalex.org/${openAlexWorkId(r.n)}`, ...(r.doi ? { doi: `https://doi.org/${r.doi}` } : {}) },
          title: r.title,
          display_name: r.title,
          publication_year: r.year,
          type: workType[r.kind],
          primary_location: { source: r.venue ? { display_name: r.venue, type: sourceType[r.kind] } : null },
          authorships: (r.authors ?? ['Asha Verma']).map((name) => ({ author: { display_name: name } })),
        })),
      },
    },
  ];
}

/* ── DBLP (SPARQL) ────────────────────────────────────────────────────────── */

const DBLP_SCHEMA = 'https://dblp.org/rdf/schema#';
export const dblpKey = (r: ProviderRecord) => `${r.kind === 'conference' ? 'conf/synth' : r.kind === 'preprint' ? 'journals/corr' : 'journals/synth'}/Verma${r.n}`;

type Term = { type: 'uri' | 'literal'; value: string };
const uriTerm = (value: string): Term => ({ type: 'uri', value });
const literal = (value: string): Term => ({ type: 'literal', value });

function sparql(query: string, vars: string[], bindings: Record<string, Term>[]): RecordedResponse {
  return {
    request: sparqlUrl(query, DBLP_SPARQL_ENDPOINT),
    status: 200,
    contentType: sparqlJson,
    body: { head: { vars }, results: { bindings }, meta: { 'query-time-ms': 1, 'result-size-total': bindings.length } },
  };
}

function dblpResponses(records: ProviderRecord[]): RecordedResponse[] {
  const recordClass = { journal: 'Article', conference: 'Inproceedings', preprint: 'Informal', other: 'Data' };
  const uri = (r: ProviderRecord) => `https://dblp.org/rec/${dblpKey(r)}`;
  return [
    sparql(identityQuery(IDS.DBLP), ['type', 'name'], [
      { type: uriTerm(`${DBLP_SCHEMA}Creator`), name: literal('Asha Verma') },
      { type: uriTerm(`${DBLP_SCHEMA}Person`), name: literal('Asha Verma') },
    ]),
    sparql(
      recordsQuery(IDS.DBLP),
      ['publication', 'title', 'year', 'bibtexType', 'types', 'dois', 'venues'],
      records.map((r) => ({
        publication: uriTerm(uri(r)),
        title: literal(r.title),
        ...(r.year !== null ? { year: literal(String(r.year)) } : {}),
        types: literal(`${DBLP_SCHEMA}Publication\t${DBLP_SCHEMA}${recordClass[r.kind]}`),
        dois: literal(r.doi ? `https://doi.org/${r.doi}` : ''),
        venues: literal(r.venue ?? ''),
      })),
    ),
    sparql(
      authorsQuery(IDS.DBLP),
      ['publication', 'ordinal', 'name'],
      records.flatMap((r) =>
        (r.authors ?? ['Asha Verma']).map((name, index) => ({
          publication: uriTerm(uri(r)),
          ordinal: literal(String(index + 1)),
          name: literal(name),
        })),
      ),
    ),
  ];
}

/* ── ORCID ────────────────────────────────────────────────────────────────── */

export const orcidPutCode = (n: number) => 9_000_000 + n;

function orcidResponses(records: ProviderRecord[]): RecordedResponse[] {
  const type = { journal: 'journal-article', conference: 'conference-paper', preprint: 'preprint', other: 'other' };
  return [
    {
      request: `${ORCID_API_BASE_URL}/${IDS.ORCID}/works`,
      status: 200,
      contentType: json,
      body: {
        path: `/${IDS.ORCID}/works`,
        group: records.map((r) => ({
          'work-summary': [
            {
              'put-code': orcidPutCode(r.n),
              path: `/${IDS.ORCID}/work/${orcidPutCode(r.n)}`,
              type: type[r.kind],
              title: { title: { value: r.title } },
              'external-ids': {
                'external-id': r.doi ? [{ 'external-id-type': 'doi', 'external-id-value': r.doi, 'external-id-relationship': 'self' }] : [],
              },
              'publication-date': r.year !== null ? { year: { value: String(r.year) } } : null,
              'journal-title': r.venue ? { value: r.venue } : null,
            },
          ],
        })),
      },
    },
  ];
}

/* ── Scopus and Web of Science (the stage 15.3/15.4 synthetic builders) ───── */

function scopusResponses(records: ProviderRecord[]): RecordedResponse[] {
  const subtype = { journal: ['ar', 'Journal'], conference: ['cp', 'Conference Proceeding'], preprint: ['ar', 'Journal'], other: ['ed', 'Journal'] };
  const entries = records.map((r) =>
    scopus.scopusEntry(r.n, {
      'dc:title': r.title,
      'prism:doi': r.doi ?? undefined,
      'prism:coverDate': r.year !== null ? `${r.year}-06-01` : null,
      'prism:publicationName': r.venue ?? undefined,
      subtype: subtype[r.kind][0],
      'prism:aggregationType': subtype[r.kind][1],
      'citedby-count': String(r.cites ?? 0),
    }),
  );
  return [scopus.authorFound(IDS.SCOPUS, { documents: records.length }), scopus.searchPage(IDS.SCOPUS, 0, 200, entries.length, entries)];
}

function wosResponses(records: ProviderRecord[]): RecordedResponse[] {
  const types = { journal: ['Article'], conference: ['Proceedings Paper'], preprint: ['Article'], other: ['Editorial Material'] };
  const docs = records.map((r) =>
    wos.wosDocument(r.n, {
      title: r.title,
      types: types[r.kind],
      sourceTypes: types[r.kind],
      source: { sourceTitle: r.venue ?? undefined, publishYear: r.year ?? undefined },
      names: { authors: (r.authors ?? ['Verma, A']).map((name, i) => ({ displayName: name, ...(i === 0 ? { researcherId: IDS.WOS } : {}) })) },
      citations: [{ db: 'WOS', count: r.cites ?? 0 }],
      identifiers: { ...(r.doi ? { doi: r.doi } : {}), issn: '1234-5678' },
    }),
  );
  return [wos.documentsPage(IDS.WOS, 1, 50, docs.length, docs)];
}

/** Every synthetic response of a world, per provider. */
export function worldResponses(world: ProviderWorld): Record<keyof ProviderWorld, RecordedResponse[]> {
  return {
    OPENALEX: openAlexResponses(world.OPENALEX ?? []),
    DBLP: dblpResponses(world.DBLP ?? []),
    ORCID: orcidResponses(world.ORCID ?? []),
    SCOPUS: scopusResponses(world.SCOPUS ?? []),
    WOS: wosResponses(world.WOS ?? []),
  };
}

/**
 * Real clients of all five providers over the synthetic responses (no network). `overrides` inject
 * failures by exact URL, e.g. a failing WoS page.
 */
export function fiveProviderClients(world: ProviderWorld, overrides: Record<string, Route> = {}): SyncClients & { calls: () => string[] } {
  const responses = worldResponses(world);
  const replays = Object.fromEntries(
    (Object.keys(responses) as (keyof ProviderWorld)[]).map((provider) => [provider, replayFetch(responses[provider], overrides)]),
  ) as Record<keyof ProviderWorld, ReturnType<typeof replayFetch>>;
  const deps = (provider: keyof ProviderWorld) => ({ fetchImpl: replays[provider].fetchImpl, sleep: noSleep });
  const http = { maxRetries: 0 };
  return {
    openAlex: new OpenAlexClient({ deps: deps('OPENALEX'), http }),
    dblp: new DblpClient({ deps: deps('DBLP'), http }),
    orcid: new OrcidClient({ deps: deps('ORCID'), http }),
    scopus: new ScopusClient({ apiKey: scopus.API_KEY, deps: deps('SCOPUS'), http }),
    wos: new WosStarterClient({ apiKey: wos.API_KEY, deps: deps('WOS'), http }),
    calls: () => Object.values(replays).flatMap((replay) => replay.calls.map((call) => call.url)),
  };
}
