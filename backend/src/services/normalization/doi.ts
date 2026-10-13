/**
 * DOI normalization (Project_plan.md §7.1). The single shared implementation used by
 * every source mapper, manual entry and admin edit.
 *
 * Returns the normalized DOI, or null when the value is not a valid DOI or contains U+0000
 * (the raw value then only survives in raw_metadata).
 */
const DOI_PREFIXES = /^(?:doi:\s*|https?:\/\/(?:dx\.)?doi\.org\/)/i;
const TRAILING_PUNCTUATION = /[.,;)]+$/;
const VALID_DOI = /^10\.\d{4,9}\/\S+$/;

export function normalizeDoi(value: string | null | undefined): string | null {
  // A value containing U+0000 is not a usable DOI (decision #52); cleaning it could invent a match.
  if (typeof value !== 'string' || value.includes('\u0000')) return null;

  // 1. Trim.  2. Remove known prefixes.
  let doi = value.trim().replace(DOI_PREFIXES, '');

  // 3. URL-decode (a malformed escape sequence leaves the value as it is).
  try {
    doi = decodeURIComponent(doi);
  } catch {
    // keep undecoded value
  }

  // 4. Lowercase.  5. Remove trailing punctuation.
  doi = doi.trim().toLowerCase().replace(TRAILING_PUNCTUATION, '');

  // 6. Validate.
  return VALID_DOI.test(doi) ? doi : null;
}

/** Normalizes a list of DOIs, dropping invalid values and duplicates while keeping order. */
export function normalizeDois(values: ReadonlyArray<string | null | undefined>): string[] {
  const result: string[] = [];
  for (const value of values) {
    const doi = normalizeDoi(value);
    if (doi && !result.includes(doi)) result.push(doi);
  }
  return result;
}
