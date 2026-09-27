import type { PublicationSource, TypeFamily } from '@prisma/client';
import { normalizeDois } from './doi';
import { JsonValue, stripExcludedContent } from './rawMetadata';
import { normalizeTitle } from './title';

/** The common record every source (and manual entry) is converted into before matching (§7). */
export interface NormalizedPublication {
  source: PublicationSource;
  externalId: string;
  title: string;
  normalizedTitle: string;
  /** Normalized, de-duplicated; the first one is the record's primary DOI. */
  dois: string[];
  year: number | null;
  venue: string | null;
  typeFamily: TypeFamily;
  /** Always equal to typeFamily === 'PREPRINT'; preprint detection happens in the type-family mapping. */
  isPreprint: boolean;
  authorNamesDisplay: string | null;
  rawMetadata: JsonValue | null;
}

/** What a source mapper (Phases 4–6) or the manual entry form (Phase 11) provides. */
export interface PublicationInput {
  source: PublicationSource;
  externalId: string;
  title: string;
  dois?: ReadonlyArray<string | null | undefined>;
  year?: number | null;
  venue?: string | null;
  typeFamily: TypeFamily;
  authorNamesDisplay?: string | null;
  rawMetadata?: unknown;
}

export class NormalizationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NormalizationError';
  }
}

const MIN_YEAR = 1000;
const MAX_YEAR = 2100;

function cleanText(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const cleaned = value.replace(/\\[nrt]/g, ' ').replace(/\s+/g, ' ').trim();
  return cleaned.length > 0 ? cleaned : null;
}

/**
 * Builds a NormalizedPublication. Throws NormalizationError for records that cannot be
 * matched safely (no usable title or external ID); callers skip such records with a warning.
 */
export function buildNormalizedPublication(input: PublicationInput): NormalizedPublication {
  const externalId = input.externalId?.trim();
  if (!externalId) throw new NormalizationError('Record has no external ID');

  const title = cleanText(input.title);
  const normalizedTitle = normalizeTitle(title);
  if (!title || !normalizedTitle) {
    throw new NormalizationError(`Record ${input.source}:${externalId} has no usable title`);
  }

  const year =
    typeof input.year === 'number' && Number.isInteger(input.year) && input.year >= MIN_YEAR && input.year <= MAX_YEAR
      ? input.year
      : null;

  return {
    source: input.source,
    externalId,
    title,
    normalizedTitle,
    dois: normalizeDois(input.dois ?? []),
    year,
    venue: cleanText(input.venue),
    typeFamily: input.typeFamily,
    isPreprint: input.typeFamily === 'PREPRINT',
    authorNamesDisplay: cleanText(input.authorNamesDisplay),
    rawMetadata: input.rawMetadata === undefined ? null : stripExcludedContent(input.rawMetadata),
  };
}
