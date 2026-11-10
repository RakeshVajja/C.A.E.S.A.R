import { HttpError } from '../../utils/httpError';
import type { Condition, Group, LinkScope } from './ast';
import type { Role } from './fields';

/**
 * Predefined filters (Project_plan.md §24.5; decisions D3, D6, D7, D8). A preset is not a separate
 * filtering system: it produces an ordinary, complete, editable query (link scope + condition tree)
 * that goes through the same validation, authorization and compilation as any other query.
 *
 * Administrator queries start from the department analytics population (D2, D3) — link scope
 * *Any professor, APPROVED* and the visible, removable conditions `publicationStatus in [ACTIVE]`
 * and `type notIn [PREPRINT]` — and every admin preset adds its own condition to those defaults,
 * dropping only a default it contradicts (*Preprints*, *Suppressed publications*). Professors'
 * presets add only their own condition: their scope is fixed by the server (D1).
 */

export type PresetParameter = 'year' | 'text' | 'professors';

interface PresetDefinition {
  id: string;
  label: string;
  roles: readonly Role[];
  parameter?: PresetParameter;
  /** Needs Scopus citation data (disabled and refused while it is unavailable, D6). */
  requiresScopus?: boolean;
  conditions?: (param: unknown, year: number) => Condition[];
  /** Administrator link scope set by the preset (default: Any professor, APPROVED). */
  link?: (param: unknown) => LinkScope;
  /** D3 defaults this preset contradicts, so drops. */
  drops?: readonly ('active' | 'nonPreprint')[];
}

const BOTH: readonly Role[] = ['PROFESSOR', 'ADMIN'];
const ADMIN: readonly Role[] = ['ADMIN'];

export const DEFAULT_LINK: LinkScope = { mode: 'ANY_PROFESSOR', statuses: ['APPROVED'] };
const ACTIVE_DEFAULT: Condition = { field: 'publicationStatus', operator: 'in', value: ['ACTIVE'] };
const NON_PREPRINT_DEFAULT: Condition = { field: 'type', operator: 'notIn', value: ['PREPRINT'] };

const PRESETS: readonly PresetDefinition[] = [
  { id: 'recent', label: 'Recent (last five years)', roles: BOTH, conditions: (_p, y) => [{ field: 'year', operator: 'between', value: [y - 4, y] }] },
  { id: 'journalArticles', label: 'Journal articles', roles: BOTH, conditions: () => [{ field: 'type', operator: 'in', value: ['JOURNAL'] }] },
  { id: 'conferencePapers', label: 'Conference papers', roles: BOTH, conditions: () => [{ field: 'type', operator: 'in', value: ['CONFERENCE'] }] },
  { id: 'booksAndChapters', label: 'Books and chapters', roles: BOTH, conditions: () => [{ field: 'type', operator: 'in', value: ['BOOK', 'BOOK_CHAPTER'] }] },
  { id: 'preprints', label: 'Preprints', roles: BOTH, drops: ['nonPreprint'], conditions: () => [{ field: 'type', operator: 'in', value: ['PREPRINT'] }] },
  { id: 'publishedInYear', label: 'Published in year …', roles: BOTH, parameter: 'year', conditions: (p) => [{ field: 'year', operator: 'eq', value: p }] },
  { id: 'withDoi', label: 'With DOI', roles: BOTH, conditions: () => [{ field: 'doi', operator: 'isPresent' }] },
  { id: 'withoutDoi', label: 'Without DOI', roles: BOTH, conditions: () => [{ field: 'doi', operator: 'isAbsent' }] },
  { id: 'venueContains', label: 'Venue contains …', roles: BOTH, parameter: 'text', conditions: (p) => [{ field: 'venue', operator: 'contains', value: p }] },
  { id: 'reportedByScopus', label: 'Reported by Scopus', roles: BOTH, conditions: () => [{ field: 'source', operator: 'anyOf', value: ['SCOPUS'] }] },
  { id: 'manualEntries', label: 'Manual entries', roles: BOTH, conditions: () => [{ field: 'source', operator: 'anyOf', value: ['MANUAL'] }] },
  {
    id: 'citedInScopus',
    label: 'Cited in Scopus (10 or more)',
    roles: BOTH,
    requiresScopus: true,
    conditions: () => [{ field: 'scopusCitations', operator: 'gte', value: 10 }],
  },
  { id: 'pendingVerification', label: 'Pending verification', roles: ADMIN, link: () => ({ mode: 'ANY_PROFESSOR', statuses: ['PENDING'] }) },
  { id: 'rejectedLinks', label: 'Rejected links', roles: ADMIN, link: () => ({ mode: 'ANY_PROFESSOR', statuses: ['REJECTED'] }) },
  {
    id: 'jointPublications',
    label: 'Joint publications of the selected professors',
    roles: ADMIN,
    parameter: 'professors',
    link: (p) => ({ mode: 'SELECTED', statuses: ['APPROVED'], professors: p as string[], match: 'ALL' }),
  },
  { id: 'coAuthored', label: 'Co-authored by department professors', roles: ADMIN, conditions: () => [{ field: 'linkedProfessors', operator: 'gte', value: 2 }] },
  { id: 'withoutProfessorLink', label: 'Without any professor link', roles: ADMIN, link: () => ({ mode: 'NO_LINK', statuses: ['APPROVED'] }) },
  {
    id: 'suppressed',
    label: 'Suppressed publications',
    roles: ADMIN,
    drops: ['active'],
    conditions: () => [{ field: 'publicationStatus', operator: 'in', value: ['SUPPRESSED'] }],
  },
  { id: 'curated', label: 'Curated publications', roles: ADMIN, conditions: () => [{ field: 'curated', operator: 'is', value: true }] },
];

