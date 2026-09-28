import { FetchError, HttpDependencies, SourceHttpClient, SourceHttpConfig } from '../http/httpClient';
import {
  DblpAuthorRow,
  DblpPublication,
  DblpRecordRow,
  SparqlBinding,
  SparqlResults,
  SparqlResultsSchema,
} from './types';

/**
 * DBLP client (Project_plan.md §13.4). Uses only the dblp SPARQL endpoint (sparql.dblp.org);
 * the pid XML pages, the search API and mirrors are not used (they return bot-protection HTML).
 *
 * For one PID it runs three throttled queries, all validated before anything is returned:
 *  1. identity: the PID must be a dblp:Person (a missing PID or a disambiguation page is a failure);
 *  2. records: every record the person is dblp:authoredBy (editor-only dblp:editedBy records are
 *     never selected), one row per record;
 *  3. authors: the author signatures of those records, for display names in dblp order.
 * Records and authors are separate queries because joining them in one query is ~20x slower.
 */

export const DBLP_SPARQL_ENDPOINT = 'https://sparql.dblp.org/sparql';
const DBLP_PERSON_PREFIX = 'https://dblp.org/pid/';
const DBLP_RECORD_PREFIX = 'https://dblp.org/rec/';
const DBLP_SCHEMA = 'https://dblp.org/rdf/schema#';

export const DBLP_HTTP_CONFIG: SourceHttpConfig = {
  name: 'DBLP',
  minIntervalMs: 1_500, // one request at a time, 1–2 s apart (§13.4)
  timeoutMs: 120_000,
  maxRetries: 3,
  baseDelayMs: 2_000,
  maxDelayMs: 60_000,
};

/** Identifies this application to dblp (no contact details). */
export const DBLP_USER_AGENT = 'CSE-Research-Hub/0.1 (academic project)';

const PREFIXES = `PREFIX dblp: <${DBLP_SCHEMA}>
PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>`;

// PIDs look like "v/MosheYVardi", "129/1623" or "12/3456-1".
const PID_PATTERN = /^[a-z0-9]+\/[A-Za-z0-9_-]+$/;

