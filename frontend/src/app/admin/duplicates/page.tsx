"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";
import { Ban, GitMerge } from "lucide-react";
import { CuratedChip, SourceChips, StatusChip } from "@/components/chips";
import { ConfirmDialog } from "@/components/dialog";
import { useToast } from "@/components/toast";
import { Button, Doi, EmptyState, LoadError, PageHeader, Pagination, Panel, Segmented, SkeletonRows } from "@/components/ui";
import { api, ApiError, errorMessage, query } from "@/lib/api";
import { formatDate, formatNumber, plural, TYPE_LABEL } from "@/lib/format";
import { useResource } from "@/lib/use-resource";
import type { Candidate, CandidateStatus, Paged, PublicationSummary } from "@/lib/types";

/**
 * Duplicate candidates (Project_plan.md §8.5): possible duplicates the matching engine deliberately
 * did not merge. Dismiss keeps both; merge keeps the chosen publication and moves everything else into it.
 */

const PAGE_SIZE = 20;
const STATUSES: CandidateStatus[] = ["OPEN", "MERGED", "DISMISSED"];
const LABEL: Record<CandidateStatus, string> = { OPEN: "Open", MERGED: "Merged", DISMISSED: "Dismissed" };

const CONFLICT: Record<string, string> = {
  SYNC_ALREADY_RUNNING: "A synchronization run is in progress. Merge when it has finished.",
  MERGE_STATUS_MISMATCH: "An active and a suppressed publication cannot be merged. Restore or suppress one of them first.",
  MERGE_CONFLICT: "The publications changed while the merge was being prepared. Try again.",
  CANDIDATE_NOT_OPEN: "This candidate was already resolved. Refresh the list.",
  CANDIDATE_INCOMPLETE: "One of the publications no longer exists. Dismiss this candidate instead.",
};

type Pending = { candidate: Candidate; kind: "dismiss" } | { candidate: Candidate; kind: "merge"; keep: PublicationSummary; remove: PublicationSummary };