/** The current year in the server's configured time zone (D7: Recent = this year and the four before). */
export function currentYear(now: Date, timeZone: string): number {
  return Number(new Intl.DateTimeFormat('en', { timeZone, year: 'numeric' }).format(now));
}

/** The administrator's initial query (D2, D3): visible, removable defaults. */
export function defaultAdminQuery(): { link: LinkScope; root: Group } {
  return { link: { ...DEFAULT_LINK }, root: { combinator: 'AND', children: [{ ...ACTIVE_DEFAULT }, { ...NON_PREPRINT_DEFAULT }] } };
}

/** The presets a role may apply (§24.8 `GET …/presets`). */
export function listPresets(role: Role, scopusAvailable: boolean) {
  return PRESETS.filter((p) => p.roles.includes(role)).map((p) => ({
    id: p.id,
    label: p.label,
    ...(p.parameter && { parameter: p.parameter }),
    available: !p.requiresScopus || scopusAvailable,
    ...(p.requiresScopus && !scopusAvailable && { unavailableReason: 'Scopus citation data is unavailable' }),
  }));
}

/**
 * The complete query a preset produces for a role. Parameters are only placed into conditions;
 * the resulting query is validated like any other before it runs.
 */
export function buildPreset(role: 'PROFESSOR', id: string, param: unknown, now: Date, timeZone: string): { root: Group };
export function buildPreset(role: 'ADMIN', id: string, param: unknown, now: Date, timeZone: string): { link: LinkScope; root: Group };
export function buildPreset(role: Role, id: string, param: unknown, now: Date, timeZone: string): { link?: LinkScope; root: Group } {
  const preset = PRESETS.find((p) => p.id === id && p.roles.includes(role));
  if (!preset) throw new HttpError(404, 'PRESET_NOT_FOUND', 'Unknown predefined filter');
  if (preset.parameter && (param === undefined || param === null || param === '')) throw new HttpError(400, 'VALIDATION_ERROR', 'This filter needs a value');
  const own = preset.conditions?.(param, currentYear(now, timeZone)) ?? [];
  if (role === 'PROFESSOR') return { root: { combinator: 'AND', children: own } };
  const defaults = [
    ...(preset.drops?.includes('active') ? [] : [{ ...ACTIVE_DEFAULT }]),
    ...(preset.drops?.includes('nonPreprint') ? [] : [{ ...NON_PREPRINT_DEFAULT }]),
  ];
  return { link: preset.link?.(param) ?? { ...DEFAULT_LINK }, root: { combinator: 'AND', children: [...defaults, ...own] } };
}
