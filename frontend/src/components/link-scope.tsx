"use client";

import { useId, useMemo, useState } from "react";
import { X } from "lucide-react";
import { StatusChip } from "./chips";
import { Segmented } from "./ui";
import type { LinkDraft, LinkMode, QueryFieldsResponse } from "@/lib/query-builder";
import type { ProfessorRow } from "@/lib/types";

/**
 * The administrator's link scope (Project_plan.md §24.5; stage Q3): which professor relationships
 * a publication needs to match. A qualifying link is one relationship row whose status, origin and
 * decision date all match — on the same row. The server validates the scope again (modes,
 * statuses, at most 50 existing professors) and builds the database filter; nothing here is trusted.
 */

const MODE_LABEL: Record<LinkMode, string> = {
  ANY_PROFESSOR: "Any professor",
  SELECTED: "Selected professors",
  NO_LINK: "No professor link",
  ALL_PUBLICATIONS: "All publications",
};
const MODE_HINT: Record<LinkMode, string> = {
  ANY_PROFESSOR: "Publications with a qualifying link of any professor, active or inactive (the department-wide population).",
  SELECTED: "Publications with qualifying links of the selected professors.",
  NO_LINK: "Publications without any professor relationship of any status (approved, pending or rejected).",
  ALL_PUBLICATIONS: "Every publication, linked or not. Relationship conditions only mark which links qualify.",
};
const STATUS_LABEL: Record<string, string> = { APPROVED: "Approved", PENDING: "Pending", REJECTED: "Rejected" };
const ORIGIN_LABEL: Record<string, string> = { DISCOVERED: "Found by synchronization", MANUAL: "Added by the professor", ADMIN: "Added by an administrator" };

export function LinkScopeEditor({
  draft,
  onChange,
  options,
  professors,
  professorsError,
  issue,
}: {
  draft: LinkDraft;
  onChange: (draft: LinkDraft) => void;
  options: NonNullable<QueryFieldsResponse["link"]>;
  professors: ProfessorRow[] | null;
  professorsError: unknown;
  issue: string | null;
}) {
  const id = useId();
  const set = (change: Partial<LinkDraft>) => onChange({ ...draft, ...change });
  const toggle = (list: string[], value: string, on: boolean) => (on ? [...list, value] : list.filter((v) => v !== value));
  const decides = draft.mode === "ANY_PROFESSOR" || draft.mode === "SELECTED";

  return (
    <fieldset className="flex flex-col gap-3" aria-describedby={issue ? `${id}-issue` : undefined}>
      <legend className="mb-1 text-[15px] font-semibold">Professor links</legend>
      <label className="flex flex-col gap-1.5">
        <span className="text-[13px] leading-[18px] font-medium">Publications linked to</span>
        <select className="input w-full max-w-full sm:w-auto sm:min-w-[16rem]" value={draft.mode} onChange={(e) => set({ mode: e.target.value as LinkMode })}>
          {options.modes.map((m) => (
            <option key={m} value={m}>
              {MODE_LABEL[m]}
            </option>
          ))}
        </select>
        <span className="text-[13px] leading-5 text-text-muted">{MODE_HINT[draft.mode]}</span>
      </label>

      {draft.mode === "SELECTED" && (
        <ProfessorPicker
          selected={draft.professors}
          onChange={(ids) => set({ professors: ids })}
          professors={professors}
          error={professorsError}
          max={options.maxProfessors}
          match={draft.match}
          onMatch={(match) => set({ match })}
        />
      )}

      {draft.mode !== "NO_LINK" && (
        <div className="grid gap-3 md:grid-cols-[auto_auto_1fr]">
          <fieldset className="flex flex-col gap-1.5">
            <legend className="text-[13px] leading-[18px] font-medium">Relationship status</legend>
            <div className="flex flex-wrap gap-x-4 gap-y-1.5 py-1.5">
              {options.statuses.map((s) => (
                <label key={s} className="inline-flex cursor-pointer items-center gap-2 text-[15px]">
                  <input
                    type="checkbox"
                    className="size-4 cursor-pointer accent-[var(--ink)]"
                    checked={draft.statuses.includes(s)}
                    onChange={(e) => set({ statuses: toggle(draft.statuses, s, e.target.checked) })}
                  />
                  {STATUS_LABEL[s] ?? s}
                </label>
              ))}
            </div>
          </fieldset>
          <fieldset className="flex flex-col gap-1.5">
            <legend className="text-[13px] leading-[18px] font-medium">Origin (any when none is chosen)</legend>
            <div className="flex flex-wrap gap-x-4 gap-y-1.5 py-1.5">
              {options.origins.map((o) => (
                <label key={o} className="inline-flex cursor-pointer items-center gap-2 text-[15px]">
                  <input
                    type="checkbox"
                    className="size-4 cursor-pointer accent-[var(--ink)]"
                    checked={draft.origins.includes(o)}
                    onChange={(e) => set({ origins: toggle(draft.origins, o, e.target.checked) })}
                  />
                  {ORIGIN_LABEL[o] ?? o}
                </label>
              ))}
            </div>
          </fieldset>
          <fieldset className="flex flex-col gap-1.5">
            <legend className="text-[13px] leading-[18px] font-medium">Decided (UTC days, optional)</legend>
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-[15px] text-text-muted">after</span>
              <input type="date" className="input w-40" aria-label="Decided after" value={draft.decidedAfter} onChange={(e) => set({ decidedAfter: e.target.value })} />
              <span className="text-[15px] text-text-muted">before</span>
              <input type="date" className="input w-40" aria-label="Decided before" value={draft.decidedBefore} onChange={(e) => set({ decidedBefore: e.target.value })} />
            </div>
          </fieldset>
        </div>
      )}
      {draft.mode !== "NO_LINK" && (
        <p className="text-[13px] leading-5 text-text-muted">
          A link qualifies when its status, origin and decision date all match on the same relationship.
          {decides ? "" : " In this mode they only decide which links are marked as qualifying."}
        </p>
      )}

      {issue && (
        <p id={`${id}-issue`} role="alert" className="text-[13px] text-danger">
          {issue}
        </p>
      )}
    </fieldset>
  );
}

