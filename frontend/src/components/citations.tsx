import { ExternalProfileLink } from "@/components/ui";
import { formatDate, formatNumber } from "@/lib/format";
import type { ScopusCitation } from "@/lib/types";

/**
 * A Scopus citation count with its attribution (Project_plan.md §13.10, §22.3.4; decision #112):
 * labelled as coming from Scopus, with the links to the Scopus record and its cited-by list that
 * Scopus provided. Web of Science Times Cited and JCR metrics are never shown (no written
 * confirmation yet), so this is the only citation display.
 */
export function ScopusCitationNote({ citation }: { citation: ScopusCitation }) {
  return (
    <p className="text-[13px] leading-5 text-text-muted">
      <span className="font-medium text-text tabular-nums">{formatNumber(citation.count)}</span>{" "}
      {citation.count === 1 ? "citation" : "citations"} in Scopus
      <span className="whitespace-nowrap"> · as of {formatDate(citation.observedAt)}</span>
      {citation.recordUrl && (
        <>
          {" · "}
          <ExternalProfileLink href={citation.recordUrl}>View in Scopus</ExternalProfileLink>
        </>
      )}
      {citation.citedByUrl && (
        <>
          {" · "}
          <ExternalProfileLink href={citation.citedByUrl}>Citing documents</ExternalProfileLink>
        </>
      )}
    </p>
  );
}