function CandidateList() {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const toast = useToast();
  const status = (STATUSES as string[]).includes(params.get("status") ?? "") ? (params.get("status") as CandidateStatus) : "OPEN";
  const offset = Math.max(0, Number(params.get("offset")) || 0);
  const key = `/admin/duplicate-candidates${query({ status, limit: PAGE_SIZE, offset })}`;
  const { data, error, reload } = useResource(key, (signal) => api<Paged & { candidates: Candidate[] }>(key, { signal }));
  const [pending, setPending] = useState<Pending | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const go = (next: { status?: CandidateStatus; offset?: number }) => {
    const s = next.status ?? status;
    router.replace(`${pathname}${query({ status: s === "OPEN" ? undefined : s, offset: next.offset || undefined })}`, { scroll: false });
  };

  async function apply() {
    if (!pending) return;
    setBusy(true);
    setErr(null);
    try {
      if (pending.kind === "dismiss") {
        await api(`/admin/duplicate-candidates/${pending.candidate.id}/dismiss`, { method: "POST" });
        toast("Candidate dismissed. Both publications stay.");
      } else {
        const r = await api<{ merge: { sourceRecordsMoved: number; relationshipsMoved: number; relationshipsRemoved: number } }>(
          `/admin/duplicate-candidates/${pending.candidate.id}/merge`,
          {
            method: "POST",
            body: { keepPublicationId: pending.keep.id },
          },
        );
        const { sourceRecordsMoved: records, relationshipsMoved: moved, relationshipsRemoved: combined } = r.merge;
        toast(
          `Merged. ${plural(records, "source record")} and ${plural(moved, "professor link")} moved${combined ? `; ${plural(combined, "professor")} linked to both kept one decision` : ""}.`,
        );
      }
      setPending(null);
      await reload();
    } catch (e) {
      setErr(e instanceof ApiError && CONFLICT[e.code] ? CONFLICT[e.code] : errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <div>
        <Segmented
          label="Candidate status"
          value={status}
          onChange={(s) => go({ status: s, offset: 0 })}
          options={STATUSES.map((s) => ({ value: s, label: LABEL[s], count: s === status ? data?.total : undefined }))}
        />
      </div>
      {error && !data ? (
        <LoadError error={error} onRetry={() => void reload()} />
      ) : !data ? (
        <Panel>
          <SkeletonRows rows={4} label="Loading candidates" />
        </Panel>
      ) : data.candidates.length === 0 ? (
        <Panel>
          <EmptyState>
            {status === "OPEN"
              ? "No open candidates. Uncertain matches found during synchronization or manual entry appear here."
              : `No ${LABEL[status].toLowerCase()} candidates.`}
          </EmptyState>
        </Panel>
      ) : (
        <>
          <ol className="flex flex-col gap-4">
            {data.candidates.map((c) => (
              <li key={c.id}>
                <Panel labelledBy={`cand-${c.id}`}>
                  <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-3">
                    <h2 id={`cand-${c.id}`} className="flex flex-wrap items-center gap-2 text-[15px] font-semibold">
                      <StatusChip status={c.status} />
                      <span className="font-normal text-text-muted">{c.reason}</span>
                    </h2>
                    <p className="text-[13px] text-text-muted">
                      {c.status === "OPEN" ? `Found ${formatDate(c.createdAt)}` : `Resolved ${formatDate(c.resolvedAt)}`}
                    </p>
                  </div>
                  <div className="grid md:grid-cols-2">
                    {[c.publicationA, c.publicationB].map((p, i) => (
                      <div key={p?.id ?? i} className={`flex flex-col gap-3 px-4 py-4 ${i === 1 ? "border-border max-md:border-t md:border-l" : ""}`}>
                        {p ? (
                          <>
                            <Side publication={p} />
                            {c.status === "OPEN" && c.publicationA && c.publicationB && (
                              <div>
                                <Button
                                  compact
                                  icon={<GitMerge aria-hidden size={16} />}
                                  onClick={() => setPending({ candidate: c, kind: "merge", keep: p, remove: (i === 0 ? c.publicationB : c.publicationA)! })}
                                >
                                  Keep this one and merge
                                </Button>
                              </div>
                            )}
                          </>
                        ) : (
                          <p className="text-text-muted">This publication was merged away.</p>
                        )}
                      </div>
                    ))}
                  </div>
                  {c.status === "OPEN" && (
                    <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border px-4 py-3">
                      <p className="text-[13px] text-text-muted">Different papers? Dismiss to keep both.</p>
                      <Button compact variant="quiet" icon={<Ban aria-hidden size={16} />} onClick={() => setPending({ candidate: c, kind: "dismiss" })}>
                        Dismiss — not duplicates
                      </Button>
                    </div>
                  )}
                </Panel>
              </li>
            ))}
          </ol>
          <Panel>
            <Pagination offset={data.offset} limit={data.limit} count={data.candidates.length} total={data.total} onPage={(o) => go({ offset: o })} />
          </Panel>
        </>
      )}

      <ConfirmDialog
        open={pending !== null}
        title={pending?.kind === "merge" ? "Merge these publications?" : "Dismiss this candidate?"}
        confirmLabel={pending?.kind === "merge" ? "Merge" : "Dismiss"}
        busyLabel={pending?.kind === "merge" ? "Merging…" : "Dismissing…"}
        busy={busy}
        error={err}
        onConfirm={() => void apply()}
        onClose={() => {
          setPending(null);
          setErr(null);
        }}
      >
        {pending?.kind === "merge" ? (
          <>
            <p>
              Keep <span className="font-serif font-medium">{pending.keep.title}</span> ({pending.keep.year ?? "year unknown"},{" "}
              {TYPE_LABEL[pending.keep.typeFamily]}).
            </p>
            <p>
              The other publication is removed. Its source records and professor links move to the kept one; a professor linked to both keeps one decision
              (approved before pending before rejected).
              {pending.keep.isCurated
                ? " The kept publication is curated, so its metadata does not change."
                : " Its metadata is then recomputed from all source records."}
            </p>
            <p className="text-[13px] text-text-muted">This cannot be undone. Not available while a synchronization run is in progress.</p>
          </>
        ) : (
          <p>Both publications stay separate, and this pair is not suggested again.</p>
        )}
      </ConfirmDialog>
    </div>
  );
}

function Side({ publication: p }: { publication: PublicationSummary }) {
  return (
    <div className="flex flex-col gap-1.5">
      <Link href={`/admin/publications/${p.id}`} className="font-serif text-base leading-6 font-medium text-ink hover:underline underline-offset-4">
        {p.title}
      </Link>
      <dl className="grid grid-cols-[6rem_1fr] gap-x-3 gap-y-1 text-[13px] leading-5">
        <dt className="text-text-muted">Type</dt>
        <dd>{TYPE_LABEL[p.typeFamily]}</dd>
        <dt className="text-text-muted">Year</dt>
        <dd className="tabular-nums">{p.year ?? "Year unknown"}</dd>
        <dt className="text-text-muted">Venue</dt>
        <dd>{p.venue ?? "–"}</dd>
        <dt className="text-text-muted">DOI</dt>
        <dd>
          <Doi doi={p.doi} />
        </dd>
        <dt className="text-text-muted">Professors</dt>
        <dd>
          {formatNumber(p.relationshipCounts.approved)} approved · {formatNumber(p.relationshipCounts.pending)} pending ·{" "}
          {formatNumber(p.relationshipCounts.rejected)} rejected
        </dd>
      </dl>
      <div className="flex flex-wrap items-center gap-1">
        <SourceChips sources={p.sources} />
        {p.status === "SUPPRESSED" && <StatusChip status="SUPPRESSED" />}
        {p.isCurated && <CuratedChip />}
      </div>
    </div>
  );
}

export default function DuplicatesPage() {
  return (
    <>
      <PageHeader
        title="Duplicate candidates"
        description="Possible duplicates that were not merged automatically because the evidence was not strong enough. Compare both publications, then merge them or dismiss the candidate."
      />
      <Suspense fallback={<SkeletonRows rows={4} />}>
        <CandidateList />
      </Suspense>
    </>
  );
}
