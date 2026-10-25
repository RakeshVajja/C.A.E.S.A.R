"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { StatusChip } from "@/components/chips";
import { Alert, Figures, LoadError, PageHeader, Panel, SectionTitle, Skeleton } from "@/components/ui";
import { api, ApiError } from "@/lib/api";
import { formatDateTime, formatNumber, SOURCE_LABEL } from "@/lib/format";
import { useResource } from "@/lib/use-resource";
import type { SyncRun, SyncTask } from "@/lib/types";

/** One synchronization run with its per-identity tasks; polls while the run is in progress. */

const STATUS_PHRASE: Record<SyncRun["status"], string> = { RUNNING: "running", SUCCESS: "success", PARTIAL_SUCCESS: "partial success", FAILED: "failed" };

export default function SyncRunPage() {
  const { runId } = useParams<{ runId: string }>();
  const path = `/admin/sync/runs/${runId}`;
  const { data, error, reload } = useResource(path, (signal) => api<{ run: SyncRun & { tasks: SyncTask[] } }>(path, { signal }).then((r) => r.run));
  const [announcement, setAnnouncement] = useState("");
  const previous = useRef<SyncRun["status"] | null>(null);
  const running = data?.status === "RUNNING";

  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => void reload(), 3000);
    return () => clearInterval(timer);
  }, [running, reload]);

  useEffect(() => {
    if (!data) return;
    if (previous.current === "RUNNING" && data.status !== "RUNNING") {
      setAnnouncement(`Synchronization finished: ${STATUS_PHRASE[data.status]}`);
    }
    previous.current = data.status;
  }, [data]);

  const crumbs = [{ href: "/admin/sync", label: "Synchronization" }];
  if (error && !data) {
    return (
      <>
        <PageHeader title="Synchronization run" breadcrumbs={crumbs} />
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
  const finished = data.tasks.filter((t) => t.status === "SUCCESS" || t.status === "FAILED").length;

  return (
    <>
      <PageHeader
        title={`Run of ${formatDateTime(data.startedAt)}`}
        breadcrumbs={crumbs}
        description={`${data.trigger === "MANUAL" ? "Started by the administrator" : "Monthly schedule"}${data.finishedAt ? ` · finished ${formatDateTime(data.finishedAt)}` : ""}`}
        actions={<StatusChip status={data.status} />}
      />
      <p aria-live="polite" className="sr-only">
        {announcement}
      </p>
      <div className="flex flex-col gap-8">
        {running && (
          <Alert tone="info" title={`${formatNumber(finished)} of ${formatNumber(data.tasksTotal)} identities done`}>
            This page refreshes every few seconds until the run has finished.
          </Alert>
        )}
        <Figures
          items={[
            {
              label: "Identities",
              value: `${formatNumber(data.tasksSucceeded)}/${formatNumber(data.tasksTotal)}`,
              note: data.tasksFailed ? `${formatNumber(data.tasksFailed)} failed` : "succeeded",
            },
            { label: "Records fetched", value: formatNumber(data.recordsFetched) },
            { label: "New / updated", value: `${formatNumber(data.recordsNew)} / ${formatNumber(data.recordsUpdated)}`, note: "source records" },
            { label: "New links", value: formatNumber(data.linksCreated), note: `${formatNumber(data.candidatesCreated)} possible duplicates` },
          ]}
        />
        <section aria-labelledby="tasks-heading">
          <SectionTitle id="tasks-heading">Identities</SectionTitle>
          <Panel>
            {data.tasks.length === 0 ? (
              <p className="px-4 py-6 text-text-muted">This run had no active identities to synchronize.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="data-table">
                  <caption className="sr-only">Tasks of this run</caption>
                  <thead>
                    <tr>
                      <th scope="col">Professor and identity</th>
                      <th scope="col">Status</th>
                      <th scope="col" className="num">
                        Fetched
                      </th>
                      <th scope="col" className="num">
                        New / updated
                      </th>
                      <th scope="col" className="num">
                        Links
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.tasks.map((t) => (
                      <tr key={t.id}>
                        <td className="no-label min-w-[14rem]">
                          {t.identity ? (
                            <Link href={`/admin/professors/${t.identity.professor.id}`} className="text-ink hover:underline underline-offset-4">
                              {t.identity.professor.name}
                            </Link>
                          ) : (
                            <span className="text-text-muted">Identity removed</span>
                          )}
                          <p className="text-[13px] text-text-muted">
                            {SOURCE_LABEL[t.source]} {t.identity && <span className="font-mono">{t.identity.externalId}</span>}
                          </p>
                          {t.errorMessage && <p className="mt-1 text-[13px] text-danger [overflow-wrap:anywhere]">{t.errorMessage}</p>}
                          {t.warnings > 0 && <p className="mt-1 text-[13px] text-warning">{formatNumber(t.warnings)} records skipped (see the server log)</p>}
                        </td>
                        <td data-label="Status">
                          <StatusChip status={t.status} task />
                        </td>
                        <td data-label="Fetched" className="num">
                          {formatNumber(t.recordsFetched)}
                        </td>
                        <td data-label="New / updated" className="num">
                          {formatNumber(t.recordsNew)} / {formatNumber(t.recordsUpdated)}
                        </td>
                        <td data-label="Links" className="num">
                          {formatNumber(t.linksCreated)}
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
