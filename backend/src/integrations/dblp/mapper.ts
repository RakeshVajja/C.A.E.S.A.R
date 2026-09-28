import { normalizeDois } from '../../services/normalization/doi';
import type { PublicationInput } from '../../services/normalization/normalizedPublication';
import { dblpRecordKey } from './client';
import { dblpTypeFamily } from './typeFamily';
import type { DblpPublication } from './types';

/**
 * DBLP record → PublicationInput (Project_plan.md §7, §13.4). The only place that knows the
 * dblp record shape; everything downstream is source-independent.
 */

const DBLP_SCHEMA = 'https://dblp.org/rdf/schema#';
const GENERIC_CLASS = `${DBLP_SCHEMA}Publication`;

/**
 * The record type is the record's specific dblp class (every record carries exactly one besides
 * dblp:Publication). bibtexType is only a fallback: CoRR preprints are dblp:Informal but have
 * bibtexType Article, so bibtexType alone would misclassify them.
 */
export function dblpRecordType(record: Pick<DblpPublication, 'types' | 'bibtexType'>): string | null {
  const specific = record.types.filter((t) => t.startsWith(DBLP_SCHEMA) && t !== GENERIC_CLASS);
  if (specific.length > 0) return specific.sort()[0].slice(DBLP_SCHEMA.length);
  return record.bibtexType;
}

export function mapDblpPublication(record: DblpPublication): PublicationInput {
  const key = dblpRecordKey(record.publication);
  const year = record.year !== null && /^\d{4}$/.test(record.year) ? Number(record.year) : null;

  return {
    source: 'DBLP',
    externalId: key,
    title: record.title ?? '',
    dois: record.dois,
    year,
    venue: record.venues[0] ?? null,
    typeFamily: dblpTypeFamily({ recordType: dblpRecordType(record), key, dois: normalizeDois(record.dois) }),
    authorNamesDisplay: record.authors.length > 0 ? record.authors.join(', ') : null,
    rawMetadata: {
      key,
      uri: record.publication,
      title: record.title,
      year: record.year,
      types: record.types,
      bibtexType: record.bibtexType,
      dois: record.dois,
      venues: record.venues,
      authors: record.authors,
    },
  };
}
