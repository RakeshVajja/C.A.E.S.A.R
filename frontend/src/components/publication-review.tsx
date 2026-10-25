"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CircleCheck, CircleX, RefreshCw } from "lucide-react";
import { ConfirmDialog } from "./dialog";
import { SourceChips, StatusChip } from "./chips";
import { useToast } from "./toast";
import { Button, ButtonLink, Doi, EmptyState, LoadError, Pagination, Panel, Segmented, SkeletonRows } from "./ui";
import { api, ApiError, errorMessage, query } from "@/lib/api";
import { formatNumber, plural, TYPE_LABEL } from "@/lib/format";
import { useResource } from "@/lib/use-resource";
import type { OwnItem, OwnList, VerificationStatus } from "@/lib/types";

/**
 * The professor's publication relationships (Project_plan.md §11; pages/professor-verification.md).
 * Decisions use the expected current status (optimistic concurrency); a decided row stays in place
 * with its new status until the list is refreshed. Bulk approval covers PENDING rows only.
 */

const PAGE_SIZE = 50;
const BULK_MAX = 500; // backend limit per request
const CONFIRM_ABOVE = 50;
const STATUSES: VerificationStatus[] = ["PENDING", "APPROVED", "REJECTED"];
const STATUS_WORD: Record<VerificationStatus, string> = { PENDING: "Pending", APPROVED: "Approved", REJECTED: "Rejected" };

type RowNote = { tone: "danger" | "info"; text: string };

