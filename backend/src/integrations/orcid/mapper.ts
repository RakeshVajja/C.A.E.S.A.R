import type { PublicationInput } from '../../services/normalization/normalizedPublication';
import { orcidTypeFamily } from './typeFamily';
import type { OrcidWorkSummary } from './types';

/**
 * ORCID work summary → PublicationInput (Project_plan.md §7, §13.5). The only place that knows
 * the ORCID work-summary shape; everything downstream is source-independent.
 *
 * - external_id = "{orcid}:{put-code}" — one source record per work summary;
 * - DOIs: only external identifiers of type doi with relationship "self" (part-of/version-of ignored);
 * - title: title.title.value only; the subtitle stays in raw_metadata (decision #44);
 * - year: publication-date.year when present, otherwise unknown;
 * - venue: journal-title; author names: not in summaries (null).
 */
export function mapOrcidWorkSummary(orcid: string, summary: OrcidWorkSummary): PublicationInput {
  const selfDois = (summary['external-ids']?.['external-id'] ?? [])
    .filter((id) => id['external-id-type'].toLowerCase() === 'doi' && id['external-id-relationship'] === 'self')
    .map((id) => id['external-id-value']);

  const yearText = summary['publication-date']?.year?.value ?? null;
  const year = yearText !== null && /^\d{4}$/.test(yearText.trim()) ? Number(yearText.trim()) : null;

  return {
    source: 'ORCID',
    externalId: `${orcid}:${summary['put-code']}`,
    title: summary.title?.title?.value ?? '',
    dois: selfDois,
    year,
    venue: summary['journal-title']?.value ?? null,
    typeFamily: orcidTypeFamily(summary.type),
    authorNamesDisplay: null,
    rawMetadata: summary,
  };
}
