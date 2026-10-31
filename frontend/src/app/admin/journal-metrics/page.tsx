"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";
import { StatusChip } from "@/components/chips";
import { ConfirmDialog } from "@/components/dialog";
import { PROVIDERS_PATH, ProviderConfigurationPanel } from "@/components/providers";
import { Alert, Button, EmptyState, LoadError, PageHeader, Pagination, Panel, SectionTitle, SkeletonRows } from "@/components/ui";
import { api, ApiError, errorMessage, query } from "@/lib/api";
import { formatDate, formatDateTime, formatNumber } from "@/lib/format";
import { useResource } from "@/lib/use-resource";
import type { JournalMetricsRun, Paged, ProviderStatusResponse } from "@/lib/types";

/**
 * Journal metrics (Project_plan.md §13.8, §17; decision #123): Journal Citation Reports refreshes,
 * separate from publication discovery. Status and counters only — JCR metric values are not shown
 * until Clarivate's written confirmation (§13.10, #114).
 */

const PAGE_SIZE = 20;

function Runs() {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const offset = Math.max(0, Number(params.get("offset")) || 0);
  const key = `/admin/sync/journal-metrics/runs${query({ limit: PAGE_SIZE, offset })}`;
  const { data, error, reload } = useResource(key, (signal) => api<Paged & { runs: JournalMetricsRun[]; running: boolean }>(key, { signal }));
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const running = data?.running || data?.runs.some((r) => r.status === "RUNNING");
  // The backend refuses every JCR run while the Clarivate gate is closed; the page says why.
  const gate = useResource(PROVIDERS_PATH, (signal) => api<ProviderStatusResponse>(PROVIDERS_PATH, { signal })).data?.clarivateGate;
  const blocked = gate ? !gate.open : true;

  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => void reload(), 5000);
    return () => clearInterval(timer);
  }, [running, reload]);

  async function start() {
    setBusy(true);
    setErr(null);
    try {
      const { run } = await api<{ run: JournalMetricsRun }>("/admin/sync/journal-metrics", { method: "POST" });
      router.push(`/admin/journal-metrics/${run.id}`);
    } catch (e) {
      setErr(
        e instanceof ApiError && e.code === "SYNC_ALREADY_RUNNING"
          ? "A synchronization or journal metrics run is already in progress."
          : e instanceof ApiError && e.code === "CLARIVATE_GATE_CLOSED"
            ? "Journal metrics cannot be refreshed yet: live Clarivate data is blocked."
            : errorMessage(e),
      );
      setBusy(false);
    }
  }

  return (
    <>
      <PageHeader
        title="Journal metrics"
        description="Journal Citation Reports data is refreshed for the journals of stored publications, monthly and after synchronizations that add records. It never changes publications, and its runs are reported here, not under Synchronization."
        actions={
          <Button variant="primary" icon={<RefreshCw aria-hidden size={18} />} onClick={() => setConfirming(true)} disabled={!!running || blocked}>
            Refresh journal metrics
          </Button>
        }
      />
      <div className="flex flex-col gap-4">
        {blocked && (
          <Alert tone="warning" title="Refreshing journal metrics is not available yet">
            Live Journal Citation Reports data may only be requested once Clarivate&apos;s written confirmations on retention, deletion, backups and display
            are on record (the provider-data removal tool is complete). Until then the server refuses every refresh — manual, scheduled or after a
            synchronization — and sends no request to Clarivate.
          </Alert>
        )}
        <Alert tone="info" title="Metric values are not displayed">
          Journal metrics are stored for later use, but are shown only once Clarivate&apos;s written confirmation of the permitted display is on record.
        </Alert>
        {running && (
          <Alert tone="info" role="status" title="A run is in progress">
            The history below refreshes every few seconds.
          </Alert>
        )}
        <section aria-labelledby="jcr-provider-heading">
          <SectionTitle id="jcr-provider-heading">Configuration</SectionTitle>
          <ProviderConfigurationPanel purpose="JOURNAL_METRICS" />
        </section>
        <SectionTitle>Runs</SectionTitle>
        <Panel>
          {error && !data ? (
            <div className="p-4">
              <LoadError error={error} onRetry={() => void reload()} />
            </div>
          ) : !data ? (
            <SkeletonRows rows={5} label="Loading runs" />
          ) : data.runs.length === 0 ? (
            <EmptyState>No journal metrics refresh has run yet.</EmptyState>
          ) : (
            <>
              <div className="overflow-x-auto">
                <table className="data-table">
                  <caption className="sr-only">Journal metrics runs, newest first</caption>
                  <thead>
                    <tr>
                      <th scope="col">Started</th>
                      <th scope="col">Status</th>
                      <th scope="col" className="num">
                        Journals
                      </th>
                      <th scope="col" className="num">
                        New snapshots
                      </th>
                      <th scope="col">JCR data date</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.runs.map((r) => (
                      <tr key={r.id}>
                        <td className="no-label md:min-w-[11rem]">
                          <Link href={`/admin/journal-metrics/${r.id}`} className="font-medium text-ink hover:underline underline-offset-4">
                            {formatDateTime(r.startedAt)}
                          </Link>
                          <p className="text-[13px] text-text-muted">{r.trigger === "MANUAL" ? "Manual run" : "Scheduled"}</p>
                        </td>
                        <td data-label="Status">
                          <StatusChip status={r.status} />
                        </td>
                        <td data-label="Journals" className="num">
                          {formatNumber(r.journalsChecked)} of {formatNumber(r.tasksTotal)} refreshed
                          {r.tasksFailed > 0 && <span className="block text-[13px] text-danger">{formatNumber(r.tasksFailed)} failed</span>}
                        </td>
                        <td data-label="New snapshots" className="num">
                          {formatNumber(r.snapshotsAdded)}
                        </td>
                        <td data-label="JCR data date">{r.jcrDataUpdate ? formatDate(r.jcrDataUpdate) : "–"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <Pagination
                offset={data.offset}
                limit={data.limit}
                count={data.runs.length}
                total={data.total}
                onPage={(o) => router.replace(`${pathname}${query({ offset: o || undefined })}`, { scroll: false })}
              />
            </>
          )}
        </Panel>
      </div>
      <ConfirmDialog
        open={confirming}
        title="Refresh journal metrics?"
        confirmLabel="Start"
        busyLabel="Starting…"
        busy={busy}
        error={err}
        onConfirm={() => void start()}
        onClose={() => {
          setConfirming(false);
          setErr(null);
        }}
      >
        <p>
          Journals are identified from the publications&apos; ISSNs, and their Journal Citation Reports are checked one journal at a time. Publications are not
          changed. Without JCR credentials the run only records that it could not be attempted.
        </p>
      </ConfirmDialog>
    </>
  );
}

export default function JournalMetricsPage() {
  return (
    <Suspense fallback={<SkeletonRows rows={5} />}>
      <Runs />
    </Suspense>
  );
}
