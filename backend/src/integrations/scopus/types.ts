import { z } from 'zod';

/**
 * Elsevier Scopus API response shapes used by the integration (Project_plan.md §13.6). Only the
 * fields the client and mapper rely on are required; everything else passes through into
 * raw_metadata (minus excluded content). Elsevier serializes numbers as strings.
 */

const digits = z.string().regex(/^\d+$/);
const optionalText = z.string().nullable().optional();

/** One entry of a Scopus Search API page in the STANDARD view. */
export const ScopusSearchEntrySchema = z.looseObject({
  'dc:identifier': z
    .string()
    .regex(/^SCOPUS_ID:\d+$/, 'expected "SCOPUS_ID:<digits>"'),
  eid: optionalText,
  'dc:title': optionalText,
  'dc:creator': optionalText,
  'prism:doi': optionalText,
  'prism:coverDate': optionalText,
  'prism:publicationName': optionalText,
  'prism:issn': optionalText,
  'prism:eIssn': optionalText,
  'prism:aggregationType': optionalText,
  subtype: optionalText,
  subtypeDescription: optionalText,
  'citedby-count': optionalText,
  /** Present only in the COMPLETE view; the integration requests STANDARD. */
  author: z
    .array(z.looseObject({ authid: optionalText, authname: optionalText }))
    .nullable()
    .optional(),
});

export type ScopusSearchEntry = z.infer<typeof ScopusSearchEntrySchema>;

export const ScopusSearchPageSchema = z.looseObject({
  'search-results': z.looseObject({
    'opensearch:totalResults': digits,
    'opensearch:startIndex': digits.optional(),
    'opensearch:itemsPerPage': digits.optional(),
    // Validated entry by entry, so a single bad entry is reported precisely.
    entry: z.array(z.unknown()).optional(),
  }),
});

/**
 * A Scopus Search page in cursor mode (deep pagination; release notes 2018-06-21, Getting Started
 * guide V1 p. 51). Documented: the top-level navigation links (`link`, `@ref`/`@href`, as in the
 * guide's search-response examples) — the `next` link continues the cursor — and the request rule
 * "submit the 'cursor/@next' value". The JSON spelling of that element (`cursor` → `@next`) follows
 * Elsevier's attribute convention but is not shown in any published JSON example, so it is optional
 * here and only used as a source agreeing with the `next` link (to be confirmed with a real key).
 */
export const ScopusCursorPageSchema = z.looseObject({
  'search-results': z.looseObject({
    'opensearch:totalResults': digits,
    entry: z.array(z.unknown()).optional(),
    link: z
      .array(z.looseObject({ '@ref': optionalText, '@href': optionalText }))
      .nullable()
      .optional(),
    cursor: z
      .looseObject({ '@next': z.string().nullable().optional() })
      .nullable()
      .optional(),
  }),
});

/** Author Retrieval API, LIGHT view: `author-retrieval-response` is an array of one profile. */
export const ScopusAuthorProfileSchema = z.looseObject({
  '@status': optionalText,
  coredata: z.looseObject({
    'dc:identifier': z
      .string()
      .regex(/^AUTHOR_ID:\d+$/, 'expected "AUTHOR_ID:<digits>"'),
    'document-count': digits.nullable().optional(),
  }),
  'preferred-name': z
    .looseObject({
      'given-name': optionalText,
      surname: optionalText,
      'indexed-name': optionalText,
    })
    .nullable()
    .optional(),
});

export const ScopusAuthorResponseSchema = z.looseObject({
  'author-retrieval-response': z.union([
    z.array(ScopusAuthorProfileSchema).min(1),
    ScopusAuthorProfileSchema,
  ]),
});
