import { createHash } from 'node:crypto';
import type { JcrRankMetric, JournalIssnKind } from '@prisma/client';
import { normalizeIssn } from '../../services/normalization/issn';
import { FetchError } from '../http/httpClient';
import type { JcrJournalHistory, JcrJournalRecord, JcrJournalReport } from './types';

/**
 * JCR responses → what the project stores (Project_plan.md §13.8, §22.4, §22.5; decisions #114,
 * #116, #122). The only place that knows the Journals API shapes.
 */

/* ── Journal identity ─────────────────────────────────────────────────────── */

export interface JournalIssnRow {
  issn: string;
  kind: JournalIssnKind;
  validFromYear: number | null;
  validToYear: number | null;
}

export interface JournalProfile {
  jcrId: string;
  name: string;
  jcrTitle: string | null;
  isoTitle: string | null;
  publisherName: string | null;
  firstIssueYear: number | null;
  frequency: number | null;
  language: string | null;
  issns: JournalIssnRow[];
  /** The JCR years with a report ("List of all available Journal Citation Reports by year"). */
  reportYears: number[];
}

const text = (value: string | null | undefined): string | null => {
  const cleaned = value?.replace(/\s+/g, ' ').trim();
  return cleaned ? cleaned : null;
};

/**
 * The journal's profile and ISSNs: `issn` → PRINT, `eIssn` → ELECTRONIC, `previousIssn` and
 * history-only ISSNs → PREVIOUS; validity years from the history where it lists the ISSN. Values
 * that are not valid ISSNs are dropped (and so never link anything). An ISSN listed as both current
 * and electronic keeps PRINT.
 */
export function journalProfile(record: JcrJournalRecord, history: JcrJournalHistory | null): JournalProfile {
  const years = new Map<string, { from: number | null; to: number | null }>();
  for (const entry of history?.issn ?? []) {
    const issn = normalizeIssn(entry.issn);
    if (!issn) continue;
    const from = entry.year?.start ?? null;
    const to = entry.year?.end ?? null;
    const known = years.get(issn);
    // Several history rows for one ISSN: the widest span.
    years.set(issn, {
      from: known ? minNullable(known.from, from) : from,
      to: known ? maxNullable(known.to, to) : to,
    });
  }

  const issns = new Map<string, JournalIssnKind>();
  const add = (value: string | null | undefined, kind: JournalIssnKind) => {
    const issn = normalizeIssn(value);
    if (issn && !issns.has(issn)) issns.set(issn, kind);
  };
  add(record.issn, 'PRINT');
  add(record.eIssn, 'ELECTRONIC');
  for (const previous of record.previousIssn ?? []) add(previous, 'PREVIOUS');
  for (const issn of years.keys()) add(issn, 'PREVIOUS');

  return {
    jcrId: record.id,
    name: text(record.name) ?? record.id,
    jcrTitle: text(record.jcrTitle),
    isoTitle: text(record.isoTitle),
    publisherName: text(record.publisher?.name),
    firstIssueYear: record.firstIssueYear ?? null,
    frequency: record.frequency ?? null,
    language: text(record.language),
    issns: [...issns.entries()]
      .map(([issn, kind]) => {
        const validity = years.get(issn);
        const valid = validity && (validity.from === null || validity.to === null || validity.from <= validity.to);
        return { issn, kind, validFromYear: valid ? validity.from : null, validToYear: valid ? validity.to : null };
      })
      .sort((a, b) => a.issn.localeCompare(b.issn)),
    reportYears: [...new Set((record.journalCitationReports ?? []).map((r) => r.year))].sort((a, b) => a - b),
  };
}

const minNullable = (a: number | null, b: number | null) => (a === null ? b : b === null ? a : Math.min(a, b));
const maxNullable = (a: number | null, b: number | null) => (a === null ? b : b === null ? a : Math.max(a, b));

/* ── Yearly report → snapshot ─────────────────────────────────────────────── */

export interface CategoryMetricRow {
  metric: JcrRankMetric;
  /** Trimmed, whitespace-collapsed, upper-case, as JCR prints it. */
  categoryName: string;
  /** From the rank's `self` link (its last path segment), e.g. "RO_SCIE"; null when absent. */
  categoryCode: string | null;
  /** "" when not provided (e.g. JCI ranks); otherwise trimmed and upper-case, stored as returned. */
  edition: string;
  rankText: string | null;
  rank: number | null;
  rankTotal: number | null;
  quartile: string | null;
  percentile: number | null;
}

export interface NormalizedReport {
  // Returned directly by the API (#114).
  totalCites: number | null;
  jifText: string | null;
  jifWithoutSelfText: string | null;
  jif5Years: number | null;
  immediacyIndex: number | null;
  jci: number | null;
  averageJifPercentile: number | null;
  suppressed: boolean | null;
  onHold: boolean | null;
  delisted: boolean | null;
  /** Sorted by metric, category, edition. */
  categories: CategoryMetricRow[];
}

export interface MappedReport {
  report: NormalizedReport;
  /** SHA-256 (hex) of the normalized report: the snapshot's content identity (D16). */
  payloadHash: string;
  /** Derived numeric values of the published texts (NULL when not numeric, e.g. "N/A"). */
  jifValue: number | null;
  jifWithoutSelfValue: number | null;
  /** Review notes: unfamiliar editions, unusable quartiles or ranks. Values are JCR's own labels. */
  warnings: string[];
}

