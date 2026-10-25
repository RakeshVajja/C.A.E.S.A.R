"use client";

import Link from "next/link";
import { ChartColumn, GitMerge, RefreshCw, Users } from "lucide-react";
import { StatusChip } from "@/components/chips";
import { Figures, LoadError, PageHeader, Panel, SectionTitle, Skeleton } from "@/components/ui";
import { api } from "@/lib/api";
import { formatDateTime, formatNumber } from "@/lib/format";
import { useResource } from "@/lib/use-resource";
import type { Overview } from "@/lib/types";

/** Administrator dashboard: the overview figures and the work waiting for the administrator. */
export default function AdminDashboard() {
  const { data, error, reload } = useResource("admin-dashboard", (signal) =>
    Promise.all([
      api<{ overview: Overview }>("/admin/analytics/overview", { signal }).then((r) => r.overview),
      api<{ total: number }>("/admin/duplicate-candidates?status=OPEN&limit=1", { signal }).then((r) => r.total),
    ]),
  );
  const [overview, openCandidates] = data ?? [null, null];

  const tasks = [
    {
      href: "/admin/duplicates",
      Icon: GitMerge,
      label: "Duplicate candidates",
      text:
        openCandidates === null
          ? "…"
          : openCandidates === 0
            ? "No open candidates."
            : `${formatNumber(openCandidates)} possible duplicates wait for a decision.`,
    },
    { href: "/admin/professors", Icon: Users, label: "Professors and identities", text: "Add professors, create accounts and verify external identities." },
    {
      href: "/admin/sync",
      Icon: RefreshCw,
      label: "Synchronization",
      text: overview?.syncRunning ? "A synchronization run is in progress." : "Runs monthly; start one manually when needed.",
    },
    { href: "/admin/analytics", Icon: ChartColumn, label: "Analytics", text: "Publications per professor, per year and per source." },
  ];

  return (
    <>
      <PageHeader title="Dashboard" description="Department-wide state of the publication register." />
      {error && !data ? (
        <LoadError error={error} onRetry={() => void reload()} />
      ) : (
        <div className="flex flex-col gap-8">
          {!overview ? (
            <Skeleton className="h-28 w-full" />
          ) : (
            <Figures
              items={[
                { label: "Professors", value: formatNumber(overview.professors.active), note: `active of ${formatNumber(overview.professors.total)}` },
                { label: "Unique publications", value: formatNumber(overview.uniquePublications), note: "Approved, not suppressed, not preprints" },
                { label: "Pending verifications", value: formatNumber(overview.pendingVerifications), note: "Waiting for professors" },
                {
                  label: "Last synchronization",
                  value: (
                    <span className="text-[15px] leading-6 font-medium">
                      {overview.lastSync ? formatDateTime(overview.lastSync.finishedAt ?? overview.lastSync.startedAt) : "Never"}
                    </span>
                  ),
                  note: overview.lastSync ? <StatusChip status={overview.lastSync.status} /> : undefined,
                },
              ]}
            />
          )}
          <section aria-labelledby="work">
            <SectionTitle id="work">Work areas</SectionTitle>
            <Panel>
              <ul className="divide-y divide-border">
                {tasks.map(({ href, Icon, label, text }) => (
                  <li key={href}>
                    <Link href={href} className="flex items-start gap-3 px-4 py-4 hover:bg-canvas">
                      <Icon aria-hidden size={20} strokeWidth={1.75} className="mt-0.5 shrink-0 text-ink" />
                      <span>
                        <span className="block font-medium text-ink">{label}</span>
                        <span className="block text-[13px] leading-5 text-text-muted">{text}</span>
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            </Panel>
          </section>
        </div>
      )}
    </>
  );
}
