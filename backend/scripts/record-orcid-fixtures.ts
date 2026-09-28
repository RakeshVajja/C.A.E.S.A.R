/**
 * Records real ORCID Public API v3.0 responses as test fixtures (tests/fixtures/orcid).
 * Run manually when fixtures need refreshing: `npm run fixtures:orcid`.
 * Automated tests never call the live API; they replay these files.
 * Anonymous access only; redirects are not followed (as in the client).
 */
import fs from 'fs';
import path from 'path';
import { ORCID_API_BASE_URL } from '../src/integrations/orcid/client';

const OUT_DIR = path.resolve(__dirname, '../tests/fixtures/orcid');

const RECORDS: Record<string, string> = {
  // Heather Piwowar: 100 summaries in 73 groups (in-ORCID duplicates, data-sets, part-of ISSNs, several sources).
  'works-piwowar': '0000-0003-1613-5981',
  // Moshe Y. Vardi (also in the DBLP/OpenAlex fixtures): 8 self-entered works, 3 without a title.
  'works-vardi': '0000-0002-0661-5773',
  // Josiah Carberry, ORCID's public test record: subtitles, duplicates.
  'works-carberry': '0000-0002-1825-0097',
  // Well-formed iD with a valid checksum that does not exist (404, error 9016).
  'works-not-found': '0000-0001-2345-6789',
  // A deactivated record (409, error 9044).
  'works-deactivated': '0000-0002-0155-3227',
};

async function main(): Promise<void> {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  for (const [name, orcid] of Object.entries(RECORDS)) {
    const url = `${ORCID_API_BASE_URL}/${orcid}/works`;
    const response = await fetch(url, { headers: { Accept: 'application/json' }, redirect: 'manual' });
    const contentType = response.headers.get('content-type') ?? '';
    const text = await response.text();
    const body: unknown = /json/i.test(contentType) ? JSON.parse(text) : text;
    fs.writeFileSync(path.join(OUT_DIR, `${name}.json`), `${JSON.stringify({ request: url, status: response.status, contentType, body })}\n`);
    console.log(`${name}: HTTP ${response.status} ${contentType}`);
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
