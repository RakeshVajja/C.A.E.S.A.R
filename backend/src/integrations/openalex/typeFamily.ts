import type { TypeFamily } from '@prisma/client';

/**
 * OpenAlex → type family (Project_plan.md §7.3, §7.4). OpenAlex's `type` alone is not
 * reliable, so the primary location's source type is used as well.
 *
 * Preprints are works typed "preprint" or carrying an arXiv DOI (§7.4). Repository hosting is
 * not a preprint signal (decision #31, settled on live data): repository-hosted works follow the
 * normal mapping (e.g. article + repository → OTHER; conference-paper → CONFERENCE).
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
