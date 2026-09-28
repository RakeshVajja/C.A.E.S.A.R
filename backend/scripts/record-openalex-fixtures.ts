/**
 * Records real OpenAlex responses as test fixtures (tests/fixtures/openalex).
 * Run manually when fixtures need refreshing: `npm run fixtures:openalex`.
 * Automated tests never call the live API; they replay these files.
 *
 * Each fixture stores the request URL, HTTP status, content type and body exactly as received.
 * No API key is sent, so none can leak into the files.
 */
import fs from 'fs';
import path from 'path';
import { OPENALEX_BASE_URL, OPENALEX_WORK_FIELDS } from '../src/integrations/openalex/client';

const OUT_DIR = path.resolve(__dirname, '../tests/fixtures/openalex');
const AUTHOR_FIELDS = 'id,display_name,orcid,works_count';
const SELECT = OPENALEX_WORK_FIELDS.join(',');

/** A small real author whose works span several pages at per-page=25. */
const PAGING_AUTHOR = 'A5023888391';
/** Real works covering mapping edge cases (see tests/integrations/openalex.mapper.test.ts). */
const CASE_WORKS = [
  'W42364276', // conference paper typed "article", source type conference, no DOI
  'W1632042597', // AAAI conference-paper with DOI
  'W3037471945', // arXiv preprint; title contains literal "\n"
  'W2889619879', // AAAI conference-paper ...
  'W2963382544', // ... and a second work with the same DOI (article, repository)
  'W1505349556', // LIPIcs paper in a repository, typed article, submittedVersion
  'W4229843017', // null title
  'W1989783863', // no primary source
  'W2033071128', // journal article
];

async function record(name: string, url: string): Promise<{ body: unknown }> {
  const response = await fetch(url, { headers: { Accept: 'application/json' } });
  const contentType = response.headers.get('content-type') ?? '';
  const text = await response.text();
  let body: unknown = text;
  if (/json/i.test(contentType)) body = JSON.parse(text);
  const fixture = { request: url, status: response.status, contentType, body };
  fs.writeFileSync(path.join(OUT_DIR, `${name}.json`), `${JSON.stringify(fixture, null, 2)}\n`);
  console.log(`${name}: HTTP ${response.status} ${contentType}`);
  await new Promise((resolve) => setTimeout(resolve, 300));
  return { body };
}

async function main(): Promise<void> {
  fs.mkdirSync(OUT_DIR, { recursive: true });

  await record('author-valid', `${OPENALEX_BASE_URL}/authors/${PAGING_AUTHOR}?select=${AUTHOR_FIELDS}`);

  let cursor: string | null = '*';
  for (let page = 1; cursor; page++) {
    const { body } = await record(
      `works-page-${page}`,
      `${OPENALEX_BASE_URL}/works?filter=author.id:${PAGING_AUTHOR}&per-page=25&cursor=${encodeURIComponent(cursor)}&select=${SELECT}`,
    );
    const page_ = body as { meta: { next_cursor: string | null }; results: unknown[] };
    cursor = page_.results.length > 0 ? page_.meta.next_cursor : null;
  }

  await record(
    'works-cases',
    `${OPENALEX_BASE_URL}/works?filter=openalex:${CASE_WORKS.join('|')}&per-page=100&select=${SELECT}`,
  );
  await record('author-not-found', `${OPENALEX_BASE_URL}/authors/A5999999999?select=${AUTHOR_FIELDS}`);
  // OpenAlex's documented merged-author example (docs: 301 to A5006060960); live it answered 404 on 2026-09-28.
  await record('author-merged-documented', `${OPENALEX_BASE_URL}/authors/A5092938886?select=${AUTHOR_FIELDS}`);
  await record(
    'works-nonexistent-author',
    `${OPENALEX_BASE_URL}/works?filter=author.id:A5999999999&per-page=100&cursor=*&select=${SELECT}`,
  );
  await record('works-invalid-author-id', `${OPENALEX_BASE_URL}/works?filter=author.id:A1&per-page=100&select=${SELECT}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
