/**
 * raw_metadata keeps the source payload for provenance, minus content the project must
 * never store (Project_plan.md §3.2, §6.5): abstracts, reference lists and full text.
 * Applied defensively to every record, whatever its source.
 */
const EXCLUDED_KEYS = new Set([
  'abstract',
  'abstract_inverted_index',
  'short-description', // ORCID abstract field
  'referenced_works',
  'references',
  'fulltext',
  'full_text',
  'content_urls',
]);

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

export function stripExcludedContent(value: unknown): JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (Array.isArray(value)) return value.map(stripExcludedContent);
  if (typeof value === 'object') {
    const result: { [key: string]: JsonValue } = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (EXCLUDED_KEYS.has(key.toLowerCase()) || child === undefined) continue;
      result[key] = stripExcludedContent(child);
    }
    return result;
  }
  return null; // functions, symbols, bigint: not representable as JSON
}