/** Accepts "v/MosheYVardi", "https://dblp.org/pid/v/MosheYVardi(.html|.xml)"; returns the bare PID. */
export function normalizeDblpPid(value: string): string {
  const pid = value
    .trim()
    .replace(/^https?:\/\/(?:www\.)?dblp\.org\/pid\//i, '')
    .replace(/\.(?:html|xml|rdf|nt|ttl)$/i, '');
  if (!PID_PATTERN.test(pid)) throw new FetchError('INVALID_RESPONSE', `"${value}" is not a valid DBLP PID`);
  return pid;
}

export function identityQuery(pid: string): string {
  return `${PREFIXES}
SELECT ?type ?name WHERE {
  <${DBLP_PERSON_PREFIX}${pid}> rdf:type ?type .
  OPTIONAL { <${DBLP_PERSON_PREFIX}${pid}> dblp:primaryCreatorName ?name }
}`;
}

export function recordsQuery(pid: string): string {
  return `${PREFIXES}
SELECT ?publication (SAMPLE(?titleValue) AS ?title) (SAMPLE(?yearValue) AS ?year)
  (SAMPLE(?bibtexTypeValue) AS ?bibtexType)
  (GROUP_CONCAT(DISTINCT STR(?class); separator="\\t") AS ?types)
  (GROUP_CONCAT(DISTINCT STR(?doiValue); separator="\\t") AS ?dois)
  (GROUP_CONCAT(DISTINCT ?venueValue; separator="\\t") AS ?venues)
WHERE {
  ?publication dblp:authoredBy <${DBLP_PERSON_PREFIX}${pid}> ;
               rdf:type ?class .
  OPTIONAL { ?publication dblp:title ?titleValue }
  OPTIONAL { ?publication dblp:yearOfPublication ?yearValue }
  OPTIONAL { ?publication dblp:bibtexType ?bibtexTypeValue }
  OPTIONAL { ?publication dblp:doi ?doiValue }
  OPTIONAL { ?publication dblp:publishedIn ?venueValue }
}
GROUP BY ?publication
ORDER BY ?publication`;
}

export function authorsQuery(pid: string): string {
  return `${PREFIXES}
SELECT ?publication ?ordinal ?name WHERE {
  ?publication dblp:authoredBy <${DBLP_PERSON_PREFIX}${pid}> ;
               dblp:hasSignature ?signature .
  ?signature rdf:type dblp:AuthorSignature ;
             dblp:signatureOrdinal ?ordinal ;
             dblp:signatureDblpName ?name .
}
ORDER BY ?publication ?ordinal`;
}

export function sparqlUrl(query: string, endpoint = DBLP_SPARQL_ENDPOINT): string {
  return `${endpoint}?query=${encodeURIComponent(query)}`;
}

export interface ValidatedPerson {
  pid: string;
  name: string | null;
}

export interface DblpFetchResult {
  person: ValidatedPerson;
  publications: DblpPublication[];
}

export interface DblpClientOptions {
  endpoint?: string;
  http?: Partial<SourceHttpConfig>;
  deps?: HttpDependencies;
}

export class DblpClient {
  private readonly http: SourceHttpClient;
  private readonly endpoint: string;

  constructor(options: DblpClientOptions = {}) {
    this.http = new SourceHttpClient({ ...DBLP_HTTP_CONFIG, ...options.http }, options.deps);
    this.endpoint = options.endpoint ?? DBLP_SPARQL_ENDPOINT;
  }

  /** The PID must name a dblp:Person. Missing → IDENTITY_NOT_FOUND; disambiguation/other → IDENTITY_INVALID. */
  async validatePerson(externalId: string): Promise<ValidatedPerson> {
    const pid = normalizeDblpPid(externalId);
    const results = await this.select(identityQuery(pid), ['type', 'name'], `identity ${pid}`);
    const types = new Set(results.results.bindings.map((b) => b.type?.value).filter(Boolean));

    if (types.size === 0) {
      throw new FetchError('IDENTITY_NOT_FOUND', `DBLP person ${pid} does not exist`);
    }
    if (types.has(`${DBLP_SCHEMA}AmbiguousCreator`)) {
      throw new FetchError(
        'IDENTITY_INVALID',
        `DBLP PID ${pid} is a disambiguation page (several people); use the PID of the specific person`,
      );
    }
    if (!types.has(`${DBLP_SCHEMA}Person`)) {
      throw new FetchError('IDENTITY_INVALID', `DBLP PID ${pid} is not a person (${[...types].join(', ')})`);
    }
    const name = results.results.bindings.find((b) => b.name)?.name?.value ?? null;
    return { pid, name };
  }

  /** Every record the person authored, with ordered author names. */
  async fetchPublications(pid: string): Promise<DblpPublication[]> {
    const recordResults = await this.select(
      recordsQuery(pid),
      ['publication', 'title', 'year', 'bibtexType', 'types', 'dois', 'venues'],
      `records of ${pid}`,
    );
    const records = recordResults.results.bindings.map((binding, index) => toRecordRow(binding, index, pid));

    const authorResults = await this.select(authorsQuery(pid), ['publication', 'ordinal', 'name'], `authors of ${pid}`);
    const authors = authorResults.results.bindings.map((binding, index) => toAuthorRow(binding, index, pid));

    // The two queries must describe the same set of records (decision #41).
    const recordUris = new Set(records.map((record) => record.publication));
    const authorsByRecord = new Map<string, DblpAuthorRow[]>();
    for (const author of authors) {
      if (!recordUris.has(author.publication)) {
        throw new FetchError(
          'INVALID_RESPONSE',
          `DBLP authors of ${pid} include ${author.publication}, which is not in the records result`,
        );
      }
      const list = authorsByRecord.get(author.publication) ?? [];
      list.push(author);
      authorsByRecord.set(author.publication, list);
    }
    // Every authored record has at least the person's own author signature.
    const withoutAuthors = records.filter((record) => !authorsByRecord.has(record.publication));
    if (withoutAuthors.length > 0) {
      throw new FetchError(
        'INCOMPLETE',
        `DBLP authors of ${pid} are missing for ${withoutAuthors.length} record(s), e.g. ${withoutAuthors[0].publication}`,
      );
    }
    return records.map((record) => ({
      ...record,
      authors: (authorsByRecord.get(record.publication) ?? [])
        .sort((a, b) => a.ordinal - b.ordinal)
        .map((author) => author.name),
    }));
  }

  /** Identity validation followed by the complete fetch (fetch-then-write, §14). */
  async fetchPersonPublications(externalId: string): Promise<DblpFetchResult> {
    const person = await this.validatePerson(externalId);
    const publications = await this.fetchPublications(person.pid);
    return { person, publications };
  }

  private async select(query: string, expectedVars: string[], what: string): Promise<SparqlResults> {
    const url = sparqlUrl(query, this.endpoint);
    const response = await this.http.getJson(url, {
      headers: { Accept: 'application/sparql-results+json', 'User-Agent': DBLP_USER_AGENT },
    });

    const parsed = SparqlResultsSchema.safeParse(response.body);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      throw new FetchError(
        'INVALID_RESPONSE',
        `DBLP returned an invalid SPARQL result for ${what}: ${issue.path.join('.') || '(root)'} ${issue.message}`,
        { url },
      );
    }
    const missing = expectedVars.filter((v) => !parsed.data.head.vars.includes(v));
    if (missing.length > 0) {
      throw new FetchError('INVALID_RESPONSE', `DBLP result for ${what} lacks variables: ${missing.join(', ')}`, { url });
    }
    // Completeness (decision #41): the rows delivered must be exactly the rows dblp produced.
    const total = parsed.data.meta['result-size-total'];
    const delivered = parsed.data.results.bindings.length;
    if (delivered < total) {
      throw new FetchError('INCOMPLETE', `DBLP reported ${total} rows for ${what} but returned ${delivered}`, { url });
    }
    if (delivered > total) {
      throw new FetchError('INVALID_RESPONSE', `DBLP returned ${delivered} rows for ${what} but reported ${total}`, { url });
    }
    return parsed.data;
  }
}

