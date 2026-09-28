/**
 * Records real sparql.dblp.org responses as test fixtures (tests/fixtures/dblp).
 * Run manually when fixtures need refreshing: `npm run fixtures:dblp`.
 * Automated tests never call the live endpoint; they replay these files.
 *
 * Request URLs are built with the client's own query builders, so replayed requests match exactly.
 * Requests are spaced 2 s apart, one at a time.
 */
import fs from 'fs';
import path from 'path';
import { authorsQuery, DBLP_USER_AGENT, identityQuery, recordsQuery, sparqlUrl } from '../src/integrations/dblp/client';

const OUT_DIR = path.resolve(__dirname, '../tests/fixtures/dblp');

/** Moshe Y. Vardi: 830 authored records incl. CoRR/Dagstuhl informal items, multi-DOI records, and editor-only Editorship records (excluded). */
const PERSON = 'v/MosheYVardi';
/** A dblp disambiguation page ("Yongsheng Yu (disambiguation)", AmbiguousCreator). */
const AMBIGUOUS = '00/10049';
/** A well-formed PID that does not exist. */
const MISSING = '00/0000000';

async function record(name: string, url: string, accept = 'application/sparql-results+json'): Promise<void> {
  const response = await fetch(url, { headers: { Accept: accept, 'User-Agent': DBLP_USER_AGENT } });
  const contentType = response.headers.get('content-type') ?? '';
  const text = await response.text();
  let body: unknown = text;
  if (/json/i.test(contentType)) body = JSON.parse(text);
  const fixture = { request: url, status: response.status, contentType, body };
  // Compact JSON: the record and author fixtures are large.
  fs.writeFileSync(path.join(OUT_DIR, `${name}.json`), `${JSON.stringify(fixture)}\n`);
  console.log(`${name}: HTTP ${response.status} ${contentType}`);
  await new Promise((resolve) => setTimeout(resolve, 2_000));
}

async function main(): Promise<void> {
  fs.mkdirSync(OUT_DIR, { recursive: true });

  await record('identity-person', sparqlUrl(identityQuery(PERSON)));
  await record('identity-ambiguous', sparqlUrl(identityQuery(AMBIGUOUS)));
  await record('identity-missing', sparqlUrl(identityQuery(MISSING)));
  await record('records-person', sparqlUrl(recordsQuery(PERSON)));
  await record('authors-person', sparqlUrl(authorsQuery(PERSON)));
  // Evidence for §13.4: the classic dblp pages answer with a bot-protection HTML page (HTTP 200).
  await record('dblp-org-pid-xml', `https://dblp.org/pid/${PERSON}.xml`, 'application/xml');
  // A real SPARQL error response (malformed query).
  await record('sparql-syntax-error', sparqlUrl('SELECT ?x WHERE {'));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
