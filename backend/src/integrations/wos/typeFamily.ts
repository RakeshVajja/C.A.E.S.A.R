import type { TypeFamily } from '@prisma/client';

/**
 * Web of Science → type family (Project_plan.md §7.3, §7.4; stage 15.4). The Starter API gives the
 * normalized document types (`types`, e.g. "Article", "Proceedings Paper", "Review", "Book
 * Chapter", "Book", "Editorial Material", "Letter", "Meeting Abstract", "Early Access") but no
 * source type, so a journal is recognized by its identifiers: an article or review counts as a
 * journal article only with an ISSN/eISSN and no ISBN (an ISBN means a book or book series).
 * A document can carry several types ("Article; Proceedings Paper"): a proceedings paper is a
 * conference paper whatever else it is. Everything else is OTHER, which never auto-merges by title
 * (§8). A DOI under 10.48550/ (arXiv) is a preprint, as for every source; the Preprint Citation
 * Index (db=PPRN) is never queried. Initial mapping from Clarivate's documented types; to be
 * checked against real data in stage 15.9.
 */
export interface WosTypeInput {
  types: readonly string[] | null | undefined;
  sourceTypes: readonly string[] | null | undefined;
  hasIssn: boolean;
  hasIsbn: boolean;
  dois: readonly string[];
}

const ARXIV_DOI_PREFIX = '10.48550/';

export function wosTypeFamily({ types, sourceTypes, hasIssn, hasIsbn, dois }: WosTypeInput): TypeFamily {
  const listed = types && types.length > 0 ? types : (sourceTypes ?? []);
  const kinds = new Set(listed.map((type) => type.trim().toLowerCase()));

  if (dois.some((doi) => doi.startsWith(ARXIV_DOI_PREFIX))) return 'PREPRINT';
  if (kinds.has('proceedings paper')) return 'CONFERENCE';
  if (kinds.has('book chapter')) return 'BOOK_CHAPTER';
  if (kinds.has('book')) return 'BOOK';
  if (kinds.has('article') || kinds.has('review')) return hasIssn && !hasIsbn ? 'JOURNAL' : 'OTHER';
  return 'OTHER';
}