/**
 * The editions documented for the Journals API filter (`edition`: SCIE, SSCI, AHCI, ESCI). It is
 * not an allowlist: other identifiers are stored as returned and only reported for review.
 */
export const DOCUMENTED_EDITIONS: ReadonlySet<string> = new Set(['SCIE', 'SSCI', 'AHCI', 'ESCI']);

const QUARTILE = /^Q[1-4]$/;

/**
 * Normalizes a yearly report (fields of §22.5; numbers and strings canonicalized, category rows
 * sorted) and hashes it. Two rows for the same metric, category and edition must be identical
 * (exact duplicates collapse); conflicting ones make the report invalid (INVALID_RESPONSE). Error
 * messages name no JCR content (category names stay out of task errors).
 */
export function mapJournalReport(raw: JcrJournalReport): MappedReport {
  const warnings: string[] = [];
  const impact = raw.metrics?.impactMetrics ?? {};
  const rows: CategoryMetricRow[] = [];
  for (const [metric, ranks] of [['JIF', raw.ranks?.jif ?? []], ['JCI', raw.ranks?.jci ?? []]] as const) {
    for (const rank of ranks) {
      const categoryName = rank.category.replace(/\s+/g, ' ').trim().toUpperCase();
      if (!categoryName) throw new FetchError('INVALID_RESPONSE', `JCR report has a ${metric} rank without a category name`);
      const edition = (rank.edition ?? '').trim().toUpperCase();
      if (edition && !DOCUMENTED_EDITIONS.has(edition)) warnings.push(`Unfamiliar JCR edition "${edition}" for ${metric} category ${categoryName}; stored as returned`);
      const rankText = text(rank.rank);
      const parsedRank = parseRank(rankText);
      if (rankText && !parsedRank) warnings.push(`${metric} rank "${rankText}" in ${categoryName} is not "n/total"; kept as text only`);
      const quartileText = text(rank.quartile)?.toUpperCase() ?? null;
      const quartile = quartileText && QUARTILE.test(quartileText) ? quartileText : null;
      if (quartileText && !quartile) warnings.push(`${metric} quartile "${quartileText}" in ${categoryName} is not Q1–Q4; not stored`);
      const { jifPercentile, jciPercentile } = rank as { jifPercentile?: number | null; jciPercentile?: number | null };
      const percentile = metric === 'JIF' ? jifPercentile : jciPercentile;
      rows.push({
        metric,
        categoryName,
        categoryCode: categoryCodeOf(rank.self),
        edition,
        rankText,
        rank: parsedRank?.rank ?? null,
        rankTotal: parsedRank?.total ?? null,
        quartile,
        percentile: finite(percentile),
      });
    }
  }

  const categories = dedupeCategories(rows);
  const report: NormalizedReport = {
    totalCites: finite(impact.totalCites),
    jifText: text(impact.jif),
    jifWithoutSelfText: text(impact.jifWithoutSelfCitations),
    jif5Years: finite(impact.jif5Years),
    immediacyIndex: finite(impact.immediacyIndex),
    jci: finite(impact.jci),
    averageJifPercentile: finite(raw.metrics?.sourceMetrics?.jifPercentile),
    suppressed: raw.suppressed ?? null,
    onHold: raw.onHold ?? null,
    delisted: raw.delisted ?? null,
    categories,
  };
  return {
    report,
    payloadHash: createHash('sha256').update(canonicalJson(report)).digest('hex'),
    jifValue: numericText(report.jifText),
    jifWithoutSelfValue: numericText(report.jifWithoutSelfText),
    warnings,
  };
}

function dedupeCategories(rows: CategoryMetricRow[]): CategoryMetricRow[] {
  const byKey = new Map<string, CategoryMetricRow>();
  for (const row of rows) {
    const key = `${row.metric}\u0000${row.categoryName}\u0000${row.edition}`;
    const known = byKey.get(key);
    if (known && canonicalJson(known) !== canonicalJson(row)) {
      throw new FetchError('INVALID_RESPONSE', `JCR report has conflicting ${row.metric} ranks for one category and edition`);
    }
    byKey.set(key, row);
  }
  return [...byKey.values()].sort(
    (a, b) => a.metric.localeCompare(b.metric) || a.categoryName.localeCompare(b.categoryName) || a.edition.localeCompare(b.edition),
  );
}

/** "12/345" → { rank: 12, total: 345 } when 1 ≤ rank ≤ total; anything else → null. */
function parseRank(value: string | null): { rank: number; total: number } | null {
  const match = /^(\d+)\s*\/\s*(\d+)$/.exec(value ?? '');
  if (!match) return null;
  const rank = Number(match[1]);
  const total = Number(match[2]);
  return rank >= 1 && total >= 1 && rank <= total ? { rank, total } : null;
}

/** "…/categories/RO_SCIE" or "RO_SCIE" → "RO_SCIE"; anything else → null. */
function categoryCodeOf(self: string | null | undefined): string | null {
  const segment = self?.trim().split('/').filter(Boolean).pop() ?? '';
  return /^[A-Z0-9_]{1,40}$/.test(segment) ? segment : null;
}

function finite(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** "12.345" → 12.345; "<0.1", "N/A" and other non-numeric texts → null. */
function numericText(value: string | null): number | null {
  return value !== null && /^\d+(?:\.\d+)?$/.test(value) ? Number(value) : null;
}

/** JSON with object keys sorted at every level, so equal content always hashes equally. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value as Record<string, unknown>)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}
