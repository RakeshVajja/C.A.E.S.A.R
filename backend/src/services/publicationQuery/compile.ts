import { Prisma, PublicationSource, PublicationStatus, TypeFamily } from '@prisma/client';
import { normalizeTitle } from '../normalization/title';
import { Condition, Group, isGroup } from './ast';
import { CitationCount, idsWithCount } from './citations';
import { utcDayStart, utcNextDayStart } from './dates';

/**
 * Compiles a validated condition tree into one Prisma publication filter (Project_plan.md §24.3).
 * Every value has already been validated and normalized by `parseQuery`; nothing here interprets
 * client text as SQL. Conditions that Prisma cannot express are resolved beforehand into ID sets:
 * Scopus citation counts (`citations`) and the number of professors with a qualifying link per
 * publication (`linkedCounts`, within the link scope's qualifying rule).
 *
 * Unknown values never match a comparison: a publication without a year is neither > nor ≠ a
 * year (use `isEmpty`), and one without a Scopus count never matches a numeric citation condition
 * (only `noCount`, §24.4). Dates are UTC calendar days (dates.ts).
 */

export interface CompileContext {
  citations?: Map<string, CitationCount>;
  linkedCounts?: Map<string, number>;
}

export function compileTree(root: Group | undefined, ctx: CompileContext): Prisma.PublicationWhereInput {
  return root ? compileNode(root, ctx) : {};
}

function compileNode(node: Condition | Group, ctx: CompileContext): Prisma.PublicationWhereInput {
  if (isGroup(node)) {
    const parts = node.children.map((child) => compileNode(child, ctx));
    return node.combinator === 'AND' ? { AND: parts } : { OR: parts };
  }
  return compileCondition(node, ctx);
}

const notEmpty = (column: 'venue'): Prisma.PublicationWhereInput => ({ AND: [{ [column]: { not: null } }, { NOT: { [column]: '' } }] });

function compileCondition(c: Condition, ctx: CompileContext): Prisma.PublicationWhereInput {
  const v = c.value as never;
  switch (c.field) {
    case 'year':
      switch (c.operator) {
        case 'eq': return { year: v };
        case 'neq': return { AND: [{ year: { not: null } }, { NOT: { year: v } }] };
        case 'gt': return { year: { gt: v } };
        case 'gte': return { year: { gte: v } };
        case 'lt': return { year: { lt: v } };
        case 'lte': return { year: { lte: v } };
        case 'between': return { year: { gte: (v as number[])[0], lte: (v as number[])[1] } };
        case 'isEmpty': return { year: null };
        case 'isNotEmpty': return { year: { not: null } };
      }
      break;
    case 'type':
      return { typeFamily: c.operator === 'in' ? { in: v as TypeFamily[] } : { notIn: v as TypeFamily[] } };
    case 'title': {
      const match: Prisma.PublicationWhereInput = { normalizedTitle: { contains: normalizeTitle(v as string) } };
      return c.operator === 'contains' ? match : { NOT: match };
    }
    case 'venue':
      switch (c.operator) {
        case 'contains': return { venue: { contains: v as string, mode: 'insensitive' } };
        case 'equals': return { venue: { equals: v as string, mode: 'insensitive' } };
        case 'isEmpty': return { OR: [{ venue: null }, { venue: '' }] };
        case 'isNotEmpty': return notEmpty('venue');
      }
      break;
    case 'authors':
      return { authorNamesDisplay: { contains: v as string, mode: 'insensitive' } };
    case 'doi':
      switch (c.operator) {
        case 'isPresent': return { doi: { not: null } };
        case 'isAbsent': return { doi: null };
        case 'equals': return { doi: v as string };
        case 'startsWith': return { doi: { startsWith: v as string } };
      }
      break;
    case 'source': {
      const sources = { source: { in: v as PublicationSource[] } };
      return c.operator === 'anyOf' ? { sourceRecords: { some: sources } } : { sourceRecords: { none: sources } };
    }
    case 'issn':
      return { sourceRecords: { some: { issns: { has: v as string } } } };
    case 'addedOn':
      switch (c.operator) {
        case 'before': return { createdAt: { lt: utcDayStart(v) } };
        case 'after': return { createdAt: { gte: utcNextDayStart(v) } };
        case 'between': return { createdAt: { gte: utcDayStart((v as string[])[0]), lt: utcNextDayStart((v as string[])[1]) } };
      }
      break;
    case 'scopusCitations': {
      const counts = ctx.citations;
      if (!counts) throw new Error('Citation counts were not loaded for a citation condition');
      const n = v as number;
      switch (c.operator) {
        case 'hasCount': return { id: { in: [...counts.keys()] } };
        case 'noCount': return { id: { notIn: [...counts.keys()] } };
        case 'gt': return { id: { in: idsWithCount(counts, (x) => x > n) } };
        case 'gte': return { id: { in: idsWithCount(counts, (x) => x >= n) } };
        case 'lt': return { id: { in: idsWithCount(counts, (x) => x < n) } };
        case 'lte': return { id: { in: idsWithCount(counts, (x) => x <= n) } };
        case 'between': {
          const [lo, hi] = v as number[];
          return { id: { in: idsWithCount(counts, (x) => x >= lo && x <= hi) } };
        }
      }
      break;
    }
    case 'publicationStatus':
      return { status: { in: v as PublicationStatus[] } };
    case 'curated':
      return { isCurated: v as boolean };
    case 'linkedProfessors': {
      const counts = ctx.linkedCounts;
      if (!counts) throw new Error('Linked-professor counts were not loaded');
      const n = v as number;
      const withAtLeast = (k: number) => [...counts].filter(([, x]) => x >= k).map(([id]) => id);
      if (c.operator === 'gte') return n <= 0 ? {} : { id: { in: withAtLeast(n) } };
      return n === 0 ? { id: { notIn: withAtLeast(1) } } : { id: { in: [...counts].filter(([, x]) => x === n).map(([id]) => id) } };
    }
  }
  throw new Error(`Unhandled condition ${c.field} ${c.operator}`);
}
