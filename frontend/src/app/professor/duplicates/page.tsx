"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";
import { Ban, GitMerge } from "lucide-react";
import { refreshNavBadges } from "@/components/app-shell";
import { CuratedChip, SourceChips, StatusChip } from "@/components/chips";
import { ConfirmDialog } from "@/components/dialog";
import { useToast } from "@/components/toast";
import { Button, Doi, EmptyState, LoadError, PageHeader, Pagination, Panel, SkeletonRows } from "@/components/ui";
import { api, ApiError, errorMessage, query } from "@/lib/api";
import { formatDate, formatNumber, plural, TYPE_LABEL } from "@/lib/format";
import { useResource } from "@/lib/use-resource";
import type { Candidate, CandidatePublication, Paged } from "@/lib/types";

/**
 * Possible duplicates (Project_plan.md §8.5; decisions #149–#151): every open duplicate candidate in
 * which either publication is linked to the signed-in professor, in any status. Dismiss keeps both;
 * merge keeps the chosen publication and moves everything else into it, for every professor.
 */

const PAGE_SIZE = 20;
export const CANDIDATES_PATH = "/me/duplicate-candidates";

const CONFLICT: Record<string, string> = {
  SYNC_ALREADY_RUNNING: "A synchronization run is in progress. Merge when it has finished.",
  MERGE_CONFLICT: "The publications changed while the merge was being prepared. Try again.",
  CANDIDATE_NOT_OPEN: "This candidate was already resolved, possibly by another professor. The list has been refreshed.",
  CANDIDATE_NOT_FOUND: "This candidate no longer involves your publications. The list has been refreshed.",
  CANDIDATE_INCOMPLETE: "One of the publications no longer exists. Dismiss this candidate instead.",
};

const STATUS_NOTE: Record<CandidatePublication["status"], string> = {
  ACTIVE: "The merged publication stays active: visible in professors’ lists and analytics.",
  SUPPRESSED: "The merged publication stays suppressed: hidden from professors’ lists and analytics, including the links moved into it.",
};

type Pending = { candidate: Candidate; kind: "dismiss" } | { candidate: Candidate; kind: "merge"; keep: CandidatePublication; remove: CandidatePublication };

