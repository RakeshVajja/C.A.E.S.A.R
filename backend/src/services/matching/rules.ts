import type { TypeFamily } from '@prisma/client';
import type { NormalizedPublication } from '../normalization/normalizedPublication';
import { isGenericOrShortTitle } from './titleEligibility';

/**
 * Pure matching rules (Project_plan.md §8). No database access, so every rule is unit-tested.
 */

/** What the rules need to know about an existing canonical publication. */
export interface PublicationSnapshot {
  id: string;
  year: number | null;
  typeFamily: TypeFamily;
  /** Canonical DOI plus the DOIs of all its source records. */
  dois: readonly string[];
  /** Canonical normalized title plus those of all its source records. */
  normalizedTitles: readonly string[];
}

export type DoiEvaluation = { kind: 'match' } | { kind: 'contradiction'; reason: string };
export type TitleEvaluation = { kind: 'merge' } | { kind: 'blocked'; reasons: string[] };

export const YEAR_TOLERANCE = 1;

/**
 * Two normalized titles are related when they are equal or one appears in the other as a
 * whole-word sequence (e.g. a title with and without its subtitle). No similarity threshold.
 */
export function titlesRelated(a: string, b: string): boolean {
  if (!a || !b) return false;
  return a === b || ` ${a} `.includes(` ${b} `) || ` ${b} `.includes(` ${a} `);
}

function isPreprintFamily(typeFamily: TypeFamily): boolean {
  return typeFamily === 'PREPRINT';
}

/**
 * Rule 2 contradiction checks (decision log #22). A shared DOI is strong evidence, so only
 * two contradictions block it:
 *  - preprint vs published: a preprint and a published version never share one canonical record;
 *  - unrelated titles: no title of the publication is related to the incoming title, which
 *    indicates a wrong DOI (common in self-reported ORCID data).
 * Type-family and year differences do not block a DOI match: source type labels and years are
 * unreliable (e.g. OpenAlex labels conference papers "article"), while the DOI is not.
 */
export function evaluateDoiMatch(incoming: NormalizedPublication, publication: PublicationSnapshot): DoiEvaluation {
  if (incoming.isPreprint !== isPreprintFamily(publication.typeFamily)) {
    return {
      kind: 'contradiction',
      reason: `same DOI but preprint vs published (${incoming.typeFamily} vs ${publication.typeFamily})`,
    };
  }
  if (!publication.normalizedTitles.some((title) => titlesRelated(incoming.normalizedTitle, title))) {
    return { kind: 'contradiction', reason: 'same DOI but unrelated titles (possible incorrect DOI)' };
  }
  return { kind: 'match' };
}

/**
 * Rule 3 for a publication whose normalized title exactly equals the incoming one.
 * Auto-merge only when every condition holds; otherwise every blocking reason is reported.
 */
export function evaluateTitleMatch(incoming: NormalizedPublication, publication: PublicationSnapshot): TitleEvaluation {
  const reasons: string[] = [];

  if (isGenericOrShortTitle(incoming.normalizedTitle)) {
    reasons.push('generic or too-short title');
  }

  if (incoming.year === null || publication.year === null) {
    reasons.push('year unknown');
  } else if (Math.abs(incoming.year - publication.year) > YEAR_TOLERANCE) {
    reasons.push(`years differ by more than ${YEAR_TOLERANCE} (${incoming.year} vs ${publication.year})`);
  }

  if (incoming.isPreprint !== isPreprintFamily(publication.typeFamily)) {
    reasons.push('preprint vs published');
  } else if (incoming.typeFamily === 'OTHER' || publication.typeFamily === 'OTHER') {
    reasons.push('type family unknown (OTHER)');
  } else if (incoming.typeFamily !== publication.typeFamily) {
    reasons.push(`incompatible type families (${incoming.typeFamily} vs ${publication.typeFamily})`);
  }

  if (
    incoming.dois.length > 0 &&
    publication.dois.length > 0 &&
    !incoming.dois.some((doi) => publication.dois.includes(doi))
  ) {
    reasons.push('different DOIs');
  }

  return reasons.length === 0 ? { kind: 'merge' } : { kind: 'blocked', reasons };
}
