"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";
import { AdminQuerySection, type TableState } from "@/components/admin-query";
import { SourceChip, StatusChip } from "@/components/chips";
import { Alert, Button, EmptyState, Figures, LoadError, PageHeader, Panel, SectionTitle, Segmented, Skeleton } from "@/components/ui";
import { api } from "@/lib/api";
import { formatDate, formatDateTime, formatNumber, plural, SOURCE_LABEL, TYPE_LABEL } from "@/lib/format";
import { analyticsConsistency, type AppliedQuery, type QueryAnalyticsResponse } from "@/lib/query-builder";
import { useResource } from "@/lib/use-resource";
import type { ByYear, CitationStats, Overview, PerProfessor, Source, SourceStats, SyncStats, TypeFamily } from "@/lib/types";

/**
 * Administrator analytics (Project_plan.md §16; pages/admin-analytics.md). Every figure comes from
 * the backend's analytics endpoints; nothing is recomputed here. Charts are plain HTML with a
 * table view, hover/focus values and no animation.
 *
 * Conditional publication queries (§24, stages Q3–Q4): a query builder and, while a query is
 * applied, its matching publications (components/admin-query.tsx) followed by analytics of exactly
 * those publications (`ConditionalAnalytics`, §24.6) in place of the department-wide view. Without
 * a query the department-wide analytics (§16, unchanged) are the view.
 */

interface Data {
  overview: Overview;
  professors: PerProfessor;
  years: ByYear;
  sources: SourceStats;
  sync: SyncStats;
  citations: CitationStats;
}

async function load(signal: AbortSignal): Promise<Data> {
  const [overview, professors, years, sources, sync, citations] = await Promise.all([
    api<{ overview: Overview }>("/admin/analytics/overview", { signal }).then((r) => r.overview),
    api<PerProfessor>("/admin/analytics/professors", { signal }),
    api<ByYear>("/admin/analytics/years", { signal }),
    api<SourceStats>("/admin/analytics/sources", { signal }),
    api<SyncStats>("/admin/analytics/sync", { signal }),
    api<CitationStats>("/admin/analytics/citations", { signal }),
  ]);
  return { overview, professors, years, sources, sync, citations };
}

const DEPARTMENT_DESCRIPTION =
  "Counted publications are approved by at least one professor, not suppressed and not preprints. Each publication counts once, however many professors or sources report it.";

export default function AnalyticsPage() {
  return (
    <Suspense fallback={<PageHeader title="Analytics" description={DEPARTMENT_DESCRIPTION} />}>
      <AnalyticsHeader />
      <AdminQuerySection department={<DepartmentAnalytics />} conditional={(query, table) => <ConditionalAnalytics query={query} table={table} />} />
    </Suspense>
  );
}

/**
 * The page description follows the view: the department counting policy describes the default
 * analytics only; with a query applied (an administrator's query URL always has a link scope) the
 * figures cover exactly the matching publications (§24.6).
 */
function AnalyticsHeader() {
  const queryApplied = useSearchParams().has("link");
  return (
    <PageHeader
      title="Analytics"
      description={
        queryApplied
          ? "Showing the publications that match the query below and analytics of exactly those publications. The department counting policy applies only through the query's own conditions."
          : DEPARTMENT_DESCRIPTION
      }
    />
  );
}

/* ── Conditional analytics (§24.6; stage Q4) ──────────────────────────── */

/**
 * Analytics of exactly the publications an applied query returns, computed on the server from the
 * query itself (never from client-side rows or counts). Only the condition tree and link scope are
 * sent, so paging and sorting the table do not reload them. With fewer than two matches the server
 * returns none and nothing is shown (D5); each section is present only when relevant (§24.6).
 *
 * The table and the analytics are separate requests (each internally one snapshot). They are shown
 * together only when their matching-set fingerprints are equal; if the set changed between them the
 * analytics are withheld with a message and a manual Refresh (no automatic retry) (#163).
 */
