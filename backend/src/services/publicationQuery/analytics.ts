import { PrismaClient, PublicationSource, PublicationStatus, TypeFamily, VerificationStatus } from '@prisma/client';
import { prisma as defaultClient } from '../../config/database';
import { yearDistribution } from '../analytics/analytics';
import { AdminQuery, parseQuery } from './ast';
import { coverage, inQueryTransaction, matchingFilter, matchingSetFingerprint, CitationCoverage } from './execute';
import { qualifyingLink } from './scope';

/**
 * Conditional analytics of an administrator's publication query (Project_plan.md §24.1, §24.6;
 * decisions #154, D4, D5, D6, D10; stage Q4).
 *
 * The population is exactly the set of publications the query returns: the body is validated by
 * the shared validator and the set is built by the same `matchingFilter` as the search (link scope
 * AND condition tree), in one read-only REPEATABLE READ transaction with the query timeout, so all
 * sections describe one snapshot. The response carries the matching-set fingerprint; the page shows
 * the analytics only when it equals the table's (a set that changed between the two requests is
 * reported, never shown as if it were the table's). The department policy
 * (ACTIVE, not PREPRINT) is not re-applied — it is present only while the visible D3 conditions
 * are kept. Nothing from the client other than the query itself is used: no IDs or counts.
 *
 * D5: with fewer than two matches no analytics are returned (the page shows the table only).
 * Relevance (§24.6) is decided from the matching set and the data available: a section is
 * returned only when its dimension takes at least two values among the matches (or, for Scopus,
 * the data it needs exists). Operational sections (professor totals, pending verifications,
 * synchronization, sources-and-deduplication of everything stored) are never part of it.
 *
 * Three kinds of figures are kept apart, as in the department analytics: distinct publications,
 * relationship counts (per professor, per relationship status — a co-authored paper counts once
 * per professor) and source records. Per-professor rows list every professor with a qualifying
 * link (§24.5: status, origin and decision date on the same row), selected or not; selected
 * professors are flagged, never used as the list of qualifying professors.
 */

const MIN_MATCHES = 2;
const TOP_VENUES = 10;
const TOP_CITED = 10;
const TYPE_ORDER: readonly TypeFamily[] = ['JOURNAL', 'CONFERENCE', 'BOOK_CHAPTER', 'BOOK', 'PREPRINT', 'OTHER'];
const SOURCE_ORDER: readonly PublicationSource[] = ['OPENALEX', 'DBLP', 'ORCID', 'SCOPUS', 'WOS', 'MANUAL'];
const STATUS_ORDER: readonly VerificationStatus[] = ['APPROVED', 'PENDING', 'REJECTED'];

export interface ProfessorBreakdownRow {
  id: string;
  name: string;
  isActive: boolean;
  /** One of the query's selected professors (SELECTED mode); other qualifying co-authors are listed too. */
  selected: boolean;
  /** Matching publications on which this professor has a qualifying link (relationship count). */
  publications: number;
}

export type CitationAnalytics =
  /** D6: no Scopus observation stored at all — a note, never zeros. */
  | { available: false }
  /** Data exists, but none of the matches has a count — a note; coverage says why. */
  | { available: true; withCount: 0; coverage: CitationCoverage }
  | {
      available: true;
      withCount: number;
      coverage: CitationCoverage;
      latestObservation: Date | null;
      /** Over the publications with a count only; a publication without a count is not zero. */
      totalCitations: number;
      median: number;
      maximum: number;
      top: { id: string; title: string; year: number | null; count: number; observedAt: Date }[];
    };

export interface QueryAnalytics {
  years?: { years: { year: number; publications: number }[]; unknownYear: number; total: number };
  types?: { typeFamily: TypeFamily; publications: number }[];
  venues?: { venues: { venue: string; publications: number }[]; otherVenues: number; withoutVenue: number };
  professors?: { rows: ProfessorBreakdownRow[]; selectedCount: number };
  overlap?: { publications: number; selected: number };
  relationshipStatuses?: { status: VerificationStatus; links: number; publications: number }[];
  publicationStatuses?: { status: PublicationStatus; publications: number }[];
  doi?: { withDoi: number; withoutDoi: number };
  sources?: { source: PublicationSource; publications: number; sourceRecords: number }[];
  citations: CitationAnalytics;
}

