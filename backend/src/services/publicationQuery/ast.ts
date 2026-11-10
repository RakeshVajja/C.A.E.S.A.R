import { z } from 'zod';
import { HttpError } from '../../utils/httpError';
import { FIELDS, FieldId, operatorSpec, Role } from './fields';

/**
 * The structured publication query (Project_plan.md §24.3, decision #154). A query is a link
 * scope (administrator only; the professor's scope is fixed by the server, §24.4), an optional
 * AND/OR tree of publication-level conditions, a sort key and a page. Everything is validated
 * strictly: unknown keys are refused, fields and operators come from the role's whitelist
 * (fields.ts), values are typed per operator, and the size limits below bound the work a query can
 * cause. The client never sends SQL or Prisma fragments; the same validation applies whether a
 * query was built in the page or decoded from its URL (D11).
 */

export const LIMITS = {
  /** Children per group (§24.3). */
  groupChildren: 20,
  /** Group nesting: the root group is level 1 (§24.3). */
  depth: 3,
  /** Conditions in the whole tree (§24.3). */
  conditions: 25,
  /** Selected professors after removing duplicates (D12). */
  professors: 50,
  pageDefault: 25,
  pageMax: 100,
  offsetMax: 1_000_000,
} as const;

export const SORT_KEYS = ['year', 'title', 'addedOn', 'scopusCitations'] as const;
export type SortKey = (typeof SORT_KEYS)[number];

export interface Condition {
  field: FieldId;
  operator: string;
  value?: unknown;
}
export interface Group {
  combinator: 'AND' | 'OR';
  children: (Condition | Group)[];
}

export const LINK_MODES = ['ANY_PROFESSOR', 'SELECTED', 'NO_LINK', 'ALL_PUBLICATIONS'] as const;
export type LinkMode = (typeof LINK_MODES)[number];
const STATUSES = ['APPROVED', 'PENDING', 'REJECTED'] as const;
const ORIGINS = ['DISCOVERED', 'MANUAL', 'ADMIN'] as const;

export interface LinkScope {
  mode: LinkMode;
  statuses: (typeof STATUSES)[number][];
  origins?: (typeof ORIGINS)[number][];
  decidedOn?: { after?: string; before?: string };
  professors?: string[];
  match?: 'ANY' | 'ALL';
}

export interface ProfessorQuery {
  root?: Group;
  sort: SortKey;
  limit: number;
  offset: number;
}
export interface AdminQuery extends ProfessorQuery {
  link: LinkScope;
}

export const isGroup = (node: Condition | Group): node is Group => 'combinator' in node;

const isoDate = z.iso.date();
const uniqueList = <T extends z.ZodType>(item: T, max: number) =>
  z
    .array(item)
    .min(1)
    .max(max)
    .refine((list) => new Set(list).size === list.length, 'Values must not repeat');

const conditionSchema = z.strictObject({
  field: z.string(),
  operator: z.string(),
  value: z.unknown().optional(),
});

type Node = z.infer<typeof conditionSchema> | { combinator: 'AND' | 'OR'; children: Node[] };
const nodeSchema: z.ZodType<Node> = z.lazy(() =>
  z.union([
    z.strictObject({ combinator: z.enum(['AND', 'OR']), children: z.array(nodeSchema).min(1).max(LIMITS.groupChildren) }),
    conditionSchema,
  ]),
);
const groupSchema = z.strictObject({ combinator: z.enum(['AND', 'OR']), children: z.array(nodeSchema).min(1).max(LIMITS.groupChildren) });

const paging = {
  sort: z.enum(SORT_KEYS).default('year'),
  limit: z.coerce.number().int().min(1).max(LIMITS.pageMax).default(LIMITS.pageDefault),
  offset: z.coerce.number().int().min(0).max(LIMITS.offsetMax).default(0),
};

