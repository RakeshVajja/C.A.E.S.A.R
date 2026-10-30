import type { PublicationInput } from '../../services/normalization/normalizedPublication';
import { normalizeDois } from '../../services/normalization/doi';
import { scopusEid } from './client';
import { scopusTypeFamily } from './typeFamily';
import type { ScopusSearchEntry } from './types';

/**
 * Scopus search entry → PublicationInput (Project_plan.md §7, §13.6). The only place that knows the
 * Scopus document shape; everything downstream is source-independent.
 *
 *   external_id   the EID "2-s2.0-<SCOPUS_ID>" (derived from dc:identifier; a returned eid must match)
 *   title         dc:title
 *   DOI           prism:doi
 *   year          the year of prism:coverDate (YYYY-MM-DD)
 *   venue         prism:publicationName
 *   type family   subtype + prism:aggregationType (typeFamily.ts)
 *   authors       the STANDARD view carries only the first author (dc:creator), so no author list is
 *                 built from it — a single name would misrepresent the author list. A full `author`
 *                 array (COMPLETE view only) is used when present.
 *   raw_metadata  the whole entry, including ISSN/eISSN, source id, affiliations, dc:creator and the
 *                 cited-by count, minus excluded content (abstracts)
 */
export function mapScopusDocument(entry: ScopusSearchEntry): PublicationInput {
  const rawDois = [entry['prism:doi']];
  const authorNames = (entry.author ?? [])
    .map((author) => author.authname?.trim())
    .filter((name): name is string => Boolean(name));

  return {
    source: 'SCOPUS',
    externalId: scopusEid(entry['dc:identifier']),
    title: entry['dc:title'] ?? '',
    dois: rawDois,
    year: coverYear(entry['prism:coverDate']),
    venue: entry['prism:publicationName'] ?? null,
    typeFamily: scopusTypeFamily({
      subtype: entry.subtype,
      aggregationType: entry['prism:aggregationType'],
      dois: normalizeDois(rawDois),
    }),
    authorNamesDisplay: authorNames.length > 0 ? authorNames.join(', ') : null,
    issns: scopusIssns(entry),
    rawMetadata: entry,
  };
}

/** The source's print and electronic ISSNs (`prism:issn`, `prism:eIssn`; Scopus omits the hyphen). */
export function scopusIssns(entry: unknown): string[] {
  const record = (entry ?? {}) as Record<string, unknown>;
  return [record['prism:issn'], record['prism:eIssn']].filter((value): value is string => typeof value === 'string');
}

function coverYear(coverDate: string | null | undefined): number | null {
  const match = /^(\d{4})(?:-\d{2}-\d{2})?$/.exec(coverDate?.trim() ?? '');
  return match ? Number(match[1]) : null;
}

/** The Scopus cited-by count of an entry, or null when it is absent or not a non-negative integer. */
export function scopusCitationCount(entry: ScopusSearchEntry): number | null {
  const value = entry['citedby-count'];
  if (typeof value !== 'string' || !/^\d+$/.test(value.trim())) return null;
  const count = Number(value.trim());
  return Number.isSafeInteger(count) ? count : null;
}