function requireRecordUri(binding: SparqlBinding, index: number, what: string): string {
  const term = binding.publication;
  if (!term || term.type !== 'uri' || !term.value.startsWith(DBLP_RECORD_PREFIX)) {
    throw new FetchError('INVALID_RESPONSE', `DBLP ${what}: row ${index + 1} has no dblp record URI`);
  }
  return term.value;
}

const split = (value: string | undefined): string[] =>
  value ? [...new Set(value.split('\t').map((v) => v.trim()).filter(Boolean))].sort() : [];

function toRecordRow(binding: SparqlBinding, index: number, pid: string): DblpRecordRow {
  return {
    publication: requireRecordUri(binding, index, `records of ${pid}`),
    title: binding.title?.value ?? null,
    year: binding.year?.value ?? null,
    bibtexType: binding.bibtexType?.value ?? null,
    types: split(binding.types?.value),
    // GROUP_CONCAT order is not stable between runs; sorting keeps the primary DOI deterministic.
    dois: split(binding.dois?.value),
    venues: split(binding.venues?.value),
  };
}

function toAuthorRow(binding: SparqlBinding, index: number, pid: string): DblpAuthorRow {
  const publication = requireRecordUri(binding, index, `authors of ${pid}`);
  const ordinal = Number(binding.ordinal?.value);
  const name = binding.name?.value?.trim();
  if (!Number.isInteger(ordinal) || ordinal < 1 || !name) {
    throw new FetchError('INVALID_RESPONSE', `DBLP authors of ${pid}: row ${index + 1} has no valid ordinal and name`);
  }
  return { publication, ordinal, name };
}

/** "https://dblp.org/rec/conf/cav/KupfermanV96" → "conf/cav/KupfermanV96". */
export function dblpRecordKey(uri: string): string {
  return uri.slice(DBLP_RECORD_PREFIX.length);
}