export interface QueryAnalyticsResult {
  /** Matching publications (distinct), the same set the search returns. */
  total: number;
  /** Fingerprint of the matching set, comparable with the search's (`matchingSetFingerprint`). */
  fingerprint: string;
  /** null with fewer than two matches (D5). */
  analytics: QueryAnalytics | null;
}

export async function queryAnalytics(body: unknown, client: PrismaClient = defaultClient, options: { statementTimeoutMs?: number } = {}): Promise<QueryAnalyticsResult> {
  const query: AdminQuery = parseQuery('ADMIN', body);
  return inQueryTransaction(client, options.statementTimeoutMs, async (tx) => {
    const { where, available, citations } = await matchingFilter(tx, { role: 'ADMIN' }, query);
    const link = query.link;
    const matches = await tx.publication.findMany({
      where,
      select: { id: true, title: true, year: true, typeFamily: true, venue: true, doi: true, status: true },
      orderBy: { id: 'asc' },
    });
    const total = matches.length;
    const ids = matches.map((m) => m.id);
    const fingerprint = matchingSetFingerprint(ids);
    if (total < MIN_MATCHES) return { total, fingerprint, analytics: null };

    const inSet = { id: { in: ids } };
    // Sequential: one interactive transaction runs one statement at a time.
    const years = await yearDistribution(inSet, tx);
    const records = await tx.publicationSourceRecord.findMany({ where: { publicationId: { in: ids } }, select: { publicationId: true, source: true } });
    // Qualifying links (§24.5) of every professor — selected or not — on the matching publications.
    const links = await tx.professorPublication.findMany({
      where: { ...qualifyingLink(link), publicationId: { in: ids } },
      select: { publicationId: true, status: true, professor: { select: { id: true, name: true, isActive: true } } },
    });

    const analytics: QueryAnalytics = { citations: { available: false } };

    // By year: at least two distinct known years.
    if (years.years.length >= 2) analytics.years = years;

    // By type: at least two type families.
    const types = countBy(matches, (m) => m.typeFamily);
    if (types.size >= 2) analytics.types = TYPE_ORDER.filter((t) => types.has(t)).map((typeFamily) => ({ typeFamily, publications: types.get(typeFamily)! }));

    // Top venues: at least two distinct non-empty venues (free text; grouped ignoring case and spacing).
    const venueGroups = new Map<string, { spellings: Map<string, number>; publications: number }>();
    let withoutVenue = 0;
    for (const m of matches) {
      const venue = m.venue?.trim().replace(/\s+/g, ' ');
      if (!venue) {
        withoutVenue++;
        continue;
      }
      const key = venue.toLowerCase();
      const group = venueGroups.get(key) ?? { spellings: new Map(), publications: 0 };
      group.publications++;
      group.spellings.set(venue, (group.spellings.get(venue) ?? 0) + 1);
      venueGroups.set(key, group);
    }
    if (venueGroups.size >= 2) {
      const ranked = [...venueGroups.values()]
        // Shown under its most frequent spelling; ties go to the code-point-first one (capitalised before lowercase).
        .map((g) => ({ venue: [...g.spellings].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))[0][0], publications: g.publications }))
        .sort((a, b) => b.publications - a.publications || a.venue.localeCompare(b.venue));
      analytics.venues = { venues: ranked.slice(0, TOP_VENUES), otherVenues: Math.max(0, ranked.length - TOP_VENUES), withoutVenue };
    }

    // Per professor (relationship counts over qualifying links): ANY_PROFESSOR, SELECTED + ANY and
    // ALL_PUBLICATIONS with ≥ 2 professors; not SELECTED + ALL (identical rows for the selection) or NO_LINK.
    const selected = new Set(link.mode === 'SELECTED' ? (link.professors ?? []) : []);
    const perProfessor = new Map<string, ProfessorBreakdownRow>();
    for (const l of links) {
      const row = perProfessor.get(l.professor.id) ?? { ...l.professor, selected: selected.has(l.professor.id), publications: 0 };
      row.publications++;
      perProfessor.set(l.professor.id, row);
    }
    const breakdownMode = link.mode === 'ANY_PROFESSOR' || link.mode === 'ALL_PUBLICATIONS' || (link.mode === 'SELECTED' && link.match === 'ANY');
    if (breakdownMode && perProfessor.size >= 2) {
      const rows = [...perProfessor.values()].sort((a, b) => b.publications - a.publications || a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
      analytics.professors = { rows, selectedCount: rows.filter((r) => r.selected).length };
    }

    // Selected-professor overlap: SELECTED + ANY with ≥ 2 selected, and ≥ 1 match with ≥ 2 qualifying selected professors.
    if (link.mode === 'SELECTED' && link.match === 'ANY' && selected.size >= 2) {
      const selectedPerPublication = countBy(
        links.filter((l) => selected.has(l.professor.id)),
        (l) => l.publicationId,
      );
      const shared = [...selectedPerPublication.values()].filter((n) => n >= 2).length;
      if (shared >= 1) analytics.overlap = { publications: shared, selected: selected.size };
    }

    // By relationship status: ≥ 2 statuses in the link scope and ≥ 2 of them among the qualifying links.
    if (link.statuses.length >= 2) {
      const statusLinks = countBy(links, (l) => l.status);
      if (statusLinks.size >= 2) {
        analytics.relationshipStatuses = STATUS_ORDER.filter((s) => statusLinks.has(s)).map((status) => ({
          status,
          links: statusLinks.get(status)!,
          publications: new Set(links.filter((l) => l.status === status).map((l) => l.publicationId)).size,
        }));
      }
    }

    // By publication status: both ACTIVE and SUPPRESSED among the matches.
    const statuses = countBy(matches, (m) => m.status);
    if (statuses.size >= 2) analytics.publicationStatuses = (['ACTIVE', 'SUPPRESSED'] as const).map((status) => ({ status, publications: statuses.get(status) ?? 0 }));

    // DOI coverage: both with and without.
    const withDoi = matches.filter((m) => m.doi).length;
    if (withDoi > 0 && withDoi < total) analytics.doi = { withDoi, withoutDoi: total - withDoi };

    // By source: ≥ 2 sources report the matches (publications reported and source records per source).
    const sourceRecords = countBy(records, (r) => r.source);
    if (sourceRecords.size >= 2) {
      analytics.sources = SOURCE_ORDER.filter((s) => sourceRecords.has(s)).map((source) => ({
        source,
        publications: new Set(records.filter((r) => r.source === source).map((r) => r.publicationId)).size,
        sourceRecords: sourceRecords.get(source)!,
      }));
    }

    // Scopus citations (internal, admin only, #112): never summed across providers or records — each
    // publication contributes its one Scopus count (Q1 rule); publications without a count are not zero.
    if (available) {
      const summary = await coverage(tx, where, citations!, total);
      if (summary.available) {
        const counted = matches.filter((m) => citations!.has(m.id)).map((m) => ({ ...m, ...citations!.get(m.id)! }));
        if (counted.length === 0) {
          analytics.citations = { available: true, withCount: 0, coverage: summary.coverage };
        } else {
          const values = counted.map((c) => c.count).sort((a, b) => a - b);
          const mid = Math.floor(values.length / 2);
          analytics.citations = {
            available: true,
            withCount: counted.length,
            coverage: summary.coverage,
            latestObservation: summary.latestObservation,
            totalCitations: values.reduce((n, v) => n + v, 0),
            median: values.length % 2 ? values[mid] : (values[mid - 1] + values[mid]) / 2,
            maximum: values[values.length - 1],
            top: counted
              .sort((a, b) => b.count - a.count || a.title.localeCompare(b.title) || a.id.localeCompare(b.id))
              .slice(0, TOP_CITED)
              .map((c) => ({ id: c.id, title: c.title, year: c.year, count: c.count, observedAt: c.observedAt })),
          };
        }
      }
    }

    return { total, fingerprint, analytics };
  });
}

function countBy<T, K>(items: readonly T[], key: (item: T) => K): Map<K, number> {
  const counts = new Map<K, number>();
  for (const item of items) counts.set(key(item), (counts.get(key(item)) ?? 0) + 1);
  return counts;
}
