/**
 * Date semantics of publication queries (Project_plan.md §24.3, implementation decision of stage
 * Q1): every date value is an ISO calendar day (YYYY-MM-DD) read as a **UTC** day. "before D" means
 * earlier than D 00:00 UTC, "after D" means from the next day 00:00 UTC, "between D1 and D2" spans
 * both days inclusive. Used by `addedOn` and the link scope's `decidedOn`, in the database filters
 * and in the marking of qualifying links, so both always agree. (Publication *years* are not dates:
 * the *Recent* preset uses the configured time zone for the current year, D7.)
 */

/** 00:00 UTC of the day. */
export function utcDayStart(day: string): Date {
  return new Date(`${day}T00:00:00.000Z`);
}

/** 00:00 UTC of the following day. */
export function utcNextDayStart(day: string): Date {
  const date = utcDayStart(day);
  date.setUTCDate(date.getUTCDate() + 1);
  return date;
}

/** The UTC calendar day of a moment. */
export function utcDay(moment: Date): string {
  return moment.toISOString().slice(0, 10);
}
