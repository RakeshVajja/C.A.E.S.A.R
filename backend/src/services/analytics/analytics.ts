import { Prisma, PrismaClient, PublicationSource, SyncRunStatus, TypeFamily } from '@prisma/client';
import { prisma as defaultClient } from '../../config/database';

/**
 * Administrator analytics (Project_plan.md §16; Phase 13, decisions #86–#89). Every figure is
 * computed from the stored rows on request; there are no analytics counters or caches.
 *
 * Default policy (§16, §10): a publication is *counted* when it is ACTIVE (not suppressed), not a
 * preprint, and has at least one APPROVED relationship (#86; professor activity is not a condition). OTHER is
 * counted (#87). Three kinds of figures are kept apart:
 *   - publications       distinct canonical publications (a co-authored paper counts once),
 *   - relationships      professor–publication links (a co-authored paper counts once per professor),
 *   - source records     provenance rows (one paper reported by three sources is three records).
 */

const SOURCE_ORDER: readonly PublicationSource[] = ['OPENALEX', 'DBLP', 'ORCID', 'MANUAL'];
const TYPE_ORDER: readonly TypeFamily[] = ['JOURNAL', 'CONFERENCE', 'BOOK_CHAPTER', 'BOOK', 'OTHER'];

/** Canonical publications that research analytics may count at all. */
const countablePublication = { status: 'ACTIVE', typeFamily: { not: 'PREPRINT' } } satisfies Prisma.PublicationWhereInput;

/** Relationships that make a publication count: APPROVED (of any professor, active or not). */
const approved = { status: 'APPROVED' } satisfies Prisma.ProfessorPublicationWhereInput;

/** Publications counted by the default policy. */
const countedPublications = {
  ...countablePublication,
  professors: { some: approved },
} satisfies Prisma.PublicationWhereInput;

const runSummarySelect = { id: true, trigger: true, status: true, startedAt: true, finishedAt: true } as const;

export async function overview(client: PrismaClient = defaultClient) {
  const [professorsTotal, professorsActive, uniquePublications, byType, pendingVerifications, lastSync, running] = await client.$transaction([
    client.professor.count(),
    client.professor.count({ where: { isActive: true } }),
    client.publication.count({ where: countedPublications }),
    client.publication.groupBy({ by: ['typeFamily'], where: countedPublications, _count: { _all: true }, orderBy: { typeFamily: 'asc' } }),
    // The outstanding verification backlog: every PENDING relationship to a non-suppressed
    // publication, whether or not the professor is active, preprints included (#88).
    client.professorPublication.count({ where: { status: 'PENDING', publication: { status: 'ACTIVE' } } }),
    client.syncRun.findFirst({ where: { status: { not: 'RUNNING' } }, select: runSummarySelect, orderBy: [{ startedAt: 'desc' }, { id: 'desc' }] }),
    client.syncRun.count({ where: { status: 'RUNNING' } }),
  ]);
  const typeCount = new Map(byType.map((row) => [row.typeFamily, countOf(row._count)]));
  return {
    professors: { total: professorsTotal, active: professorsActive },
    uniquePublications,
    uniquePublicationsByType: TYPE_ORDER.map((typeFamily) => ({ typeFamily, publications: typeCount.get(typeFamily) ?? 0 })),
    pendingVerifications,
    lastSync,
    syncRunning: running > 0,
  };
}

/**
 * Counted publications per professor (relationship counts: a paper shared by two professors
 * appears under both, so the rows can sum to more than `uniquePublications`). Every professor is
 * listed, with `isActive`; professors without any are listed with 0. Order: most publications
 * first, then name.
 */
