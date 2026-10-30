import type { TypeFamily } from '@prisma/client';

/**
 * Scopus → type family (Project_plan.md §7.3, §7.4; stage 15.3). Scopus describes a document by its
 * `subtype` (ar, cp, re, ch, bk, …) and its source's `prism:aggregationType` (Journal, Conference
 * Proceeding, Book, Book Series, Trade Journal, …). Like OpenAlex, the document type alone is not
 * enough: an "article" or "review" counts as a journal article only in a journal, and as a
 * conference paper only in conference proceedings. Everything else — editorials, letters, notes,
 * errata, short surveys, data papers, reports, conference reviews — is OTHER, which never
 * auto-merges by title (§8). A DOI under 10.48550/ (arXiv) is a preprint, as for every source.
 * Initial mapping from Elsevier's documented codes; to be checked against real data in stage 15.9.
 */
export interface ScopusTypeInput {
  subtype: string | null | undefined;
  aggregationType: string | null | undefined;
  dois: readonly string[];
}

const ARXIV_DOI_PREFIX = '10.48550/';

export function scopusTypeFamily({ subtype, aggregationType, dois }: ScopusTypeInput): TypeFamily {
  const code = subtype?.trim().toLowerCase() ?? '';
  const venue = aggregationType?.trim().toLowerCase() ?? '';

  if (dois.some((doi) => doi.startsWith(ARXIV_DOI_PREFIX))) return 'PREPRINT';
  if (code === 'cp') return 'CONFERENCE';
  if (code === 'ar' || code === 're') {
    if (venue === 'journal') return 'JOURNAL';
    if (venue === 'conference proceeding') return 'CONFERENCE';
    return 'OTHER';
  }
  if (code === 'ch') return 'BOOK_CHAPTER';
  if (code === 'bk') return 'BOOK';
  return 'OTHER';
}
