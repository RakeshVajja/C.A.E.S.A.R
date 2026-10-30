import type { Source, TypeFamily } from "./types";

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
