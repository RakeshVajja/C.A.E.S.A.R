import type { PublicationInput } from '../../services/normalization/normalizedPublication';
import { normalizeDois } from '../../services/normalization/doi';
import { shortOpenAlexId } from './client';
import { openAlexTypeFamily } from './typeFamily';
import type { OpenAlexWork } from './types';

/**
 * OpenAlex work → PublicationInput (Project_plan.md §7, §13). The only place that knows the
 * OpenAlex work shape; everything downstream is source-independent.
 */
export function mapOpenAlexWork(work: OpenAlexWork): PublicationInput {
  const ids = (work.ids ?? {}) as Record<string, unknown>;
  const rawDois = [work.doi, typeof ids.doi === 'string' ? ids.doi : null];
  const source = work.primary_location?.source ?? null;

  const authorNames = (work.authorships ?? [])
    .map((authorship) => authorship.author?.display_name?.trim())
    .filter((name): name is string => Boolean(name));

  return {
    source: 'OPENALEX',
    externalId: shortOpenAlexId(work.id),
    title: work.title ?? work.display_name ?? '',
    dois: rawDois,
    year: work.publication_year ?? null,
    venue: source?.display_name ?? null,
    typeFamily: openAlexTypeFamily({
      type: work.type,
      sourceType: source?.type,
      dois: normalizeDois(rawDois),
    }),
    authorNamesDisplay: authorNames.length > 0 ? authorNames.join(', ') : null,
    issns: openAlexIssns(work),
    rawMetadata: work,
  };
}

/**
 * The journal ISSNs of a work (stage 15.6): `primary_location.source.issn` and `issn_l`. Reads a raw
 * work or its stored raw_metadata defensively; unnormalized values (normalization happens later).
 */
export function openAlexIssns(work: unknown): string[] {
  const source = (work as { primary_location?: { source?: { issn?: unknown; issn_l?: unknown } | null } | null } | null)?.primary_location?.source;
  if (!source || typeof source !== 'object') return [];
  const list = Array.isArray(source.issn) ? source.issn : [];
  return [...list, source.issn_l].filter((value): value is string => typeof value === 'string');
}
