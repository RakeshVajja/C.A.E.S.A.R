import type { TypeFamily } from '@prisma/client';

/**
 * DBLP → type family (Project_plan.md §7.3, §7.4; decision #40).
 *
 * Record type is the record's dblp class (see mapper.dblpRecordType), with a bibtex type URI only
 * as a fallback. Preprint signals (neither `journals/corr/` alone nor `Informal` alone suffices):
 *  - class Informal AND key under journals/corr/ (CoRR preprints), or
 *  - a DOI beginning with 10.48550/ (arXiv).
 * Evidence from recorded sparql.dblp.org data: all 97 real CoRR preprints are Informal under
 * journals/corr/; 11 published EPTCS/LMCS papers sit under journals/corr/ as Inproceedings/Article;
 * 6 Dagstuhl seminar items are Informal outside CoRR and are not preprints (→ OTHER).
 */
export interface DblpTypeInput {
  recordType: string | null | undefined;
  /** DBLP record key, e.g. "conf/cav/KupfermanV96" or "journals/corr/abs-1306-5726". */
  key: string;
  /** Normalized DOIs of the record. */
  dois: readonly string[];
}

const CORR_KEY_PREFIX = 'journals/corr/';
const ARXIV_DOI_PREFIX = '10.48550/';

export function dblpTypeFamily({ recordType, key, dois }: DblpTypeInput): TypeFamily {
  // Accept plain names as well as URIs such as "https://dblp.org/rdf/schema#Inproceedings".
  const type = (recordType ?? '').trim().split(/[#/]/).pop()?.toLowerCase() ?? '';

  if (dois.some((doi) => doi.startsWith(ARXIV_DOI_PREFIX))) return 'PREPRINT';
  if (type === 'informal') return key.startsWith(CORR_KEY_PREFIX) ? 'PREPRINT' : 'OTHER';
  if (type === 'inproceedings') return 'CONFERENCE';
  if (type === 'article') return 'JOURNAL';
  if (type === 'incollection') return 'BOOK_CHAPTER';
  if (type === 'book') return 'BOOK';
  return 'OTHER'; // Data, Reference, Withdrawn, Editorship, unknown
}
