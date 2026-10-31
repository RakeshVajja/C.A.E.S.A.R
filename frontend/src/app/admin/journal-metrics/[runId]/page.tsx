"use client";

import { useParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { StatusChip } from "@/components/chips";
import { Alert, Figures, LoadError, PageHeader, Panel, SectionTitle, Skeleton } from "@/components/ui";
import { api, ApiError } from "@/lib/api";
import { formatDate, formatDateTime, formatNumber, plural } from "@/lib/format";
import { useResource } from "@/lib/use-resource";
import type { JournalMetricsRun, JournalMetricsTask } from "@/lib/types";

/** One journal metrics (JCR) run with its per-journal tasks — status and counters, no metric values. */

const STATUS_PHRASE: Record<JournalMetricsRun["status"], string> = { RUNNING: "running", SUCCESS: "success", PARTIAL_SUCCESS: "partial success", FAILED: "failed" };

export default function JournalMetricsRunPage() {
  const { runId } = useParams<{ runId: string }>();
  const path = `/admin/sync/journal-metrics/runs/${runId}`;
  const { data, error, reload } = useResource(path, (signal) => api<{ run: JournalMetricsRun & { tasks: JournalMetricsTask[] } }>(path, { signal }).then((r) => r.run));
  const [announcement, setAnnouncement] = useState("");
  const previous = useRef<JournalMetricsRun["status"] | null>(null);
  const running = data?.status === "RUNNING";

  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => void reload(), 3000);
    return () => clearInterval(timer);
  }, [running, reload]);

  useEffect(() => {
    if (!data) return;
    if (previous.current === "RUNNING" && data.status !== "RUNNING") setAnnouncement(`Journal metrics run finished: ${STATUS_PHRASE[data.status]}`);
    previous.current = data.status;
  }, [data]);

  const crumbs = [{ href: "/admin/journal-metrics", label: "Journal metrics" }];
  if (error && !data) {
    return (
      <>
        <PageHeader title="Journal metrics run" breadcrumbs={crumbs} />
        <LoadError error={error} onRetry={error instanceof ApiError && error.status === 404 ? undefined : () => void reload()} />
      </>
    );
  }
  if (!data) {
    return (
      <div role="status" aria-label="Loading run" className="flex flex-col gap-4">
        <Skeleton className="h-9 w-72" />
        <Skeleton className="h-28 w-full" />
      </div>
    );
  }

  return (
    <>
      <PageHeader
        title={`Run of ${formatDateTime(data.startedAt)}`}
        breadcrumbs={crumbs}
        description={`${data.trigger === "MANUAL" ? "Started by the administrator" : "Scheduled"}${data.finishedAt ? ` · finished ${formatDateTime(data.finishedAt)}` : ""}`}
        actions={<StatusChip status={data.status} />}
      />
      <p aria-live="polite" className="sr-only">
        {announcement}
      </p>
      <div className="flex flex-col gap-8">
        {running && <Alert tone="info">This page refreshes every few seconds until the run has finished.</Alert>}
        {!running && data.status !== "SUCCESS" && data.tasks.length === 0 && (
          <Alert tone="warning" title="No journal was refreshed">
            {data.status === "PARTIAL_SUCCESS"
              ? "Journal Citation Reports is not configured, so nothing could be attempted."
              : "Journals could not be identified (for example, the JCR credentials were refused). Details are in the server log."}
          </Alert>
        )}
        <Figures
          items={[
            { label: "Journals refreshed", value: `${formatNumber(data.journalsChecked)}/${formatNumber(data.tasksTotal)}`, note: data.tasksFailed ? `${formatNumber(data.tasksFailed)} failed` : undefined },
            { label: "New snapshots", value: formatNumber(data.snapshotsAdded), note: "unchanged reports add none" },
            { label: "JCR data date", value: data.jcrDataUpdate ? formatDate(data.jcrDataUpdate) : "–" },
          ]}
        />
        <section aria-labelledby="journal-tasks-heading">
          <SectionTitle id="journal-tasks-heading">Journals</SectionTitle>
          <Panel>
            {data.tasks.length === 0 ? (
              <p className="px-4 py-6 text-text-muted">This run had no journal to refresh.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="data-table">
                  <caption className="sr-only">Journals of this run</caption>
                  <thead>
                    <tr>
                      <th scope="col">Journal</th>
                      <th scope="col">Status</th>
                      <th scope="col" className="num">
                        Reports
                      </th>
                      <th scope="col" className="num">
                        New snapshots
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.tasks.map((t) => (
                      <tr key={t.id}>
                        <td className="no-label min-w-[14rem]">
                          {t.journal ? <span className="font-medium">{t.journal.name}</span> : <span className="text-text-muted">Journal removed</span>}
                          {t.journal && <p className="font-mono text-[13px] text-text-muted">{t.journal.jcrId}</p>}
                          {t.errorMessage && <p className="mt-1 text-[13px] text-danger [overflow-wrap:anywhere]">{t.errorMessage}</p>}
                          {t.warnings > 0 && <p className="mt-1 text-[13px] text-warning">{plural(t.warnings, "warning")} (unavailable reports or unfamiliar editions)</p>}
                        </td>
                        <td data-label="Status">
                          <StatusChip status={t.status} task />
                        </td>
                        <td data-label="Reports" className="num">
                          {formatNumber(t.recordsFetched)}
                        </td>
                        <td data-label="New snapshots" className="num">
                          {formatNumber(t.snapshotsAdded)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Panel>
        </section>
      </div>
    </>
  );
}
