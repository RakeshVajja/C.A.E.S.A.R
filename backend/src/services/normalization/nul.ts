/**
 * U+0000 handling (Project_plan.md §7, decision #52). PostgreSQL cannot store U+0000 in text or
 * JSON, so it is replaced with U+FFFD, the standard marker for a lost character. normalizeTitle
 * treats both as a separator, so normalized titles (and title matching) are unaffected.
 */
export const NUL = '\u0000';
export const REPLACEMENT_CHARACTER = '�';

export function replaceNul(value: string): string {
  return value.includes(NUL) ? value.replaceAll(NUL, REPLACEMENT_CHARACTER) : value;
}
