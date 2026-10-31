"use client";

import Link from "next/link";
import { useState } from "react";
import { SourceChip, StatusChip } from "@/components/chips";
import { EmptyState, Figures, LoadError, PageHeader, Panel, SectionTitle, Segmented, Skeleton } from "@/components/ui";
import { api } from "@/lib/api";
import { formatDate, formatDateTime, formatNumber, SOURCE_LABEL, TYPE_LABEL } from "@/lib/format";
import { useResource } from "@/lib/use-resource";
import type { ByYear, CitationStats, Overview, PerProfessor, SourceStats, SyncStats } from "@/lib/types";

/**
 * Administrator analytics (Project_plan.md §16; pages/admin-analytics.md). Every figure comes from
 * the backend's analytics endpoints; nothing is recomputed here. Charts are plain HTML with a
 * table view, hover/focus values and no animation.
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

export default function AnalyticsPage() {
  const { data, error, reload } = useResource("analytics", load);

  return (
    <>
      <PageHeader
        title="Analytics"
        description="Counted publications are approved by at least one professor, not suppressed and not preprints. Each publication counts once, however many professors or sources report it."
      />
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
        Counters cover finished runs only.
      </p>
    </section>
  );
}
