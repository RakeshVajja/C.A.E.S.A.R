import { z } from 'zod';

/**
 * Web of Science Starter API response shapes used by the integration (Project_plan.md §13.7), from
 * Clarivate's OpenAPI specification (developer.clarivate.com/apis/wos-starter/swagger, version
 * 1.0.0, read 2026-10-30): `DocumentsList` = { metadata: { total, page, limit }, hits: Document[] }.
 * Only `uid` is required by the specification; the client additionally requires `metadata.total`
 * (completeness cannot be checked without it). Everything else passes through into raw_metadata
 * (minus excluded content). The Starter API returns no abstracts.
 */

const optionalText = z.string().nullable().optional();
const count = z.number().int().nonnegative();

/** `AuthorName`: display name, standard name and the author's Web of Science ResearcherID. */
export const WosAuthorNameSchema = z.looseObject({
  displayName: optionalText,
  wosStandard: optionalText,
  researcherId: optionalText,
});

/** One `Document` (db=WOS: accession numbers "WOS:<letters and digits>"). */
export const WosDocumentSchema = z.looseObject({
  uid: z.string().regex(/^WOS:[A-Z0-9]+$/, 'expected "WOS:<accession number>"'),
  title: optionalText,
  /** Normalized document types, e.g. "Article", "Proceedings Paper", "Review", "Book Chapter". */
  types: z.array(z.string()).nullable().optional(),
  /** Document types as given by the source. */
  sourceTypes: z.array(z.string()).nullable().optional(),
  source: z
    .looseObject({
      sourceTitle: optionalText,
      publishYear: z.number().int().nullable().optional(),
      publishMonth: optionalText,
    })
    .nullable()
    .optional(),
  names: z
    .looseObject({ authors: z.array(WosAuthorNameSchema).nullable().optional() })
    .nullable()
    .optional(),
  /** "Times Cited" per citation database; returned only by plans that include it (not Free Trial). */
  citations: z
    .array(z.looseObject({ db: optionalText, count: count.nullable().optional() }))
    .nullable()
    .optional(),
  identifiers: z
    .looseObject({ doi: optionalText, issn: optionalText, eissn: optionalText, isbn: optionalText, eisbn: optionalText, pmid: optionalText })
    .nullable()
    .optional(),
});

export type WosDocument = z.infer<typeof WosDocumentSchema>;

export const WosDocumentsPageSchema = z.looseObject({
  metadata: z.looseObject({
    total: count,
    page: z.number().int().optional(),
    limit: z.number().int().optional(),
  }),
  // Validated document by document, so a single bad hit is reported precisely.
  hits: z.array(z.unknown()).nullable().optional(),
});
