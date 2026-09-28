/**
 * Manual smoke check against the live ORCID Public API (never run by automated tests):
 *   npm run smoke:orcid -- 0000-0003-1613-5981
 * Validates the iD, fetches every work summary, maps and normalizes each one, and prints a summary.
 * Read-only: nothing is written to the database.
 */
import { OrcidClient } from '../src/integrations/orcid/client';
import { mapOrcidWorkSummary } from '../src/integrations/orcid/mapper';
import { buildNormalizedPublication, NormalizationError } from '../src/services/normalization/normalizedPublication';

async function main(): Promise<void> {
  const orcidId = process.argv[2];
  if (!orcidId) throw new Error('Usage: npm run smoke:orcid -- <ORCID iD>');

  const started = Date.now();
  const { orcid, summaries, duplicatePutCodes } = await new OrcidClient().fetchWorks(orcidId);

  const families: Record<string, number> = {};
  let skipped = 0;
  let withDoi = 0;
  let withoutYear = 0;
  for (const summary of summaries) {
    try {
      const record = buildNormalizedPublication(mapOrcidWorkSummary(orcid, summary));
      families[record.typeFamily] = (families[record.typeFamily] ?? 0) + 1;
      if (record.dois.length > 0) withDoi++;
      if (record.year === null) withoutYear++;
    } catch (error) {
      if (!(error instanceof NormalizationError)) throw error;
      skipped++;
    }
  }

  console.log({
    orcid,
    fetched: summaries.length,
    duplicatePutCodes: duplicatePutCodes.length,
    normalized: summaries.length - skipped,
    skipped,
    withDoi,
    withoutYear,
    typeFamilies: families,
    seconds: (Date.now() - started) / 1000,
  });
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
