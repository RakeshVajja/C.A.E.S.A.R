/**
 * Manual smoke check against the live dblp SPARQL endpoint (never run by automated tests):
 *   npm run smoke:dblp -- v/MosheYVardi
 * Validates the PID, fetches every authored record with its authors, maps and normalizes each
 * record, and prints a summary. Read-only: nothing is written to the database.
 */
import { DblpClient } from '../src/integrations/dblp/client';
import { mapDblpPublication } from '../src/integrations/dblp/mapper';
import { buildNormalizedPublication, NormalizationError } from '../src/services/normalization/normalizedPublication';

async function main(): Promise<void> {
  const pid = process.argv[2];
  if (!pid) throw new Error('Usage: npm run smoke:dblp -- <DBLP PID, e.g. v/MosheYVardi>');

  const started = Date.now();
  const { person, publications } = await new DblpClient().fetchPersonPublications(pid);

  const families: Record<string, number> = {};
  let skipped = 0;
  let withDoi = 0;
  let withoutAuthors = 0;
  for (const publication of publications) {
    if (publication.authors.length === 0) withoutAuthors++;
    try {
      const record = buildNormalizedPublication(mapDblpPublication(publication));
      families[record.typeFamily] = (families[record.typeFamily] ?? 0) + 1;
      if (record.dois.length > 0) withDoi++;
    } catch (error) {
      if (!(error instanceof NormalizationError)) throw error;
      skipped++;
    }
  }

  console.log({
    person,
    fetched: publications.length,
    normalized: publications.length - skipped,
    skipped,
    withDoi,
    withoutAuthors,
    typeFamilies: families,
    seconds: (Date.now() - started) / 1000,
  });
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
