/**
 * The single shared ISSN normalizer (Project_plan.md §6.5, §22.5; stage 15.6): every ISSN stored
 * for journal linking — on source records and on journals — goes through it.
 *
 * Accepts "1234-5679", "12345679", "1234 5679", a lower-case check character "x", typographic
 * dashes, and the "ISSN ", "issn:" and "urn:issn:" prefixes; returns "NNNN-NNNC" (upper-case X), or
 * null when the value is not an ISSN or its check character is wrong (ISO 3297: weights 8…2,
 * modulus 11).
 */
export function normalizeIssn(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const compact = value
    .trim()
    .replace(/^(?:urn:)?issn(?::|\s)\s*/i, '')
    .replace(/[\s\u2010-\u2015-]/g, '')
    .toUpperCase();
  if (!/^\d{7}[\dX]$/.test(compact)) return null;
  if (issnCheckCharacter(compact.slice(0, 7)) !== compact[7]) return null;
  return `${compact.slice(0, 4)}-${compact.slice(4)}`;
}

/** Normalized, de-duplicated and sorted ISSNs; invalid values are dropped. */
export function normalizeIssns(values: ReadonlyArray<string | null | undefined>): string[] {
  return [...new Set(values.map(normalizeIssn).filter((issn): issn is string => issn !== null))].sort();
}

function issnCheckCharacter(digits: string): string {
  const sum = [...digits].reduce((total, digit, index) => total + Number(digit) * (8 - index), 0);
  const check = (11 - (sum % 11)) % 11;
  return check === 10 ? 'X' : String(check);
}
