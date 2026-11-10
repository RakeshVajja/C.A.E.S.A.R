import { z } from 'zod';
import { normalizeDoi } from '../normalization/doi';
import { normalizeIssn } from '../normalization/issn';
import { normalizeTitle } from '../normalization/title';

/**
 * The field whitelist of publication queries (Project_plan.md §24.3; decisions #154, D1, D6, D9,
 * D10). Each field lists the roles that may use it and, per operator, the schema of its value (no
 * schema = the operator takes no value). Relationship criteria are not fields: they belong to the
 * administrator's link scope (§24.5). Unsupported data (keywords, structured authors, abstracts,
 * Web of Science Times Cited, JCR metrics) has no field (§24.2).
 */

export type Role = 'PROFESSOR' | 'ADMIN';
const BOTH: readonly Role[] = ['PROFESSOR', 'ADMIN'];
const ADMIN: readonly Role[] = ['ADMIN'];

const TYPES = ['PREPRINT', 'CONFERENCE', 'JOURNAL', 'BOOK_CHAPTER', 'BOOK', 'OTHER'] as const;
const SOURCES = ['OPENALEX', 'DBLP', 'ORCID', 'SCOPUS', 'WOS', 'MANUAL'] as const;

const unique = <T extends z.ZodType>(item: T, max: number) =>
  z
    .array(item)
    .min(1)
    .max(max)
    .refine((list) => new Set(list).size === list.length, 'Values must not repeat');
const ordered = <T extends z.ZodType<number | string>>(item: T) =>
  z.tuple([item, item]).refine((pair) => (pair[0] as number | string) <= (pair[1] as number | string), 'The first value must not be greater than the second');

const text = z.string().trim().min(1).max(300);
const year = z.number().int().min(1000).max(2100);
const count = z.number().int().min(0).max(1_000_000_000);
const date = z.iso.date();

/** Value kinds, for the builder's inputs (§24.8). */
export type ValueKind = 'none' | 'year' | 'yearRange' | 'types' | 'text' | 'sources' | 'date' | 'dateRange' | 'count' | 'countRange' | 'statuses' | 'boolean';

interface OperatorSpec {
  value?: z.ZodType;
  kind: ValueKind;
}
interface FieldSpec {
  label: string;
  roles: readonly Role[];
  operators: Record<string, OperatorSpec>;
  /** Enumerated values the builder offers. */
  options?: readonly string[];
}

const none: OperatorSpec = { kind: 'none' };

export const FIELDS = {
  year: {
    label: 'Year',
    roles: BOTH,
    operators: {
      eq: { value: year, kind: 'year' },
      neq: { value: year, kind: 'year' },
      gt: { value: year, kind: 'year' },
      gte: { value: year, kind: 'year' },
      lt: { value: year, kind: 'year' },
      lte: { value: year, kind: 'year' },
      between: { value: ordered(year), kind: 'yearRange' },
      isEmpty: none,
      isNotEmpty: none,
    },
  },
  type: {
    label: 'Type',
    roles: BOTH,
    options: TYPES,
    operators: { in: { value: unique(z.enum(TYPES), TYPES.length), kind: 'types' }, notIn: { value: unique(z.enum(TYPES), TYPES.length), kind: 'types' } },
  },
  title: {
    label: 'Title',
    roles: BOTH,
    operators: Object.fromEntries(
      ['contains', 'notContains'].map((op) => [op, { value: text.refine((t) => normalizeTitle(t) !== '', 'The text has no searchable characters'), kind: 'text' as const }]),
    ),
  },
  venue: {
    label: 'Venue (journal or conference)',
    roles: BOTH,
    operators: { contains: { value: text, kind: 'text' }, equals: { value: text, kind: 'text' }, isEmpty: none, isNotEmpty: none },
  },
  authors: { label: 'Authors', roles: BOTH, operators: { contains: { value: text, kind: 'text' } } },
  doi: {
    label: 'DOI',
    roles: BOTH,
    operators: {
      isPresent: none,
      isAbsent: none,
      equals: {
        value: text.transform((t, ctx) => normalizeDoi(t) ?? (ctx.addIssue({ code: 'custom', message: 'Not a valid DOI' }), z.NEVER)),
        kind: 'text',
      },
      startsWith: { value: text.transform((t) => t.toLowerCase()), kind: 'text' },
    },
  },
  source: {
    label: 'Reported by',
    roles: BOTH,
    options: SOURCES,
    operators: { anyOf: { value: unique(z.enum(SOURCES), SOURCES.length), kind: 'sources' }, noneOf: { value: unique(z.enum(SOURCES), SOURCES.length), kind: 'sources' } },
  },
  issn: {
    label: 'ISSN',
    roles: BOTH,
    operators: {
      equals: {
        value: text.transform((t, ctx) => normalizeIssn(t) ?? (ctx.addIssue({ code: 'custom', message: 'Not a valid ISSN' }), z.NEVER)),
        kind: 'text',
      },
    },
  },
  addedOn: {
    label: 'Added on',
    roles: BOTH,
    operators: { before: { value: date, kind: 'date' }, after: { value: date, kind: 'date' }, between: { value: ordered(date), kind: 'dateRange' } },
  },
  scopusCitations: {
    label: 'Scopus citations',
    roles: BOTH,
    operators: {
      gt: { value: count, kind: 'count' },
      gte: { value: count, kind: 'count' },
      lt: { value: count, kind: 'count' },
      lte: { value: count, kind: 'count' },
      between: { value: ordered(count), kind: 'countRange' },
      hasCount: none,
      noCount: none,
    },
  },
  publicationStatus: {
    label: 'Publication status',
    roles: ADMIN,
    options: ['ACTIVE', 'SUPPRESSED'],
    operators: { in: { value: unique(z.enum(['ACTIVE', 'SUPPRESSED']), 2), kind: 'statuses' } },
  },
  curated: { label: 'Curated', roles: ADMIN, operators: { is: { value: z.boolean(), kind: 'boolean' } } },
  linkedProfessors: {
    label: 'Department professors linked',
    roles: ADMIN,
    operators: { gte: { value: z.number().int().min(0).max(1000), kind: 'count' }, eq: { value: z.number().int().min(0).max(1000), kind: 'count' } },
  },
} satisfies Record<string, FieldSpec>;

export type FieldId = keyof typeof FIELDS;
export const FIELD_IDS = Object.keys(FIELDS) as FieldId[];

/** Fields whose evaluation needs Scopus citation data (refused while it is unavailable, D6). */
export const CITATION_FIELDS: ReadonlySet<FieldId> = new Set(['scopusCitations']);

export function operatorSpec(field: FieldId, operator: string): OperatorSpec | undefined {
  const operators = (FIELDS[field] as FieldSpec).operators;
  return Object.prototype.hasOwnProperty.call(operators, operator) ? operators[operator] : undefined;
}

/** The fields a role may use, as the builder needs them (§24.8 `GET …/fields`). */
export function describeFields(role: Role, scopusAvailable: boolean) {
  return FIELD_IDS.filter((id) => FIELDS[id].roles.includes(role)).map((id) => {
    const spec = FIELDS[id] as FieldSpec;
    const unavailable = CITATION_FIELDS.has(id) && !scopusAvailable;
    return {
      id,
      label: spec.label,
      ...(spec.options && { options: spec.options }),
      operators: Object.entries(spec.operators).map(([operator, op]) => ({ operator, value: op.kind })),
      available: !unavailable,
      ...(unavailable && { unavailableReason: 'Scopus citation data is unavailable' }),
    };
  });
}
