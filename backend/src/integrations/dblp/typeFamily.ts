import type { TypeFamily } from '@prisma/client';

/**
 * DBLP → type family (Project_plan.md §7.3, §7.4). Uses the record type
 * (e.g. "Inproceedings", "Informal", or a bibtex type URI ending in it) and the record key.
 * Initial mapping; to be refined with recorded fixtures in Phase 5.
 */
export interface DblpTypeInput {
  recordType: string | null | undefined;
  /** DBLP record key, e.g. "conf/cav/KupfermanV96" or "journals/corr/abs-1306-5726". */
  key: string;
}

export function dblpTypeFamily({ recordType, key }: DblpTypeInput): TypeFamily {
  // Accept plain names as well as URIs such as "https://dblp.org/rdf/schema#Inproceedings".
  const type = (recordType ?? '').trim().split(/[#/]/).pop()?.toLowerCase() ?? '';

  if (type === 'informal' || key.startsWith('journals/corr/')) return 'PREPRINT';
  if (type === 'inproceedings') return 'CONFERENCE';
  if (type === 'article') return 'JOURNAL';
  if (type === 'incollection') return 'BOOK_CHAPTER';
  if (type === 'book') return 'BOOK';
  return 'OTHER';
}
