import type { PublicationSource, TypeFamily } from '@prisma/client';
import { normalizeTitle } from '../normalization/title';

/**
 * Canonical metadata selection (Project_plan.md §9):
 *   CURATED → OpenAlex → DBLP → ORCID → MANUAL
 * CURATED is handled by the caller (curated publications are never recomputed).
 * For each field the first non-empty value in source priority order wins.
 */
export const SOURCE_PRIORITY: readonly PublicationSource[] = ['OPENALEX', 'DBLP', 'ORCID', 'MANUAL'];

export interface SourceRecordMetadata {
  id: string;
  source: PublicationSource;
  title: string;
  year: number | null;
  venue: string | null;
  typeFamily: TypeFamily;
  doi: string | null;
  authorNamesDisplay: string | null;
  firstSeenAt: Date;
}

export interface CanonicalMetadata {
  title: string;
  normalizedTitle: string;
  year: number | null;
  venue: string | null;
  typeFamily: TypeFamily;
  authorNamesDisplay: string | null;
  doi: string | null;
}

/**
 * @param isDoiTaken returns true when a DOI already belongs to a different publication;
 *   such a DOI is skipped because canonical DOIs are unique (§8.3).
 */
export function selectCanonicalMetadata(
  records: readonly SourceRecordMetadata[],
  isDoiTaken: (doi: string) => boolean,
): CanonicalMetadata {
  if (records.length === 0) throw new Error('Cannot select canonical metadata without source records');

  // Deterministic order: source priority, then oldest record first, then id.
  const ordered = [...records].sort(
    (a, b) =>
      SOURCE_PRIORITY.indexOf(a.source) - SOURCE_PRIORITY.indexOf(b.source) ||
      a.firstSeenAt.getTime() - b.firstSeenAt.getTime() ||
      a.id.localeCompare(b.id),
  );

  const first = <T>(pick: (record: SourceRecordMetadata) => T | null): T | null => {
    for (const record of ordered) {
      const value = pick(record);
      if (value !== null && value !== '') return value;
    }
    return null;
  };

  const title = first((r) => r.title.trim() || null) ?? ordered[0].title;

  return {
    title,
    normalizedTitle: normalizeTitle(title),
    year: first((r) => r.year),
    venue: first((r) => r.venue),
    // OTHER means "no usable type information" (§7.3), so it does not outrank a known family.
    typeFamily: first((r) => (r.typeFamily === 'OTHER' ? null : r.typeFamily)) ?? 'OTHER',
    authorNamesDisplay: first((r) => r.authorNamesDisplay),
    doi: first((r) => (r.doi && !isDoiTaken(r.doi) ? r.doi : null)),
  };
}