function ProfessorPicker({
  selected,
  onChange,
  professors,
  error,
  max,
  match,
  onMatch,
}: {
  selected: string[];
  onChange: (ids: string[]) => void;
  professors: ProfessorRow[] | null;
  error: unknown;
  max: number;
  match: "ANY" | "ALL";
  onMatch: (match: "ANY" | "ALL") => void;
}) {
  const [filter, setFilter] = useState("");
  const byId = useMemo(() => new Map((professors ?? []).map((p) => [p.id, p])), [professors]);
  const shown = useMemo(() => {
    const f = filter.trim().toLowerCase();
    return (professors ?? []).filter((p) => !f || p.name.toLowerCase().includes(f) || (p.department ?? "").toLowerCase().includes(f));
  }, [professors, filter]);
  const full = selected.length >= max;

  return (
    <div className="flex flex-col gap-2 rounded-md border border-border p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-[13px] font-medium tabular-nums" aria-live="polite">
          {selected.length} of at most {max} selected
        </p>
        <Segmented
          label="Match"
          value={match}
          onChange={onMatch}
          options={[
            { value: "ANY", label: "Any of them" },
            { value: "ALL", label: "All of them" },
          ]}
        />
      </div>
      <p className="text-[13px] leading-5 text-text-muted">
        {match === "ANY"
          ? "A publication matches when at least one selected professor has a qualifying link."
          : "A publication matches only when every selected professor has a qualifying link (joint publications)."}
      </p>
      {selected.length > 0 && (
        <ul className="flex flex-wrap gap-1.5" aria-label="Selected professors">
          {selected.map((pid) => (
            <li key={pid}>
              <button
                type="button"
                onClick={() => onChange(selected.filter((s) => s !== pid))}
                className="inline-flex min-h-8 cursor-pointer items-center gap-1 rounded-sm bg-ink-subtle px-2 text-[13px] text-ink"
                aria-label={`Remove ${byId.get(pid)?.name ?? "unknown professor"}`}
              >
                {byId.get(pid)?.name ?? "Unknown professor"}
                <X aria-hidden size={14} />
              </button>
            </li>
          ))}
        </ul>
      )}
      {error && !professors ? (
        <p className="text-[13px] text-danger">The professor list could not be loaded.</p>
      ) : !professors ? (
        <p className="text-[13px] text-text-muted">Loading professors…</p>
      ) : (
        <>
          <input className="input w-full sm:w-72" placeholder="Filter by name or department" aria-label="Filter professors" value={filter} onChange={(e) => setFilter(e.target.value)} />
          <ul className="max-h-56 overflow-y-auto rounded-md border border-border" aria-label="Professors">
            {shown.length === 0 && <li className="px-3 py-2 text-[13px] text-text-muted">No professor matches the filter.</li>}
            {shown.map((p) => {
              const checked = selected.includes(p.id);
              return (
                <li key={p.id} className="border-b border-border last:border-b-0">
                  <label className="flex min-h-10 cursor-pointer items-center gap-2 px-3 py-1.5 text-[15px]">
                    <input
                      type="checkbox"
                      className="size-4 cursor-pointer accent-[var(--ink)]"
                      checked={checked}
                      disabled={!checked && full}
                      onChange={(e) => onChange(e.target.checked ? [...selected, p.id] : selected.filter((s) => s !== p.id))}
                    />
                    <span className="min-w-0 flex-1">
                      {p.name}
                      {p.department && <span className="text-[13px] text-text-muted"> · {p.department}</span>}
                    </span>
                    {!p.isActive && <StatusChip status="INACTIVE" />}
                  </label>
                </li>
              );
            })}
          </ul>
          {full && <p className="text-[13px] text-text-muted">At most {max} professors can be selected.</p>}
        </>
      )}
    </div>
  );
}