export function PublicationReview({ defaultStatus }: { defaultStatus: VerificationStatus }) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const toast = useToast();
  const status = (STATUSES as string[]).includes(params.get("status") ?? "") ? (params.get("status") as VerificationStatus) : defaultStatus;
  const offset = Math.max(0, Number(params.get("offset")) || 0);
  const key = `/me/publications${query({ status, limit: PAGE_SIZE, offset })}`;
  const { data, error, loading, reload, setData } = useResource<OwnList>(key, (signal) => api<OwnList>(key, { signal }));

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busyRow, setBusyRow] = useState<string | null>(null);
  const [notes, setNotes] = useState<Record<string, RowNote>>({});
  const [announcement, setAnnouncement] = useState("");
  const [bulk, setBulk] = useState<{ ids: string[]; all: boolean } | null>(null);
  const [bulkBusy, setBulkBusy] = useState(false);
  const [bulkError, setBulkError] = useState<string | null>(null);
  const [selectingAll, setSelectingAll] = useState(false);
  const headerBox = useRef<HTMLInputElement>(null);

  // A new page or filter starts with a clean selection.
  useEffect(() => {
    setSelected(new Set());
    setNotes({});
  }, [key]);

  const navigate = useCallback(
    (next: { status?: VerificationStatus; offset?: number }) => {
      const s = next.status ?? status;
      router.replace(`${pathname}${query({ status: s === defaultStatus ? undefined : s, offset: next.offset || undefined })}`, { scroll: false });
    },
    [router, pathname, status, defaultStatus],
  );

  const pendingOnPage = useMemo(() => (data?.items ?? []).filter((i) => i.status === "PENDING").map((i) => i.id), [data]);
  const allOnPageSelected = pendingOnPage.length > 0 && pendingOnPage.every((id) => selected.has(id));
  const someSelected = selected.size > 0 && !allOnPageSelected;
  useEffect(() => {
    if (headerBox.current) headerBox.current.indeterminate = someSelected;
  }, [someSelected]);

  async function decide(item: OwnItem, next: "APPROVED" | "REJECTED") {
    setBusyRow(item.id);
    setNotes((n) => {
      const next = { ...n };
      delete next[item.id];
      return next;
    });
    try {
      const { item: updated } = await api<{ item: OwnItem }>(`/me/publications/${item.id}`, {
        method: "PATCH",
        body: { status: next, expectedStatus: item.status },
      });
      replaceRow(updated, item.status);
      setAnnouncement(`${STATUS_WORD[updated.status]}: ${updated.publication.title}`);
    } catch (e) {
      if (e instanceof ApiError && e.code === "STATUS_CONFLICT") {
        const current = (e.details as { currentStatus?: VerificationStatus } | undefined)?.currentStatus;
        if (current) replaceRow({ ...item, status: current }, item.status);
        setNotes((n) => ({ ...n, [item.id]: { tone: "info", text: "This publication was already decided elsewhere. Its current status is shown." } }));
      } else if (e instanceof ApiError && e.code === "RELATIONSHIP_NOT_FOUND") {
        setNotes((n) => ({ ...n, [item.id]: { tone: "danger", text: "This publication is no longer available. Refresh the list." } }));
      } else {
        setNotes((n) => ({ ...n, [item.id]: { tone: "danger", text: errorMessage(e) } }));
      }
    } finally {
      setBusyRow(null);
    }
  }

  /** Shows the new status in place and keeps the status counts consistent with it. */
  function replaceRow(updated: OwnItem, previous: VerificationStatus) {
    setData((d) => {
      if (!d) return d;
      const counts = { ...d.counts };
      if (previous !== updated.status) {
        counts[previous] = Math.max(0, counts[previous] - 1);
        counts[updated.status] += 1;
      }
      return { ...d, counts, items: d.items.map((i) => (i.id === updated.id ? updated : i)) };
    });
    setSelected((s) => {
      if (!s.has(updated.id)) return s;
      const next = new Set(s);
      next.delete(updated.id);
      return next;
    });
  }

  async function selectAllPending() {
    setSelectingAll(true);
    try {
      const ids: string[] = [];
      for (let page = 0; ; page += 200) {
        const r = await api<OwnList>(`/me/publications${query({ status: "PENDING", limit: 200, offset: page })}`);
        ids.push(...r.items.map((i) => i.id));
        if (page + 200 >= r.total) break;
      }
      setSelected(new Set(ids));
    } catch (e) {
      toast(errorMessage(e), "danger");
    } finally {
      setSelectingAll(false);
    }
  }

  function startBulk() {
    const ids = [...selected];
    if (ids.length > CONFIRM_ABOVE) setBulk({ ids, all: false });
    else void runBulk(ids);
  }

  async function runBulk(ids: string[]) {
    setBulkBusy(true);
    setBulkError(null);
    let approved = 0;
    let skipped = 0;
    try {
      for (let i = 0; i < ids.length; i += BULK_MAX) {
        const r = await api<{ approved: number; skipped: number }>("/me/publications/approve", {
          method: "POST",
          body: { relationshipIds: ids.slice(i, i + BULK_MAX) },
        });
        approved += r.approved;
        skipped += r.skipped;
      }
      setBulk(null);
      setSelected(new Set());
      toast(`Approved ${plural(approved, "publication")}.${skipped ? ` ${formatNumber(skipped)} were already decided or are no longer available.` : ""}`);
      await reload();
    } catch (e) {
      if (approved) await reload();
      setBulkError(`${approved ? `${plural(approved, "publication")} were approved before the error. ` : ""}${errorMessage(e)}`);
      if (!bulk) toast(errorMessage(e), "danger");
    } finally {
      setBulkBusy(false);
    }
  }

  const counts = data?.counts;
  const totalPending = counts?.PENDING ?? 0;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Segmented
          label="Verification status"
          value={status}
          onChange={(s) => navigate({ status: s, offset: 0 })}
          options={STATUSES.map((s) => ({ value: s, label: STATUS_WORD[s], count: counts?.[s] }))}
        />
        <Button compact icon={<RefreshCw aria-hidden size={16} />} onClick={() => void reload()} loading={loading && !!data} loadingLabel="Refreshing…">
          Refresh
        </Button>
      </div>

      {selected.size > 0 && (
        <div className="sticky top-16 z-20 flex flex-wrap items-center gap-3 rounded-lg border border-ink bg-ink-subtle px-4 py-3 lg:top-2">
          <p className="font-medium tabular-nums">{plural(selected.size, "publication")} selected</p>
          <Button
            variant="primary"
            compact
            icon={<CircleCheck aria-hidden size={16} />}
            onClick={startBulk}
            loading={bulkBusy && !bulk}
            loadingLabel="Approving…"
          >
            Approve selected
          </Button>
          {status === "PENDING" && totalPending > selected.size && (
            <Button variant="quiet" compact onClick={() => void selectAllPending()} loading={selectingAll} loadingLabel="Selecting…">
              Select all {formatNumber(totalPending)} pending
            </Button>
          )}
          <Button variant="quiet" compact onClick={() => setSelected(new Set())}>
            Clear selection
          </Button>
        </div>
      )}

      <p aria-live="polite" className="sr-only">
        {announcement}
      </p>

      <Panel>
        {error && !data ? (
          <div className="p-4">
            <LoadError error={error} onRetry={() => void reload()} />
          </div>
        ) : !data ? (
          <SkeletonRows rows={6} label="Loading publications" />
        ) : data.items.length === 0 ? (
          <EmptyState action={status === "PENDING" ? <ButtonLink href="/professor/add">Add a publication manually</ButtonLink> : undefined}>
            {status === "PENDING"
              ? "You’re up to date. New publications appear here after the monthly synchronization."
              : status === "APPROVED"
                ? "No approved publications yet. Approve pending publications or add one manually."
                : "No rejected publications."}
          </EmptyState>
        ) : (
          <>
            {error && (
              <div className="p-4">
                <LoadError error={error} onRetry={() => void reload()} />
              </div>
            )}
            <div className="overflow-x-auto">
              <table className="data-table">
                <caption className="sr-only">
                  {STATUS_WORD[status]} publications, {data.total} in total
                </caption>
                <thead>
                  <tr>
                    <th scope="col" className="w-10">
                      {pendingOnPage.length > 0 && (
                        <input
                          ref={headerBox}
                          type="checkbox"
                          aria-label="Select all pending publications on this page"
                          checked={allOnPageSelected}
                          onChange={(e) =>
                            setSelected(
                              e.target.checked ? new Set([...selected, ...pendingOnPage]) : new Set([...selected].filter((id) => !pendingOnPage.includes(id))),
                            )
                          }
                          className="size-4 cursor-pointer accent-[var(--ink)]"
                        />
                      )}
                    </th>
                    <th scope="col">Title</th>
                    <th scope="col" className="max-lg:hidden">
                      Type
                    </th>
                    <th scope="col">Sources</th>
                    <th scope="col">Status</th>
                    <th scope="col">
                      <span className="sr-only">Actions</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {data.items.map((item) => (
                    <Row
                      key={item.id}
                      item={item}
                      selected={selected.has(item.id)}
                      onSelect={(checked) =>
                        setSelected((s) => {
                          const next = new Set(s);
                          if (checked) next.add(item.id);
                          else next.delete(item.id);
                          return next;
                        })
                      }
                      busy={busyRow === item.id}
                      note={notes[item.id]}
                      onDecide={(next) => void decide(item, next)}
                    />
                  ))}
                </tbody>
              </table>
            </div>
            <Pagination offset={data.offset} limit={data.limit} count={data.items.length} total={data.total} onPage={(o) => navigate({ offset: o })} />
          </>
        )}
      </Panel>

      <ConfirmDialog
        open={bulk !== null}
        title={`Approve ${plural(bulk?.ids.length ?? 0, "publication")}?`}
        confirmLabel="Approve"
        busyLabel="Approving…"
        busy={bulkBusy}
        error={bulkError}
        onClose={() => {
          setBulk(null);
          setBulkError(null);
        }}
        onConfirm={() => bulk && void runBulk(bulk.ids)}
      >
        <p>They will appear in your verified publication list. You can change any decision later.</p>
      </ConfirmDialog>
    </div>
  );
}

