import type { TypeFamily } from '@prisma/client';

/**
 * OpenAlex → type family (Project_plan.md §7.3, §7.4). OpenAlex's `type` alone is not
 * reliable, so the primary location's source type is used as well.
 *
 * Preprint detection applies only the unambiguous §7.4 rules (type "preprint", arXiv DOI).
 * The "primary source is a repository where applicable" rule is DEFERRED to Phase 4
 * (decision log #25): it will be settled with recorded OpenAlex fixtures. Until then a
 * repository-hosted work follows the normal mapping (e.g. article + repository → OTHER).
 */
export interface OpenAlexTypeInput {
  /** Work `type`, e.g. "article", "conference-paper", "preprint". */
  type: string | null | undefined;
  /** `primary_location.source.type`, e.g. "journal", "conference", "repository". */
  sourceType: string | null | undefined;
  /** Normalized DOIs of the work. */
  dois: readonly string[];
}

const ARXIV_DOI_PREFIX = '10.48550/';

export function openAlexTypeFamily({ type, sourceType, dois }: OpenAlexTypeInput): TypeFamily {
  const workType = type?.trim().toLowerCase() ?? '';
  const venueType = sourceType?.trim().toLowerCase() ?? '';

  if (workType === 'preprint') return 'PREPRINT';
  if (dois.some((doi) => doi.startsWith(ARXIV_DOI_PREFIX))) return 'PREPRINT';

  if (workType === 'conference-paper' || venueType === 'conference') return 'CONFERENCE';
  if (workType === 'article' && venueType === 'journal') return 'JOURNAL';
  if (workType === 'book-chapter') return 'BOOK_CHAPTER';
  if (workType === 'book') return 'BOOK';
  return 'OTHER';
}