function ConditionalAnalytics({ query, table }: { query: AppliedQuery; table: TableState }) {
  const body = { link: query.link, ...(query.root && { root: query.root }) };
  const key = `query-analytics:${JSON.stringify(body)}`;
  const { data, error, loading, reload } = useResource<QueryAnalyticsResponse>(key, (signal) =>
    api<QueryAnalyticsResponse>("/admin/publication-queries/analytics", { method: "POST", body, signal }),
  );

  if (error && !data) {
    return (
      <section aria-labelledby="qa-heading" className="flex flex-col gap-3">
        <SectionTitle id="qa-heading">Analytics of the matching publications</SectionTitle>
        <LoadError error={error} onRetry={() => void reload()} />
      </section>
    );
  }
  if (table.failed) return null; // the table shows the error; nothing to compare against
  const compared = data && !loading ? analyticsConsistency(table.result, data) : "pending";
  // A mismatch is reported only once the table's request has settled (e.g. after Refresh).
  const consistency = compared === "changed" && table.running ? "pending" : compared;
  if (!data || consistency === "pending") {
    return (
      <div role="status" aria-label="Loading analytics of the matching publications" className="flex flex-col gap-6">
        <Skeleton className="h-28 w-full" />
      </div>
    );
  }
  if (consistency === "changed") {
    return (
      <section aria-labelledby="qa-heading" className="flex flex-col gap-3" data-analytics-changed>
        <SectionTitle id="qa-heading">Analytics of the matching publications</SectionTitle>
        <Alert
          tone="warning"
          role="alert"
          title="The matching publications changed while loading"
          action={
            <Button
              compact
              onClick={() => {
                table.refresh();
                void reload();
              }}
            >
              Refresh
            </Button>
          }
        >
          The table and the analytics were computed over different sets of publications, so the analytics are not shown. Refresh to load both again.
        </Alert>
      </section>
    );
  }
  const a = data.analytics;
  if (!a) return null; // D5: 0 or 1 match — the table only

  return (
    <div className="flex flex-col gap-10" data-conditional-analytics>
      <section aria-labelledby="qa-heading">
        <SectionTitle id="qa-heading">Analytics of the matching publications</SectionTitle>
        <p className="max-w-[72ch] text-[13px] leading-5 text-text-muted">
          Computed over exactly the {plural(data.total, "publication")} the query returns, each counted once. The department policy (approved, active, not a
          preprint) applies only through the query&apos;s own conditions. Only analytics that vary among these publications are shown.
        </p>
      </section>
      {a.years && <YearsSection years={a.years} />}
      {a.types && (
        <BarSection
          id="qa-types"
          title="By type"
          rows={a.types.map((t) => ({ key: t.typeFamily, label: TYPE_LABEL[t.typeFamily as TypeFamily] ?? t.typeFamily, value: t.publications }))}
          unit="Publications"
        />
      )}
      {a.venues && (
        <BarSection
          id="qa-venues"
          title="Top venues"
          caption={`Venue names are free text; spellings that differ only in case or spacing are combined.${a.venues.otherVenues ? ` ${plural(a.venues.otherVenues, "other venue")} not listed.` : ""}${a.venues.withoutVenue ? ` ${plural(a.venues.withoutVenue, "publication")} without a venue.` : ""}`}
          rows={a.venues.venues.map((v) => ({ key: v.venue, label: v.venue, value: v.publications }))}
          unit="Publications"
        />
      )}
      {a.professors && <QueryProfessorsSection professors={a.professors} overlap={a.overlap} />}
      {a.relationshipStatuses && (
        <BarSection
          id="qa-links"
          title="By relationship status"
          caption="Qualifying professor links by status; a co-authored publication counts once per professor."
          rows={a.relationshipStatuses.map((r) => ({
            key: r.status,
            label: <StatusChip status={r.status} />,
            value: r.links,
            note: `${plural(r.publications, "publication")}`,
          }))}
          unit="Links"
        />
      )}
      {a.publicationStatuses && (
        <BarSection
          id="qa-status"
          title="By publication status"
          rows={a.publicationStatuses.map((r) => ({ key: r.status, label: <StatusChip status={r.status} />, value: r.publications }))}
          unit="Publications"
        />
      )}
      {a.doi && (
        <BarSection
          id="qa-doi"
          title="DOI coverage"
          rows={[
            { key: "with", label: "With a DOI", value: a.doi.withDoi },
            { key: "without", label: "Without a DOI", value: a.doi.withoutDoi },
          ]}
          unit="Publications"
        />
      )}
      {a.sources && (
        <BarSection
          id="qa-sources"
          title="By source"
          caption="A publication reported by several sources counts for each of them."
          rows={a.sources.map((src) => ({
            key: src.source,
            label: <SourceChip source={src.source as Source} />,
            value: src.publications,
            note: plural(src.sourceRecords, "source record"),
          }))}
          unit="Publications reported"
        />
      )}
      <QueryCitationsSection citations={a.citations} />
    </div>
  );
}