const linkSchema = z
  .strictObject({
    mode: z.enum(LINK_MODES),
    statuses: uniqueList(z.enum(STATUSES), 3).default(['APPROVED']),
    origins: uniqueList(z.enum(ORIGINS), 3).optional(),
    decidedOn: z
      .strictObject({ after: isoDate.optional(), before: isoDate.optional() })
      .refine((d) => d.after !== undefined || d.before !== undefined, 'Give a date after which, before which, or both')
      .optional(),
    professors: z.array(z.uuid()).min(1).max(500).optional(),
    match: z.enum(['ANY', 'ALL']).optional(),
  })
  .superRefine((link, ctx) => {
    if (link.mode === 'SELECTED') {
      if (!link.professors) ctx.addIssue({ code: 'custom', path: ['professors'], message: 'Select at least one professor' });
      else if (new Set(link.professors.map((p) => p.toLowerCase())).size > LIMITS.professors) {
        ctx.addIssue({ code: 'custom', path: ['professors'], message: `Select at most ${LIMITS.professors} professors` });
      }
    } else {
      if (link.professors) ctx.addIssue({ code: 'custom', path: ['professors'], message: 'Professors are selected only in the SELECTED mode' });
      if (link.match) ctx.addIssue({ code: 'custom', path: ['match'], message: 'ANY / ALL applies only in the SELECTED mode' });
    }
    if (link.decidedOn?.after && link.decidedOn.before && link.decidedOn.after > link.decidedOn.before) {
      ctx.addIssue({ code: 'custom', path: ['decidedOn'], message: 'The start date must not be after the end date' });
    }
  })
  .transform(
    (link): LinkScope => ({
      ...link,
      // Duplicates removed, order of first appearance kept (§24.5).
      ...(link.professors && { professors: [...new Set(link.professors.map((p) => p.toLowerCase()))] }),
      ...(link.mode === 'SELECTED' && { match: link.match ?? 'ANY' }),
    }),
  );

const professorSchema = z.strictObject({ root: groupSchema.optional(), ...paging });
const adminSchema = z.strictObject({ link: linkSchema, root: groupSchema.optional(), ...paging });

/**
 * Validates a query for a role: the shape (zod), then every condition against the role's field
 * whitelist and the operator's value schema, then the tree limits. Errors are 400
 * VALIDATION_ERROR with paths and rules only (never the submitted values).
 */
export function parseQuery(role: 'PROFESSOR', body: unknown): ProfessorQuery;
export function parseQuery(role: 'ADMIN', body: unknown): AdminQuery;
export function parseQuery(role: Role, body: unknown): ProfessorQuery | AdminQuery {
  const parsed = (role === 'ADMIN' ? adminSchema : professorSchema).safeParse(body);
  if (!parsed.success) throw invalid(parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })));
  const query = parsed.data as ProfessorQuery | AdminQuery;
  const issues: { path: string; message: string }[] = [];
  if (query.root) {
    let conditions = 0;
    const visit = (node: Condition | Group, path: string, depth: number): Condition | Group => {
      if (isGroup(node)) {
        if (depth > LIMITS.depth) issues.push({ path, message: `Groups can be nested at most ${LIMITS.depth} levels deep` });
        return { combinator: node.combinator, children: node.children.map((child, i) => visit(child, `${path}.children.${i}`, depth + 1)) };
      }
      conditions++;
      return validateCondition(role, node, path, issues);
    };
    query.root = visit(query.root, 'root', 1) as Group;
    if (conditions > LIMITS.conditions) issues.push({ path: 'root', message: `A query can have at most ${LIMITS.conditions} conditions` });
  }
  if (issues.length) throw invalid(issues);
  return query;
}

/** Checks one condition against the role's whitelist; returns it with its value normalized. */
function validateCondition(role: Role, node: Condition, path: string, issues: { path: string; message: string }[]): Condition {
  const field = FIELDS[node.field as FieldId];
  if (!field || !field.roles.includes(role)) {
    issues.push({ path: `${path}.field`, message: 'Unknown field, or a field not available to this role' });
    return node;
  }
  const spec = operatorSpec(node.field as FieldId, node.operator);
  if (!spec) {
    issues.push({ path: `${path}.operator`, message: `Operator not allowed for ${node.field}` });
    return node;
  }
  if (!spec.value) {
    if (node.value !== undefined) issues.push({ path: `${path}.value`, message: `${node.operator} takes no value` });
    return { field: node.field, operator: node.operator };
  }
  const value = spec.value.safeParse(node.value);
  if (!value.success) {
    for (const issue of value.error.issues) issues.push({ path: [`${path}.value`, ...issue.path].join('.'), message: issue.message });
    return node;
  }
  return { field: node.field, operator: node.operator, value: value.data };
}

function invalid(details: { path: string; message: string }[]) {
  return new HttpError(400, 'VALIDATION_ERROR', 'Invalid publication query', details);
}

/** Every condition of a tree, depth first. */
export function conditionsOf(root: Group | undefined): Condition[] {
  if (!root) return [];
  return root.children.flatMap((child) => (isGroup(child) ? conditionsOf(child) : [child]));
}
