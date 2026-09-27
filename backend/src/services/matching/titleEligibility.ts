/**
 * Generic-title list and minimum title length (Project_plan.md §8.2 veto; defined in Phase 3,
 * decision log #23). Such titles carry too little information for title-based auto-merging.
 * All values are compared against *normalized* titles.
 */

/** A normalized title shorter than this (in characters) is too short. */
export const MIN_TITLE_LENGTH = 10;
/** A normalized title with fewer words than this is too short. */
export const MIN_TITLE_WORDS = 2;

export const GENERIC_TITLES: ReadonlySet<string> = new Set([
  'editorial',
  'guest editorial',
  'editorial note',
  'editor s note',
  'editors note',
  'from the editor',
  'letter from the editor',
  'letter to the editor',
  'preface',
  'foreword',
  'introduction',
  'overview',
  'summary',
  'conclusion',
  'conclusions',
  'abstract',
  'abstracts',
  'keynote',
  'keynote address',
  'keynote talk',
  'invited talk',
  'panel',
  'panel discussion',
  'tutorial',
  'erratum',
  'corrigendum',
  'correction',
  'retraction',
  'front matter',
  'back matter',
  'frontmatter',
  'backmatter',
  'table of contents',
  'contents',
  'index',
  'author index',
  'subject index',
  'acknowledgment',
  'acknowledgments',
  'acknowledgement',
  'acknowledgements',
  'reviewers',
  'list of reviewers',
  'in memoriam',
  'obituary',
  'book review',
  'announcement',
  'announcements',
  'message from the chairs',
  'message from the general chair',
  'message from the program chairs',
  'welcome message',
]);

/** Titles that begin with one of these words are notices/front matter, not distinctive titles. */
export const GENERIC_TITLE_PREFIXES: readonly string[] = [
  'editorial',
  'guest editorial',
  'preface',
  'foreword',
  'erratum',
  'corrigendum',
  'correction to',
  'retraction',
  'front matter',
  'back matter',
];

export function isGenericOrShortTitle(normalizedTitle: string): boolean {
  const title = normalizedTitle.trim();
  if (title.length < MIN_TITLE_LENGTH) return true;
  if (title.split(' ').length < MIN_TITLE_WORDS) return true;
  if (GENERIC_TITLES.has(title)) return true;
  return GENERIC_TITLE_PREFIXES.some((prefix) => title === prefix || title.startsWith(`${prefix} `));
}
