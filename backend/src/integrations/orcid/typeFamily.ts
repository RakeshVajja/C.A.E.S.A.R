import type { TypeFamily } from '@prisma/client';

/**
 * ORCID work type → type family (Project_plan.md §7.3, §7.4). Confirmed against real ORCID records
 * in Phase 6 (types seen: journal-article, preprint, other, data-set, conference-paper,
 * book-chapter, report, book). Every other ORCID type (e.g. conference-abstract, edited-book,
 * working-paper, dissertation-thesis, report, data-set) → OTHER.
 */
const ORCID_TYPES: Record<string, TypeFamily> = {
  preprint: 'PREPRINT',
  'conference-paper': 'CONFERENCE',
  'journal-article': 'JOURNAL',
  'book-chapter': 'BOOK_CHAPTER',
  book: 'BOOK',
};

export function orcidTypeFamily(type: string | null | undefined): TypeFamily {
  // ORCID uses "journal-article"; tolerate "JOURNAL_ARTICLE"-style spellings.
  const key = (type ?? '').trim().toLowerCase().replace(/_/g, '-');
  return ORCID_TYPES[key] ?? 'OTHER';
}
