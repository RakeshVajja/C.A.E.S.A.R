import type { Basis, DeclaredBasis, Source, TypeFamily } from "./types";

/** Display conventions (design system §9): en-IN, Asia/Kolkata. */

const dateFormat = new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "Asia/Kolkata" });
const dateTimeFormat = new Intl.DateTimeFormat("en-IN", {
  day: "numeric",
  month: "short",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
  timeZone: "Asia/Kolkata",
});
const numberFormat = new Intl.NumberFormat("en-IN");

export function formatDate(value: string | Date | null | undefined): string {
  return value ? dateFormat.format(new Date(value)) : "–";
}

export function formatDateTime(value: string | Date | null | undefined): string {
  return value ? `${dateTimeFormat.format(new Date(value))} IST` : "–";
}

export function formatNumber(value: number): string {
  return numberFormat.format(value);
}

export const TYPE_LABEL: Record<TypeFamily, string> = {
  JOURNAL: "Journal article",
  CONFERENCE: "Conference paper",
  BOOK_CHAPTER: "Book chapter",
  BOOK: "Book",
  PREPRINT: "Preprint",
  OTHER: "Other",
};

export const TYPE_OPTIONS: TypeFamily[] = ["JOURNAL", "CONFERENCE", "BOOK_CHAPTER", "BOOK", "PREPRINT", "OTHER"];

export const SOURCE_LABEL: Record<Source, string> = {
  OPENALEX: "OpenAlex",
  DBLP: "DBLP",
  ORCID: "ORCID",
  SCOPUS: "Scopus",
  WOS: "Web of Science",
  MANUAL: "Manual",
};

/** Labels of the declared basis of a curated value or manual entry (decision #125). */
export const BASIS_LABEL: Record<Basis, string> = {
  INDEPENDENT: "Independent source",
  OPENALEX: "Derived from OpenAlex",
  DBLP: "Derived from DBLP",
  ORCID: "Derived from ORCID",
  SCOPUS: "Derived from Scopus",
  WOS: "Derived from Web of Science",
  JCR: "Derived from Journal Citation Reports",
  PRE_PHASE15: "Edited before basis recording",
};
export const DECLARED_BASES: readonly DeclaredBasis[] = ["INDEPENDENT", "OPENALEX", "DBLP", "ORCID", "SCOPUS", "WOS", "JCR"];

export function doiUrl(doi: string): string {
  return `https://doi.org/${doi}`;
}

/** "1–50 of 312" */
export function rangeLabel(offset: number, count: number, total: number): string {
  if (total === 0) return "0 of 0";
  return `${formatNumber(offset + 1)}–${formatNumber(offset + count)} of ${formatNumber(total)}`;
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${formatNumber(n)} ${n === 1 ? one : many}`;
}

/**
 * Where a publication-discovery run came from (#171): scheduled, started by the administrator, or
 * identity-scoped — for a professor's newly added identity, or a queued batch started after another
 * run (never shown as an ordinary manual run).
 */
export function runOrigin(
  run: { trigger: "MANUAL" | "SCHEDULED"; scope?: { queued: boolean; identityIds: string[] } | null; startedBy?: { role: string; name: string | null } | null },
  form: "short" | "long" = "short",
): string {
  if (run.scope) {
    const count = plural(run.scope.identityIds.length, "identity", "identities");
    if (run.scope.queued) return `Identity sync · queued batch (${count})`;
    const who = run.startedBy?.role === "PROFESSOR" ? (run.startedBy.name ?? "a professor") : "a professor";
    return `Identity sync · new identity of ${who}`;
  }
  if (run.trigger === "SCHEDULED") return "Scheduled";
  return form === "long" ? "Started by the administrator" : "Manual run";
}