/** A small table of counts with proportional bars (the per-professor table's style). */
function BarSection({
  id,
  title,
  caption,
  rows,
  unit,
}: {
  id: string;
  title: string;
  caption?: string;
  rows: { key: string; label: React.ReactNode; value: number; note?: string }[];
  unit: string;
}) {
  const max = Math.max(1, ...rows.map((r) => r.value));
  return (
    <section aria-labelledby={id}>
      <SectionTitle id={id}>{title}</SectionTitle>
      <Panel>
        <div className="overflow-x-auto">
          <table className="data-table">
            {caption ? <caption className="px-4 pt-3 pb-2 text-left text-[13px] leading-5 text-text-muted">{caption}</caption> : <caption className="sr-only">{title}</caption>}
            <thead>
              <tr>
                <th scope="col">{title.replace(/^By /, "").replace(/^\w/, (c) => c.toUpperCase())}</th>
                <th scope="col" className="num">
                  {unit}
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.key}>
                  <td className="no-label">{r.label}</td>
                  <td data-label={unit} className="num">
                    <span className="inline-flex items-center gap-3">
                      <span aria-hidden className="hidden h-2 w-40 rounded-sm bg-surface-sunken md:inline-block">
                        <span className="block h-2 rounded-sm bg-ink" style={{ width: `${(r.value / max) * 100}%` }} />
                      </span>
                      <span className="min-w-8">{formatNumber(r.value)}</span>
                      {r.note && <span className="text-[13px] text-text-muted">{r.note}</span>}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Panel>
    </section>
  );
}

/**
 * Per professor over qualifying links (§24.5): every professor with a qualifying link on a matching
 * publication — selected or not — with selected professors labelled; relationship counts.
 */
