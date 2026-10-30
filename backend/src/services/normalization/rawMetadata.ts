import { NUL, replaceNul } from './nul';

/**
 * raw_metadata keeps the source payload for provenance, minus content the project must
 * never store (Project_plan.md §3.2, §6.5): abstracts, reference lists and full text.
 * Applied defensively to every record, whatever its source.
 */
const EXCLUDED_KEYS = new Set([
  'abstract',
  'abstract_inverted_index',
  'short-description', // ORCID abstract field
  'dc:description', // Scopus abstract field (COMPLETE view; never requested, removed defensively)
  'referenced_works',
  'references',
  'fulltext',
  'full_text',
  'content_urls',
]);

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

/** Also replaces U+0000 in string values and keys (decision #52); see nulSafeKey for key collisions. */
export function stripExcludedContent(value: unknown): JsonValue {
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'string') return replaceNul(value);
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (Array.isArray(value)) return value.map(stripExcludedContent);
  if (typeof value === 'object') {
    const kept = Object.entries(value as Record<string, unknown>).filter(
      ([key, child]) => !EXCLUDED_KEYS.has(key.toLowerCase()) && child !== undefined,
    );
    const result: { [key: string]: JsonValue } = {};
    // Keys without U+0000 keep their names; keys with it are added afterwards and never overwrite.
    for (const [key, child] of kept) if (!key.includes(NUL)) result[key] = stripExcludedContent(child);
    for (const [key, child] of kept) if (key.includes(NUL)) result[nulSafeKey(key, result)] = stripExcludedContent(child);
    return result;
  }
  return null; // functions, symbols, bigint: not representable as JSON
}

/**
 * The key with U+0000 replaced; if that name is already taken (e.g. both "a\u0000" and "a�"
 * exist), "#2", "#3", … is appended until it is free, so no value is silently overwritten.
 */
function nulSafeKey(key: string, taken: object): string {
  const base = replaceNul(key);
  let candidate = base;
  for (let n = 2; Object.hasOwn(taken, candidate); n++) candidate = `${base}#${n}`;
  return candidate;
}
