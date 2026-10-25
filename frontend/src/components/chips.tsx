import { CircleCheck, CircleX, Clock, EyeOff, LoaderCircle, TriangleAlert, Circle, GitMerge, Ban } from "lucide-react";
import { SOURCE_LABEL } from "@/lib/format";
import type { CandidateStatus, PublicationStatus, Source, SyncRunStatus, SyncTaskStatus, VerificationStatus } from "@/lib/types";

/** Status chips: icon + word + tint, never colour alone (design system §6.2). */

type ChipStatus = VerificationStatus | PublicationStatus | SyncRunStatus | SyncTaskStatus | CandidateStatus | "INACTIVE";

const STATUS: Record<string, { label: string; tone: string; Icon: typeof Clock }> = {
  PENDING: { label: "Pending", tone: "bg-warning-bg text-warning", Icon: Clock },
  APPROVED: { label: "Approved", tone: "bg-success-bg text-success", Icon: CircleCheck },
  REJECTED: { label: "Rejected", tone: "bg-danger-bg text-danger", Icon: CircleX },
  ACTIVE: { label: "Active", tone: "bg-success-bg text-success", Icon: CircleCheck },
  SUPPRESSED: { label: "Suppressed", tone: "bg-neutral-bg text-neutral", Icon: EyeOff },
  INACTIVE: { label: "Inactive", tone: "bg-neutral-bg text-neutral", Icon: Circle },
  RUNNING: { label: "Running", tone: "bg-info-bg text-info", Icon: LoaderCircle },
  SUCCESS: { label: "Success", tone: "bg-success-bg text-success", Icon: CircleCheck },
  PARTIAL_SUCCESS: { label: "Partial success", tone: "bg-warning-bg text-warning", Icon: TriangleAlert },
  FAILED: { label: "Failed", tone: "bg-danger-bg text-danger", Icon: CircleX },
  OPEN: { label: "Open", tone: "bg-warning-bg text-warning", Icon: Clock },
  MERGED: { label: "Merged", tone: "bg-success-bg text-success", Icon: GitMerge },
  DISMISSED: { label: "Dismissed", tone: "bg-neutral-bg text-neutral", Icon: Ban },
};

/** Sync tasks waiting to run are neutral, unlike pending verifications. */
export function StatusChip({ status, task }: { status: ChipStatus; task?: boolean }) {
  const s = STATUS[status];
  const tone = task && status === "PENDING" ? "bg-neutral-bg text-neutral" : s.tone;
  const label = task && status === "PENDING" ? "Waiting" : s.label;
  return (
    <span className={`inline-flex items-center gap-1 whitespace-nowrap rounded-sm px-2 py-0.5 text-[13px] leading-[18px] font-medium ${tone}`}>
      <s.Icon aria-hidden size={14} className={status === "RUNNING" ? "animate-spin" : ""} />
      {label}
    </span>
  );
}

const SOURCE_TONE: Record<Source, string> = {
  OPENALEX: "border-src-openalex text-src-openalex",
  DBLP: "border-src-dblp text-src-dblp",
  ORCID: "border-src-orcid text-src-orcid",
  MANUAL: "border-src-manual text-src-manual",
};

export function SourceChip({ source }: { source: Source }) {
  return (
    <span className={`inline-flex items-center rounded-full border px-2 text-[12px] leading-5 font-medium whitespace-nowrap ${SOURCE_TONE[source]}`}>
      {SOURCE_LABEL[source]}
    </span>
  );
}

export function SourceChips({ sources }: { sources: Source[] }) {
  if (sources.length === 0) return <span className="text-[13px] text-text-muted">No source records</span>;
  return (
    <span className="inline-flex flex-wrap gap-1" aria-label={`Sources: ${sources.map((s) => SOURCE_LABEL[s]).join(", ")}`}>
      {sources.map((s) => (
        <SourceChip key={s} source={s} />
      ))}
    </span>
  );
}

export function CuratedChip() {
  return <span className="inline-flex items-center rounded-sm bg-ink-subtle px-2 py-0.5 text-[13px] leading-[18px] font-medium text-ink">Curated</span>;
}
