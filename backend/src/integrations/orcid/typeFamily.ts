import type { TypeFamily } from '@prisma/client';

/**
 * ORCID work type → type family (Project_plan.md §7.3, §7.4).
 * Initial mapping; to be refined with recorded fixtures in Phase 6.
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
