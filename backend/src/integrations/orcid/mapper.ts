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
 * - venue: journal-title; author names: not in summaries (null);
 * - ISSNs (stage 15.6): external identifiers of type issn/eissn with relationship "part-of" (the
 *   journal the work is part of).
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
    issns: orcidIssns(summary),
    rawMetadata: summary,
  };
}

/** Journal ISSNs of a work summary (raw or stored raw_metadata, read defensively). */
export function orcidIssns(summary: unknown): string[] {
  const ids = (summary as { 'external-ids'?: { 'external-id'?: unknown } | null } | null)?.['external-ids']?.['external-id'];
  if (!Array.isArray(ids)) return [];
  return ids
    .filter((id): id is Record<string, unknown> => id !== null && typeof id === 'object')
    .filter((id) => /^e?issn$/i.test(String(id['external-id-type'] ?? '')) && id['external-id-relationship'] === 'part-of')
    .map((id) => id['external-id-value'])
    .filter((value): value is string => typeof value === 'string');
}