export async function approvedPerProfessor(client: PrismaClient = defaultClient) {
  const [professors, counts] = await client.$transaction([
    client.professor.findMany({ select: { id: true, name: true, department: true, designation: true, isActive: true } }),
    client.professorPublication.groupBy({
      by: ['professorId'],
      where: { ...approved, publication: countablePublication },
      _count: { _all: true },
      orderBy: { professorId: 'asc' },
    }),
  ]);
  const byProfessor = new Map(counts.map((row) => [row.professorId, countOf(row._count)]));
  const rows = professors.map((p) => ({ ...p, approvedPublications: byProfessor.get(p.id) ?? 0 }));
  rows.sort((a, b) => b.approvedPublications - a.approvedPublications || a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  return { professors: rows };
}

/**
 * Counted publications per publication year, oldest first. Publications without a known year are
 * reported separately (`unknownYear`), never folded into a year; the rows plus `unknownYear` equal
 * `total`, which is the overview's `uniquePublications`.
 */
export async function publicationsByYear(client: PrismaClient = defaultClient) {
  const groups = await client.publication.groupBy({ by: ['year'], where: countedPublications, _count: { _all: true }, orderBy: { year: 'asc' } });
  const years = groups
    .filter((g): g is typeof g & { year: number } => g.year !== null)
    .map((g) => ({ year: g.year, publications: countOf(g._count) }))
    .sort((a, b) => a.year - b.year);
  const unknownYear = countOf(groups.find((g) => g.year === null)?._count);
  return { years, unknownYear, total: years.reduce((n, y) => n + y.publications, unknownYear) };
}

/**
 * Source records against unique canonical publications.
 *   counted: within the default policy — per source, its records attached to counted publications
 *            and how many counted publications it reports (a paper found by two sources counts for
 *            both, so the per-source publication figures can sum to more than `uniquePublications`).
 *   stored:  everything kept in the database (pending, rejected, preprint and suppressed included).
 */
export async function sourceStatistics(client: PrismaClient = defaultClient) {
  const [countedRecords, storedRecords, storedPublications, uniquePublications, ...perSource] = await client.$transaction([
    client.publicationSourceRecord.groupBy({ by: ['source'], where: { publication: countedPublications }, _count: { _all: true }, orderBy: { source: 'asc' } }),
    client.publicationSourceRecord.groupBy({ by: ['source'], _count: { _all: true }, orderBy: { source: 'asc' } }),
    client.publication.count(),
    client.publication.count({ where: countedPublications }),
    ...SOURCE_ORDER.map((source) => client.publication.count({ where: { ...countedPublications, sourceRecords: { some: { source } } } })),
  ]);
  const countedBySource = new Map(countedRecords.map((row) => [row.source, countOf(row._count)]));
  const storedBySource = new Map(storedRecords.map((row) => [row.source, countOf(row._count)]));
  const sum = (m: Map<PublicationSource, number>) => [...m.values()].reduce((n, v) => n + v, 0);
  return {
    counted: {
      sources: SOURCE_ORDER.map((source, i) => ({ source, sourceRecords: countedBySource.get(source) ?? 0, publications: perSource[i] })),
      sourceRecords: sum(countedBySource),
      uniquePublications,
    },
    stored: {
      sources: SOURCE_ORDER.map((source) => ({ source, sourceRecords: storedBySource.get(source) ?? 0 })),
      sourceRecords: sum(storedBySource),
      publications: storedPublications,
    },
  };
}

/**
 * Synchronization history from SyncRun/SyncTask (#89). Record figures are the stored run counters
 * (sums of their tasks) of finished runs; a RUNNING run is counted only under `runs.running`.
 * `recordsAdded` = new source records, `recordsUpdated` = existing source records seen again.
 */
export async function syncStatistics(client: PrismaClient = defaultClient) {
  const finished = { status: { not: 'RUNNING' } } satisfies Prisma.SyncRunWhereInput;
  const [runGroups, taskGroups, totals, lastRun, lastSuccessfulRun] = await client.$transaction([
    client.syncRun.groupBy({ by: ['status'], _count: { _all: true }, orderBy: { status: 'asc' } }),
    client.syncTask.groupBy({ by: ['status'], where: { syncRun: finished }, _count: { _all: true }, orderBy: { status: 'asc' } }),
    client.syncRun.aggregate({
      where: finished,
      _sum: { recordsFetched: true, recordsNew: true, recordsUpdated: true, linksCreated: true, candidatesCreated: true },
    }),
    client.syncRun.findFirst({ where: finished, select: runSummarySelect, orderBy: [{ startedAt: 'desc' }, { id: 'desc' }] }),
    client.syncRun.findFirst({ where: { status: 'SUCCESS' }, select: runSummarySelect, orderBy: [{ startedAt: 'desc' }, { id: 'desc' }] }),
  ]);
  const runs = new Map(runGroups.map((row) => [row.status, countOf(row._count)]));
  const tasks = new Map(taskGroups.map((row) => [row.status, countOf(row._count)]));
  const run = (status: SyncRunStatus) => runs.get(status) ?? 0;
  return {
    runs: {
      total: [...runs.values()].reduce((n, v) => n + v, 0),
      success: run('SUCCESS'),
      partialSuccess: run('PARTIAL_SUCCESS'),
      failed: run('FAILED'),
      running: run('RUNNING'),
    },
    tasks: { success: tasks.get('SUCCESS') ?? 0, failed: tasks.get('FAILED') ?? 0 },
    records: {
      fetched: totals._sum.recordsFetched ?? 0,
      added: totals._sum.recordsNew ?? 0,
      updated: totals._sum.recordsUpdated ?? 0,
      linksCreated: totals._sum.linksCreated ?? 0,
      candidatesCreated: totals._sum.candidatesCreated ?? 0,
    },
    lastRun,
    lastSuccessfulRun,
  };
}

/** `_count` of a groupBy row (typed loosely by Prisma when `orderBy` is given). */
function countOf(count: unknown): number {
  return count && typeof count === 'object' && '_all' in count && typeof count._all === 'number' ? count._all : 0;
}