function Row({
  item,
  selected,
  onSelect,
  busy,
  note,
  onDecide,
}: {
  item: OwnItem;
  selected: boolean;
  onSelect: (checked: boolean) => void;
  busy: boolean;
  note?: RowNote;
  onDecide: (next: "APPROVED" | "REJECTED") => void;
}) {
  const p = item.publication;
  const meta = [p.authorNamesDisplay, p.venue, p.year ?? "Year unknown"].filter(Boolean).join(" · ");
  const type = TYPE_LABEL[p.typeFamily];
  return (
    <tr data-selected={selected || undefined}>
      <td className="no-label w-10">
        {item.status === "PENDING" && (
          <input
            type="checkbox"
            checked={selected}
            onChange={(e) => onSelect(e.target.checked)}
            aria-label={`Select “${p.title}”`}
            className="size-4 cursor-pointer accent-[var(--ink)] max-md:size-5"
          />
        )}
      </td>
      <td className="no-label min-w-[16rem]">
        <p className="font-serif text-base leading-6 font-medium">{p.title}</p>
        <p className="mt-0.5 line-clamp-2 text-[13px] leading-5 text-text-muted" title={meta}>
          <span className="lg:hidden">{type} · </span>
          {meta}
        </p>
        {p.doi && (
          <p className="mt-1">
            <Doi doi={p.doi} />
          </p>
        )}
        {item.origin === "MANUAL" && <p className="mt-1 text-[13px] text-text-muted">Added by you</p>}
        {note && (
          <p role="status" className={`mt-2 text-[13px] ${note.tone === "danger" ? "text-danger" : "text-info"}`}>
            {note.text}
          </p>
        )}
      </td>
      <td data-label="Type" className="text-[13px] whitespace-nowrap max-lg:hidden">
        {TYPE_LABEL[p.typeFamily]}
      </td>
      <td data-label="Sources">
        <SourceChips sources={p.sources} />
      </td>
      <td data-label="Status">
        <StatusChip status={item.status} />
      </td>
      <td className="no-label md:w-px">
        <div className="flex gap-1 whitespace-nowrap md:items-stretch max-lg:md:flex-col lg:justify-end max-md:mt-2 max-md:flex-wrap max-md:gap-2">
          {item.status !== "APPROVED" && (
            <Button
              variant={item.status === "PENDING" ? "secondary" : "quiet"}
              compact
              icon={<CircleCheck aria-hidden size={16} />}
              disabled={busy}
              onClick={() => onDecide("APPROVED")}
              className="max-md:flex-1"
            >
              {item.status === "PENDING" ? "Approve" : "Change to approved"}
            </Button>
          )}
          {item.status !== "REJECTED" && (
            <Button
              variant={item.status === "PENDING" ? "secondary" : "quiet"}
              compact
              icon={<CircleX aria-hidden size={16} />}
              disabled={busy}
              onClick={() => onDecide("REJECTED")}
              className="max-md:flex-1"
            >
              {item.status === "PENDING" ? "Reject" : "Change to rejected"}
            </Button>
          )}
        </div>
      </td>
    </tr>
  );
}
