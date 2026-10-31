"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";
import { StatusChip } from "@/components/chips";
import { ConfirmDialog } from "@/components/dialog";
import { ProviderConfigurationPanel } from "@/components/providers";
import { Alert, Button, EmptyState, LoadError, PageHeader, Pagination, Panel, SectionTitle, SkeletonRows } from "@/components/ui";
import { api, ApiError, errorMessage, query } from "@/lib/api";
import { formatDateTime, formatNumber } from "@/lib/format";
import { useResource } from "@/lib/use-resource";
import type { Paged, SyncRun } from "@/lib/types";

/**
 * Synchronization (Project_plan.md §14, §17): publication discovery — manual trigger, provider
 * configuration and run history. Journal metrics (JCR) runs have their own page.
 */

const PAGE_SIZE = 20;

function Runs() {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const offset = Math.max(0, Number(params.get("offset")) || 0);
  const key = `/admin/sync/runs${query({ limit: PAGE_SIZE, offset })}`;
  const { data, error, reload } = useResource(key, (signal) => api<Paged & { runs: SyncRun[]; running: boolean }>(key, { signal }));
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const running = data?.running || data?.runs.some((r) => r.status === "RUNNING");

  // While a run is in progress the history refreshes itself (no push notifications).
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => void reload(), 5000);
    return () => clearInterval(timer);
  }, [running, reload]);

  async function start() {
    setBusy(true);
    setErr(null);
    try {
      const { run } = await api<{ run: SyncRun }>("/admin/sync", { method: "POST" });
      router.push(`/admin/sync/${run.id}`);
    } catch (e) {
      setErr(e instanceof ApiError && e.code === "SYNC_ALREADY_RUNNING" ? "A synchronization run is already in progress." : errorMessage(e));
      setBusy(false);
    }
  }

  return (
    <>
      <PageHeader
        title="Synchronization"
        description="Publications are collected monthly from OpenAlex, DBLP, ORCID, Scopus and Web of Science for every active identity of active professors. A failed source never deletes or changes existing data."
        actions={
          <Button variant="primary" icon={<RefreshCw aria-hidden size={18} />} onClick={() => setConfirming(true)} disabled={!!running}>
            Start synchronization
          </Button>
        }
      />
      <div className="flex flex-col gap-4">
        {running && (
          <Alert tone="info" role="status" title="Synchronization is running">
            The history below refreshes every few seconds.
          </Alert>
        )}
        <section aria-labelledby="providers-heading">
          <SectionTitle id="providers-heading">Publication sources</SectionTitle>
          <p className="mb-3 max-w-[72ch] text-[13px] leading-5 text-text-muted">
            Whether each source can be used. Credentials being set does not show that institutional access works; a run shows that once it succeeds. Journal
            metrics (JCR) are refreshed separately, under <Link href="/admin/journal-metrics" className="text-ink underline underline-offset-4">Journal metrics</Link>.
          </p>
          <ProviderConfigurationPanel purpose="PUBLICATION_DISCOVERY" />
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
            <EmptyState>No synchronization has run yet. The first monthly run starts automatically, or start one now.</EmptyState>
          ) : (
            <>
              <div className="overflow-x-auto">
                <table className="data-table">
                  <caption className="sr-only">Synchronization runs, newest first</caption>
                  <thead>
                    <tr>
                      <th scope="col">Started</th>
                      <th scope="col">Status</th>
                      <th scope="col" className="num">
                        Identities
                      </th>
                      <th scope="col" className="num">
                        Records fetched
                      </th>
                      <th scope="col" className="num">
                        New / updated
                      </th>
                      <th scope="col" className="num">
                        New links
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.runs.map((r) => (
                      <tr key={r.id}>
                        <td className="no-label md:min-w-[11rem]">
                          <Link href={`/admin/sync/${r.id}`} className="font-medium text-ink hover:underline underline-offset-4">
                            {formatDateTime(r.startedAt)}
                          </Link>
                          <p className="text-[13px] text-text-muted">{r.trigger === "MANUAL" ? "Manual run" : "Scheduled"}</p>
                        </td>
                        <td data-label="Status">
                          <StatusChip status={r.status} />
                        </td>
                        <td data-label="Identities" className="num">
                          {formatNumber(r.tasksSucceeded)} of {formatNumber(r.tasksTotal)} succeeded
                          {r.tasksFailed > 0 && <span className="block text-[13px] text-danger">{formatNumber(r.tasksFailed)} failed</span>}
                        </td>
                        <td data-label="Records fetched" className="num">
                          {formatNumber(r.recordsFetched)}
                        </td>
                        <td data-label="New / updated" className="num">
                          {formatNumber(r.recordsNew)} / {formatNumber(r.recordsUpdated)}
                        </td>
                        <td data-label="New links" className="num">
                          {formatNumber(r.linksCreated)}
                        </td>
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
        title="Start a synchronization run?"
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
          Every active identity of every active professor is fetched from its source, one after another. This can take several minutes; new publications appear
          as pending for their professors.
        </p>
      </ConfirmDialog>
    </>
  );
}

export default function SyncPage() {
  return (
    <Suspense fallback={<SkeletonRows rows={5} />}>
      <Runs />
    </Suspense>
  );
}
