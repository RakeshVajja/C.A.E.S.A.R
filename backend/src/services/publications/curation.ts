import type { Prisma, TypeFamily } from '@prisma/client';
import { normalizeDoi } from '../normalization/doi';

/**
 * Field-level curation and entry basis (Project_plan.md §6.4, §9, §12.1, §22.4; decisions #124, #125).
 *
 * `publications.curation` holds one entry per administrator-edited canonical field: its basis —
 * `INDEPENDENT` (with evidence), the provider it was derived from, or `PRE_PHASE15` — and an
 * evidence note. Canonical recomputation leaves exactly these fields alone. MANUAL source records
 * carry the same basis in `entry_basis`/`entry_evidence`. A basis is a declaration, not proof of
 * legal independence: provider-derived values keep their provider and are removed with its data.
 */

export const CURATED_FIELDS = ['title', 'year', 'venue', 'type_family', 'author_names_display', 'doi'] as const;
export type CuratedField = (typeof CURATED_FIELDS)[number];

/** Providers a curated value or a manual entry may declare it was derived from. */
export const BASIS_PROVIDERS = ['OPENALEX', 'DBLP', 'ORCID', 'SCOPUS', 'WOS', 'JCR'] as const;
/** Bases accepted from the administrator and professors; PRE_PHASE15 is set only by the migration. */
export const DECLARED_BASES = ['INDEPENDENT', ...BASIS_PROVIDERS] as const;
export type DeclaredBasis = (typeof DECLARED_BASES)[number];
export type Basis = DeclaredBasis | 'PRE_PHASE15';

export interface CurationEntry {
  basis: Basis;
  evidence: string | null;
}
export type Curation = Partial<Record<CuratedField, CurationEntry>>;

const KNOWN_BASES: ReadonlySet<string> = new Set<string>([...DECLARED_BASES, 'PRE_PHASE15']);

/**
 * The stored curation of a publication. A publication curated as a whole record (`is_curated`
 * without entries — edited after the Phase 15 migration but before basis capture) keeps the old
 * whole-record protection (#90): every field counts as curated, with basis PRE_PHASE15, because
 * no Scopus, WoS or JCR data had been ingested when it was edited. An entry with an unknown basis
 * is kept as PRE_PHASE15 only in that legacy case; otherwise it is ignored.
 */
export function readCuration(publication: { isCurated: boolean; curation: Prisma.JsonValue }): Curation {
  const stored = publication.curation;
  const result: Curation = {};
  if (stored !== null && typeof stored === 'object' && !Array.isArray(stored)) {
    for (const field of CURATED_FIELDS) {
      const entry = (stored as Prisma.JsonObject)[field];
      if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) continue;
      const basis = (entry as Prisma.JsonObject).basis;
      const evidence = (entry as Prisma.JsonObject).evidence;
      if (typeof basis !== 'string' || !KNOWN_BASES.has(basis)) continue;
      result[field] = { basis: basis as Basis, evidence: typeof evidence === 'string' && evidence.trim() ? evidence : null };
    }
  }
  if (publication.isCurated && Object.keys(result).length === 0) {
    for (const field of CURATED_FIELDS) result[field] = { basis: 'PRE_PHASE15', evidence: null };
  }
  return result;
}

/** The JSON stored in `publications.curation` (entries in field order). */
export function curationJson(curation: Curation): Prisma.InputJsonObject {
  const json: Record<string, Prisma.InputJsonObject> = {};
  for (const field of CURATED_FIELDS) {
    const entry = curation[field];
    if (entry) json[field] = entry.evidence ? { basis: entry.basis, evidence: entry.evidence } : { basis: entry.basis };
  }
  return json;
}

/**
 * Whether a curated value is independently supported and may be retained by default when a
 * provider's data is removed (§22.4): `INDEPENDENT` with stored evidence. Retention of INDEPENDENT
 * values remains subject to Clarivate's written confirmation. `PRE_PHASE15` values have unknown
 * provenance and are retained only by an explicit administrator decision (#145).
 */
export function isRetainable(entry: CurationEntry): boolean {
  return entry.basis === 'INDEPENDENT' && entry.evidence !== null;
}

/** Evidence for a manual entry (§12.1): a DOI, or a publisher or repository http(s) URL. */
export function isEntryEvidence(text: string): boolean {
  if (normalizeDoi(text)) return true;
  try {
    const url = new URL(text);
    return (url.protocol === 'https:' || url.protocol === 'http:') && url.hostname.includes('.');
  } catch {
    return false;
  }
}

/** Canonical values by curated field, in the shape of the `publications` columns. */
export interface CanonicalFields {
  title: string;
  normalizedTitle: string;
  year: number | null;
  venue: string | null;
  typeFamily: TypeFamily;
  authorNamesDisplay: string | null;
  doi: string | null;
}

/** The columns of `canonical` that belong to fields without a curation entry. */
export function uncuratedColumns(canonical: CanonicalFields, curation: Curation): Partial<CanonicalFields> {
  const data: Partial<CanonicalFields> = {};
  if (!curation.title) {
    data.title = canonical.title;
    data.normalizedTitle = canonical.normalizedTitle;
  }
  if (!curation.year) data.year = canonical.year;
  if (!curation.venue) data.venue = canonical.venue;
  if (!curation.type_family) data.typeFamily = canonical.typeFamily;
  if (!curation.author_names_display) data.authorNamesDisplay = canonical.authorNamesDisplay;
  if (!curation.doi) data.doi = canonical.doi;
  return data;
}
