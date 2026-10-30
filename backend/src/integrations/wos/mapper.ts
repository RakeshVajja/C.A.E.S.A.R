import type { PublicationInput } from '../../services/normalization/normalizedPublication';
import { normalizeDois } from '../../services/normalization/doi';
import { wosTypeFamily } from './typeFamily';
import type { WosDocument } from './types';

/**
 * Web of Science Starter document → PublicationInput (Project_plan.md §7, §13.7). The only place
 * that knows the Web of Science document shape; everything downstream is source-independent.
 *
 *   external_id   the accession number `uid` ("WOS:…")
 *   title         title
 *   DOI           identifiers.doi
 *   year          source.publishYear
 *   venue         source.sourceTitle
 *   type family   types (+ ISSN/ISBN presence) (typeFamily.ts)
 *   authors       names.authors[].displayName, in the order given; absent → null (never invented)
 *   raw_metadata  the whole document — identifiers (ISSN, eISSN, ISBN, PMID), authors with their
 *                 ResearcherIDs, links, Times Cited — minus excluded content (abstracts)
 */
export function mapWosDocument(document: WosDocument): PublicationInput {
  const identifiers = document.identifiers ?? {};
  const rawDois = [identifiers.doi];
  const authorNames = (document.names?.authors ?? [])
    .map((author) => author.displayName?.trim())
    .filter((name): name is string => Boolean(name));

  return {
    source: 'WOS',
    externalId: document.uid,
    title: document.title ?? '',
    dois: rawDois,
    year: document.source?.publishYear ?? null,
    venue: document.source?.sourceTitle ?? null,
    typeFamily: wosTypeFamily({
      types: document.types,
      sourceTypes: document.sourceTypes,
      hasIssn: Boolean(identifiers.issn?.trim() || identifiers.eissn?.trim()),
      hasIsbn: Boolean(identifiers.isbn?.trim() || identifiers.eisbn?.trim()),
      dois: normalizeDois(rawDois),
    }),
    authorNamesDisplay: authorNames.length > 0 ? authorNames.join('; ') : null,
    rawMetadata: document,
  };
}

/**
 * The Web of Science Core Collection Times Cited of a document (`citations[db=WOS].count`), or
 * null when the document carries none (plans without Times Cited, or no WOS entry).
 */
export function wosTimesCited(document: WosDocument): number | null {
  const entry = (document.citations ?? []).find((citation) => citation.db?.trim().toUpperCase() === 'WOS');
  const count = entry?.count;
  return typeof count === 'number' && Number.isSafeInteger(count) && count >= 0 ? count : null;
}
