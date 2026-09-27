/**
 * Title normalization (Project_plan.md §7.2). Deterministic; if it ever changes,
 * stored normalized titles must be recomputed.
 */

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  ndash: '-',
  mdash: '-',
  hellip: '...',
  lsquo: "'",
  rsquo: "'",
  ldquo: '"',
  rdquo: '"',
};

// Accented-letter entities (&eacute; &Uuml; &ccedil; ...) decode to their base letter;
// step 3 would remove the accent anyway.
const ACCENT_ENTITY = /^([a-zA-Z])(acute|grave|circ|tilde|uml|cedil|ring|caron|slash)$/;

function decodeHtmlEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);/gi, (match, entity: string) => {
    if (entity[0] === '#') {
      const codePoint =
        entity[1] === 'x' || entity[1] === 'X' ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10);
      return Number.isFinite(codePoint) && codePoint <= 0x10ffff ? String.fromCodePoint(codePoint) : ' ';
    }
    const named = NAMED_ENTITIES[entity.toLowerCase()];
    if (named !== undefined) return named;
    const accented = ACCENT_ENTITY.exec(entity);
    if (accented) return accented[1];
    return ' ';
  });
}

// Markup tags such as <i>, </sub>, <mml:mi>, <br/>; a lone "<" or ">" in text is not a tag.
const MARKUP_TAG = /<\/?[a-zA-Z][\w:-]*(?:\s[^<>]*)?\/?>/g;

export function normalizeTitle(title: string | null | undefined): string {
  if (typeof title !== 'string') return '';

  // 1. Literal escape sequences written as text (e.g. OpenAlex "\n") and real control characters.
  const withoutControls = title.replace(/\\[nrt]/g, ' ').replace(/[\u0000-\u001f\u007f]/g, ' ');

  return (
    // 2. Decode HTML entities, then strip markup tags (tags are removed without a gap so that
    //    "H<sub>2</sub>O" and "H2O" normalize identically).
    decodeHtmlEntities(withoutControls)
      .replace(MARKUP_TAG, '')
      // 3. Unicode NFKD and remove combining marks.
      .normalize('NFKD')
      .replace(/\p{M}/gu, '')
      // 4. Lowercase.
      .toLowerCase()
      // 5. Anything other than [a-z0-9] becomes a space.
      .replace(/[^a-z0-9]/g, ' ')
      // 6. Collapse whitespace and trim.
      .replace(/\s+/g, ' ')
      .trim()
  );
}