function QueryProfessorsSection({
  professors,
  overlap,
}: {
  professors: NonNullable<NonNullable<QueryAnalyticsResponse["analytics"]>["professors"]>;
  overlap?: { publications: number; selected: number };
}) {
  const max = Math.max(1, ...professors.rows.map((p) => p.publications));
  const others = professors.rows.length - professors.selectedCount;
  return (
    <section aria-labelledby="qa-prof">
      <SectionTitle id="qa-prof">Per professor</SectionTitle>
      {overlap && (
        <p className="mb-3 text-[15px]">
          <span className="font-semibold tabular-nums">{formatNumber(overlap.publications)}</span> matching{" "}
          {overlap.publications === 1 ? "publication has" : "publications have"} qualifying links of at least two of the {overlap.selected} selected professors.
        </p>
      )}
      <Panel>
        <div className="overflow-x-auto">
          <table className="data-table">
            <caption className="px-4 pt-3 pb-2 text-left text-[13px] leading-5 text-text-muted">
              Matching publications on which each professor has a qualifying link. A co-authored publication counts for each of its professors, so this column
              can add up to more than the matching total.
              {professors.selectedCount > 0 && others > 0 && ` ${plural(others, "co-author")} with qualifying links who ${others === 1 ? "was" : "were"} not selected ${others === 1 ? "is" : "are"} listed too.`}
            </caption>
            <thead>
              <tr>
                <th scope="col">Professor</th>
                <th scope="col" className="num">
                  Matching publications
                </th>
              </tr>
            </thead>
            <tbody>
              {professors.rows.map((p) => (
                <tr key={p.id} data-selected-professor={p.selected || undefined}>
                  <td className="no-label">
                    <Link href={`/admin/professors/${p.id}`} className="text-ink hover:underline underline-offset-4">
                      {p.name}
                    </Link>
                    {p.selected && <span className="ml-2 text-[13px] text-text-muted">(selected)</span>}
                    {!p.isActive && <span className="ml-2 text-[13px] text-text-muted">(inactive)</span>}
                  </td>
                  <td data-label="Matching publications" className="num">
                    <span className="inline-flex items-center gap-3">
                      <span aria-hidden className="hidden h-2 w-40 rounded-sm bg-surface-sunken md:inline-block">
                        <span className="block h-2 rounded-sm bg-ink" style={{ width: `${(p.publications / max) * 100}%` }} />
                      </span>
                      <span className="min-w-8">{formatNumber(p.publications)}</span>
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Panel>
    </section>
  );
}

/** Scopus citations of the matches (internal, admin only, #112); a missing count is never shown as zero (D6). */
function QueryCitationsSection({ citations }: { citations: NonNullable<QueryAnalyticsResponse["analytics"]>["citations"] }) {
  return (
    <section aria-labelledby="qa-cit">
      <SectionTitle id="qa-cit">Citations (Scopus, internal)</SectionTitle>
      {!citations.available ? (
        <p className="text-[15px] text-text-muted">Scopus citation data unavailable.</p>
      ) : citations.withCount === 0 ? (
        <p className="text-[15px] text-text-muted">
          None of these publications has a Scopus count ({formatNumber(citations.coverage.notInScopus)} not in Scopus,{" "}
          {formatNumber(citations.coverage.noCountYet)} with no Scopus count yet).
        </p>
      ) : (
        "totalCitations" in citations && (
          <>
            <p className="mb-3 max-w-[72ch] text-[13px] leading-5 text-text-muted">
              Over the {plural(citations.withCount, "publication")} with a Scopus count; {formatNumber(citations.coverage.noCountYet)} with no Scopus count yet and{" "}
              {formatNumber(citations.coverage.notInScopus)} not in Scopus are not counted as zero. Each publication contributes its one Scopus count.
            </p>
            <Figures
              items={[
                { label: "Scopus citations", value: formatNumber(citations.totalCitations), note: `${plural(citations.withCount, "publication")} with a count` },
                { label: "Median", value: formatNumber(citations.median), note: "per publication with a count" },
                { label: "Maximum", value: formatNumber(citations.maximum) },
                {
                  label: "Latest count",
                  value: <span className="text-[15px] leading-6 font-medium">{citations.latestObservation ? formatDate(citations.latestObservation) : "None yet"}</span>,
                },
              ]}
            />
            <Panel className="mt-4">
              <div className="overflow-x-auto">
                <table className="data-table">
                  <caption className="px-4 pt-3 pb-2 text-left text-[13px] leading-5 text-text-muted">Most cited matching publications (up to 10).</caption>
                  <thead>
                    <tr>
                      <th scope="col">Publication</th>
                      <th scope="col" className="num">
                        Scopus citations
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {citations.top.map((t) => (
                      <tr key={t.id}>
                        <td className="no-label">
                          <span className="font-serif">{t.title}</span>
                          <span className="text-[13px] text-text-muted"> · {t.year ?? "Year unknown"}</span>
                        </td>
                        <td data-label="Scopus citations" className="num">
                          {formatNumber(t.count)}
                          <span className="ml-2 text-[13px] text-text-muted">as of {formatDate(t.observedAt)}</span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Panel>
          </>
        )
      )}
    </section>
  );
}

/** The department-wide analytics (§16): the page's default view, unchanged by any query. */
function DepartmentAnalytics() {
  const { data, error, reload } = useResource("analytics", load);

  return (
    <>
      {error && !data ? (
        <LoadError error={error} onRetry={() => void reload()} />
      ) : !data ? (
        <div role="status" aria-label="Loading analytics" className="flex flex-col gap-6">
          <Skeleton className="h-28 w-full" />
          <Skeleton className="h-64 w-full" />
        </div>
      ) : (
        <div className="flex flex-col gap-10">
          <Figures
            items={[
              { label: "Professors", value: formatNumber(data.overview.professors.active), note: `active of ${formatNumber(data.overview.professors.total)}` },
              { label: "Unique publications", value: formatNumber(data.overview.uniquePublications), note: "counted once each" },
              { label: "Pending verifications", value: formatNumber(data.overview.pendingVerifications), note: "awaiting professors" },
              {
                label: "Last synchronization",
                value: (
                  <span className="text-[15px] leading-6 font-medium">
                    {data.overview.lastSync ? formatDateTime(data.overview.lastSync.finishedAt ?? data.overview.lastSync.startedAt) : "Never"}
                  </span>
                ),
                note: data.overview.syncRunning ? (
                  <StatusChip status="RUNNING" />
                ) : data.overview.lastSync ? (
                  <StatusChip status={data.overview.lastSync.status} />
                ) : undefined,
              },
            ]}
          />
          <TypeBreakdown overview={data.overview} />
          <YearsSection years={data.years} />
          <ProfessorsSection data={data.professors} unique={data.overview.uniquePublications} />
          <SourcesSection sources={data.sources} />
          <CitationsSection citations={data.citations} />
          <SyncSection sync={data.sync} />
        </div>
      )}
    </>
  );
}

function TypeBreakdown({ overview }: { overview: Overview }) {
  return (
    <p className="-mt-6 text-[13px] leading-5 text-text-muted">
      By type:{" "}
      {overview.uniquePublicationsByType.map((t, i) => (
        <span key={t.typeFamily}>
          {i > 0 && " · "}
          {TYPE_LABEL[t.typeFamily]} <span className="tabular-nums text-text">{formatNumber(t.publications)}</span>
        </span>
      ))}
    </p>
  );
}

/** Every year between the first and the last, so gaps show as empty years on the time axis. */
function continuousYears(years: ByYear["years"]): ByYear["years"] {
  if (years.length === 0) return [];
  const byYear = new Map(years.map((y) => [y.year, y.publications]));
  const first = years[0].year;
  const last = years[years.length - 1].year;
  return Array.from({ length: last - first + 1 }, (_, i) => ({ year: first + i, publications: byYear.get(first + i) ?? 0 }));
}

function YearsSection({ years }: { years: ByYear }) {
  const [view, setView] = useState<"chart" | "table">("chart");
  const axis = continuousYears(years.years);
  const max = Math.max(1, ...years.years.map((y) => y.publications));
  const summary =
    years.years.length === 0
      ? "No dated publications."
      : `${formatNumber(years.total)} publications from ${years.years[0].year} to ${years.years[years.years.length - 1].year}; the most in ${years.years.reduce((a, b) => (b.publications > a.publications ? b : a)).year}.`;
  return (
    <section aria-labelledby="years-heading">
      <SectionTitle
        id="years-heading"
        actions={
          <div className="max-md:hidden">
            <Segmented
              label="Publications by year view"
              value={view}
              onChange={setView}
              options={[
                { value: "chart", label: "Chart" },
                { value: "table", label: "Table" },
              ]}
            />
          </div>
        }
      >
        Publications by year
      </SectionTitle>
      <Panel className="px-4 py-4">
        {years.total === 0 ? (
          <EmptyState>No approved publications yet.</EmptyState>
        ) : view === "chart" ? (
          <>
            <div className="md:hidden">
              <YearTable years={years} />
            </div>
            <figure className="max-md:hidden">
              <figcaption className="sr-only">{summary}</figcaption>
              {axis.length > 0 && (
                <div className="overflow-x-auto">
                  <div
                    role="list"
                    className="flex h-56 min-w-full items-end gap-0.5 border-b border-border-strong pt-6"
                    style={{ minWidth: `${axis.length * 28}px` }}
                  >
                    {axis.map((y) => (
                      <div
                        key={y.year}
                        role="listitem"
                        className="group relative flex h-full flex-1 flex-col items-center justify-end"
                        aria-label={`${y.year}: ${y.publications}`}
                      >
                        {axis.length <= 30 && y.publications > 0 && (
                          <span className="mb-1 text-[12px] leading-4 tabular-nums text-text-muted">{y.publications}</span>
                        )}
                        <div
                          tabIndex={0}
                          className="w-full max-w-10 rounded-t bg-ink outline-offset-2 hover:bg-ink-hover"
                          style={{ height: y.publications ? `${Math.max(2, (y.publications / max) * 100)}%` : "0" }}
                          title={`${y.year}: ${formatNumber(y.publications)} publications`}
                        />
                        <span className="pointer-events-none absolute -top-1 hidden rounded-sm bg-text px-1.5 py-0.5 text-[12px] whitespace-nowrap text-surface group-focus-within:block group-hover:block">
                          {y.year}: {formatNumber(y.publications)}
                        </span>
                      </div>
                    ))}
                  </div>
                  <div className="flex gap-0.5 pt-1" style={{ minWidth: `${axis.length * 28}px` }} aria-hidden>
                    {axis.map((y) => (
                      <span key={y.year} className="flex-1 text-center text-[12px] tabular-nums text-text-muted">
                        {axis.length > 16 ? `’${String(y.year).slice(2)}` : y.year}
                      </span>
                    ))}
                  </div>
                </div>
              )}
              {years.unknownYear > 0 && (
                <p className="mt-3 text-[13px] text-text-muted">
                  {formatNumber(years.unknownYear)} {years.unknownYear === 1 ? "publication has" : "publications have"} no year and{" "}
                  {years.unknownYear === 1 ? "is" : "are"} not shown in the chart.
                </p>
              )}
            </figure>
          </>
        ) : (
          <YearTable years={years} />
        )}
      </Panel>
    </section>
  );
}

function YearTable({ years }: { years: ByYear }) {
  return (
    <table className="data-table">
      <caption className="sr-only">Publications by year</caption>
      <thead>
        <tr>
          <th scope="col">Year</th>
          <th scope="col" className="num">
            Publications
          </th>
        </tr>
      </thead>
      <tbody>
        {years.years.map((y) => (
          <tr key={y.year}>
            <td className="no-label tabular-nums">{y.year}</td>
            <td data-label="Publications" className="num">
              {formatNumber(y.publications)}
            </td>
          </tr>
        ))}
        {years.unknownYear > 0 && (
          <tr>
            <td className="no-label">Year unknown</td>
            <td data-label="Publications" className="num">
              {formatNumber(years.unknownYear)}
            </td>
          </tr>
        )}
        <tr>
          <td className="no-label font-semibold">Total</td>
          <td data-label="Publications" className="num font-semibold">
            {formatNumber(years.total)}
          </td>
        </tr>
      </tbody>
    </table>
  );
}

function ProfessorsSection({ data, unique }: { data: PerProfessor; unique: number }) {
  const max = Math.max(1, ...data.professors.map((p) => p.approvedPublications));
  return (
    <section aria-labelledby="prof-heading">
      <SectionTitle id="prof-heading">Publications per professor</SectionTitle>
      <Panel>
        {data.professors.length === 0 ? (
          <EmptyState>No professors yet.</EmptyState>
        ) : (
          <div className="overflow-x-auto">
            <table className="data-table">
              <caption className="px-4 pt-3 pb-2 text-left text-[13px] leading-5 text-text-muted">
                A publication co-authored by two professors counts for each of them, so this column can add up to more than the {formatNumber(unique)} unique
                publications.
              </caption>
              <thead>
                <tr>
                  <th scope="col">Professor</th>
                  <th scope="col">Status</th>
                  <th scope="col" className="num">
                    Approved publications
                  </th>
                </tr>
              </thead>
              <tbody>
                {data.professors.map((p) => (
                  <tr key={p.id}>
                    <td className="no-label">
                      <Link href={`/admin/professors/${p.id}`} className="text-ink hover:underline underline-offset-4">
                        {p.name}
                      </Link>
                      <p className="text-[13px] text-text-muted">{[p.designation, p.department].filter(Boolean).join(" · ") || "–"}</p>
                    </td>
                    <td data-label="Status">{p.isActive ? <span className="text-[13px]">Active</span> : <StatusChip status="INACTIVE" />}</td>
                    <td data-label="Approved publications" className="num">
                      <span className="inline-flex items-center gap-3">
                        <span aria-hidden className="hidden h-2 w-40 rounded-sm bg-surface-sunken md:inline-block">
                          <span className="block h-2 rounded-sm bg-ink" style={{ width: `${(p.approvedPublications / max) * 100}%` }} />
                        </span>
                        <span className="min-w-8">{formatNumber(p.approvedPublications)}</span>
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
    </section>
  );
}

/**
 * Internal Scopus citation aggregates (§16, decision #112): administrator only, never shown
 * outside the portal. Web of Science and JCR figures wait for Clarivate's written confirmation.
 */
function CitationsSection({ citations }: { citations: CitationStats }) {
  const scopus = citations.scopus;
  return (
    <section aria-labelledby="cit-heading">
      <SectionTitle id="cit-heading">Citations (Scopus, internal)</SectionTitle>
      <p className="mb-3 max-w-[72ch] text-[13px] leading-5 text-text-muted">
        Citation counts from Scopus for the counted publications, each publication once. For internal use by the administrator only. Web of Science citation
        counts and Journal Citation Reports metrics are not shown until Clarivate&apos;s written confirmation is on record.
      </p>
      <Figures
        items={[
          { label: "Scopus citations", value: formatNumber(scopus.totalCitations), note: "counted publications" },
          {
            label: "Publications with a count",
            value: formatNumber(scopus.publicationsWithCount),
            note: `of ${formatNumber(scopus.countedPublications)} counted`,
          },
          { label: "Latest count", value: <span className="text-[15px] leading-6 font-medium">{scopus.latestObservation ? formatDate(scopus.latestObservation) : "None yet"}</span> },
        ]}
      />
      {scopus.professors.length > 0 && (
        <Panel className="mt-4">
          <div className="overflow-x-auto">
            <table className="data-table">
              <caption className="px-4 pt-3 pb-2 text-left text-[13px] leading-5 text-text-muted">
                A co-authored publication counts for each of its professors, so these rows can add up to more than the total.
              </caption>
              <thead>
                <tr>
                  <th scope="col">Professor</th>
                  <th scope="col" className="num">
                    Publications with a count
                  </th>
                  <th scope="col" className="num">
                    Scopus citations
                  </th>
                </tr>
              </thead>
              <tbody>
                {scopus.professors.map((p) => (
                  <tr key={p.id}>
                    <td className="no-label">
                      <Link href={`/admin/professors/${p.id}`} className="text-ink hover:underline underline-offset-4">
                        {p.name}
                      </Link>
                      {!p.isActive && <p className="text-[13px] text-text-muted">Inactive</p>}
                    </td>
                    <td data-label="Publications with a count" className="num">
                      {formatNumber(p.publicationsWithCount)}
                    </td>
                    <td data-label="Scopus citations" className="num">
                      {formatNumber(p.citations)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Panel>
      )}
    </section>
  );
}

function SourcesSection({ sources }: { sources: SourceStats }) {
  const [showStored, setShowStored] = useState(false);
  return (
    <section aria-labelledby="src-heading">
      <SectionTitle id="src-heading">Sources and deduplication</SectionTitle>
      <Panel>
        <div className="overflow-x-auto">
          <table className="data-table">
            <caption className="px-4 pt-3 pb-2 text-left text-[13px] leading-5 text-text-muted">
              Several sources often report the same paper; their records are merged into one canonical publication.
            </caption>
            <thead>
              <tr>
                <th scope="col">Source</th>
                <th scope="col" className="num">
                  Source records
                </th>
                <th scope="col" className="num">
                  Publications reported
                </th>
              </tr>
            </thead>
            <tbody>
              {sources.counted.sources.map((s) => (
                <tr key={s.source}>
                  <td className="no-label">
                    <SourceChip source={s.source} />
                  </td>
                  <td data-label="Source records" className="num">
                    {formatNumber(s.sourceRecords)}
                  </td>
                  <td data-label="Publications reported" className="num">
                    {formatNumber(s.publications)}
                  </td>
                </tr>
              ))}
              <tr>
                <td className="no-label font-semibold">All sources</td>
                <td data-label="Source records" className="num font-semibold">
                  {formatNumber(sources.counted.sourceRecords)}
                </td>
                <td data-label="Unique publications" className="num font-semibold">
                  {formatNumber(sources.counted.uniquePublications)} unique
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <div className="border-t border-border px-4 py-3">
          <button
            type="button"
            aria-expanded={showStored}
            onClick={() => setShowStored((s) => !s)}
            className="cursor-pointer text-[15px] text-ink hover:underline underline-offset-4"
          >
            {showStored ? "Hide" : "Show"} everything stored (including pending, rejected, preprints and suppressed)
          </button>
          {showStored && (
            <dl className="mt-3 grid gap-x-6 gap-y-1 text-[15px] sm:grid-cols-[14rem_1fr]">
              {sources.stored.sources.map((s) => (
                <div key={s.source} className="contents">
                  <dt className="text-text-muted">{SOURCE_LABEL[s.source]} records</dt>
                  <dd className="tabular-nums">{formatNumber(s.sourceRecords)}</dd>
                </div>
              ))}
              <dt className="text-text-muted">All stored records</dt>
              <dd className="tabular-nums">{formatNumber(sources.stored.sourceRecords)}</dd>
              <dt className="text-text-muted">Stored publications</dt>
              <dd className="tabular-nums">{formatNumber(sources.stored.publications)}</dd>
            </dl>
          )}
        </div>
      </Panel>
    </section>
  );
}

function SyncSection({ sync }: { sync: SyncStats }) {
  return (
    <section aria-labelledby="sync-heading">
      <SectionTitle
        id="sync-heading"
        actions={
          <Link href="/admin/sync" className="text-[15px] text-ink hover:underline underline-offset-4">
            View run history
          </Link>
        }
      >
        Synchronization
      </SectionTitle>
      <Figures
        items={[
          { label: "Successful runs", value: formatNumber(sync.runs.success), note: `of ${formatNumber(sync.runs.total)} runs` },
          { label: "Partially successful", value: formatNumber(sync.runs.partialSuccess) },
          { label: "Failed runs", value: formatNumber(sync.runs.failed) },
          {
            label: "Records fetched",
            value: formatNumber(sync.records.fetched),
            note: `${formatNumber(sync.records.added)} added · ${formatNumber(sync.records.updated)} updated`,
          },
        ]}
      />
      <p className="mt-3 text-[13px] text-text-muted">
        Last successful run: {sync.lastSuccessfulRun ? formatDateTime(sync.lastSuccessfulRun.finishedAt ?? sync.lastSuccessfulRun.startedAt) : "none yet"}.
        Counters cover finished runs only. Run counts and the last run are full synchronizations; runs for professors’ new identities are listed in the run history, and their records are included in the record figures.
      </p>
    </section>
  );
}