function CandidateList() {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const toast = useToast();
  const offset = Math.max(0, Number(params.get("offset")) || 0);
  const key = `${CANDIDATES_PATH}${query({ limit: PAGE_SIZE, offset })}`;
  const { data, error, reload } = useResource(key, (signal) => api<Paged & { candidates: Candidate[] }>(key, { signal }));
  const [pending, setPending] = useState<Pending | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const go = (next: { offset?: number }) => router.replace(`${pathname}${query({ offset: next.offset || undefined })}`, { scroll: false });

  async function apply() {
    if (!pending) return;
    setBusy(true);
    setErr(null);
    try {
      if (pending.kind === "dismiss") {
        await api(`${CANDIDATES_PATH}/${pending.candidate.id}/dismiss`, { method: "POST" });
        toast("Candidate dismissed. Both publications stay.");
      } else {
        const r = await api<{ merge: { sourceRecordsMoved: number; relationshipsMoved: number; relationshipsRemoved: number } }>(
          `${CANDIDATES_PATH}/${pending.candidate.id}/merge`,
          { method: "POST", body: { keepPublicationId: pending.keep.id } },
        );
        const { sourceRecordsMoved: records, relationshipsMoved: moved, relationshipsRemoved: combined } = r.merge;
        toast(
          `Merged. ${plural(records, "source record")} and ${plural(moved, "professor link")} moved${combined ? `; ${plural(combined, "professor")} linked to both kept one decision` : ""}.`,
        );
      }
      setPending(null);
      // A merge can also change the pending count (links move), so every badge is reloaded.
      refreshNavBadges();
      await reload();
    } catch (e) {
      setErr(e instanceof ApiError && CONFLICT[e.code] ? CONFLICT[e.code] : errorMessage(e));
      if (e instanceof ApiError && (e.code === "CANDIDATE_NOT_OPEN" || e.code === "CANDIDATE_NOT_FOUND")) {
        refreshNavBadges();
        void reload();
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      {error && !data ? (
        <LoadError error={error} onRetry={() => void reload()} />
      ) : !data ? (
        <Panel>
          <SkeletonRows rows={4} label="Loading possible duplicates" />
        </Panel>
      ) : data.candidates.length === 0 ? (
        <Panel>
          <EmptyState>No possible duplicates involve your publications. Uncertain matches found during synchronization or manual entry appear here.</EmptyState>
        </Panel>
      ) : (
        <>
          <p className="text-[13px] text-text-muted" role="status">
            {plural(data.total, "possible duplicate")} to resolve.
          </p>
          <ol className="flex flex-col gap-4">
            {data.candidates.map((c) => (
              <li key={c.id}>
                <Panel labelledBy={`cand-${c.id}`}>
                  <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-3">
                    <h2 id={`cand-${c.id}`} className="text-[15px] font-normal text-text-muted">
                      {c.reason}
                    </h2>
                    <p className="text-[13px] text-text-muted">Found {formatDate(c.createdAt)}</p>
                  </div>
                  <div className="grid md:grid-cols-2">
                    {[c.publicationA, c.publicationB].map((p, i) => (
                      <div key={p?.id ?? i} className={`flex flex-col gap-3 px-4 py-4 ${i === 1 ? "border-border max-md:border-t md:border-l" : ""}`}>
                        {p ? (
                          <>
                            <Side publication={p} />
                            {c.publicationA && c.publicationB && (
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
                  <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border px-4 py-3">
                    <p className="text-[13px] text-text-muted">Different papers? Dismiss to keep both.</p>
                    <Button compact variant="quiet" icon={<Ban aria-hidden size={16} />} onClick={() => setPending({ candidate: c, kind: "dismiss" })}>
                      Dismiss — not duplicates
                    </Button>
                  </div>
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
              The other publication is removed. Its source records and every professor’s links move to the kept one; a professor linked to both keeps
              one decision (approved before pending before rejected).
              {pending.keep.isCurated
                ? " The kept publication has curated details, which do not change."
                : " Its details are then recomputed from all source records."}
            </p>
            {pending.keep.status !== pending.remove.status && <p className="font-medium">{STATUS_NOTE[pending.keep.status]}</p>}
            <p className="text-[13px] text-text-muted">This cannot be undone. Not available while a synchronization run is in progress.</p>
          </>
        ) : (
          <p>Both publications stay separate, and this pair is not suggested again.</p>
        )}
      </ConfirmDialog>
    </div>
  );
}

function Side({ publication: p }: { publication: CandidatePublication }) {
  return (
    <div className="flex flex-col gap-1.5">
      <p className="font-serif text-base leading-6 font-medium">{p.title}</p>
      <dl className="grid grid-cols-[6rem_1fr] gap-x-3 gap-y-1 text-[13px] leading-5">
        <dt className="text-text-muted">Type</dt>
        <dd>{TYPE_LABEL[p.typeFamily]}</dd>
        <dt className="text-text-muted">Year</dt>
        <dd className="tabular-nums">{p.year ?? "Year unknown"}</dd>
        <dt className="text-text-muted">Venue</dt>
        <dd>{p.venue ?? "–"}</dd>
        <dt className="text-text-muted">Authors</dt>
        <dd>{p.authorNamesDisplay ?? "–"}</dd>
        <dt className="text-text-muted">DOI</dt>
        <dd>
          <Doi doi={p.doi} />
        </dd>
        <dt className="text-text-muted">Your link</dt>
        <dd>{p.myRelationshipStatus ? <StatusChip status={p.myRelationshipStatus} /> : "Not linked to you"}</dd>
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

export default function PossibleDuplicatesPage() {
  return (
    <>
      <PageHeader
        title="Possible duplicates"
        description="Publications that may be the same paper but were not merged automatically, because the evidence was not strong enough. Compare both, then keep one and merge, or dismiss if they are different papers. Your decision applies for every professor linked to them."
      />
      <Suspense fallback={<SkeletonRows rows={4} />}>
        <CandidateList />
      </Suspense>
    </>
  );
}
