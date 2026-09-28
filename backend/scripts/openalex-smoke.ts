/**
 * Manual smoke check against the live OpenAlex API (never run by automated tests):
 *   npm run smoke:openalex -- A5023888391
 * Validates the author, fetches every page, maps and normalizes each work, and prints a summary.
 * Read-only: nothing is written to the database.
 */
import { env } from '../src/config/env';
import { OpenAlexClient } from '../src/integrations/openalex/client';
import { mapOpenAlexWork } from '../src/integrations/openalex/mapper';
import { buildNormalizedPublication, NormalizationError } from '../src/services/normalization/normalizedPublication';

async function main(): Promise<void> {
  const authorId = process.argv[2];
  if (!authorId) throw new Error('Usage: npm run smoke:openalex -- <OpenAlex author ID>');

  const client = new OpenAlexClient({ apiKey: env.openAlexApiKey });
  const started = Date.now();
  const { author, works, reportedCount } = await client.fetchAuthorWorks(authorId);

  const families: Record<string, number> = {};
  let skipped = 0;
  let withDoi = 0;
  for (const work of works) {
    try {
      const record = buildNormalizedPublication(mapOpenAlexWork(work));
      families[record.typeFamily] = (families[record.typeFamily] ?? 0) + 1;
      if (record.dois.length > 0) withDoi++;
    } catch (error) {
      if (!(error instanceof NormalizationError)) throw error;
      skipped++;
    }
  }

  console.log({
    author,
    reportedCount,
    fetched: works.length,
    normalized: works.length - skipped,
    skipped,
    withDoi,
    typeFamilies: families,
    apiKey: env.openAlexApiKey ? 'configured' : 'keyless',
    seconds: (Date.now() - started) / 1000,
  });
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
