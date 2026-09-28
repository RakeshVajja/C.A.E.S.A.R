import { z } from 'zod';

/**
 * Structural validation of OpenAlex responses (Project_plan.md §13.1). Only the fields the
 * integration relies on are checked; everything else is kept (loose objects) for raw_metadata.
 */

const nullableString = z.string().nullable().optional();

export const OpenAlexAuthorSchema = z.looseObject({
  id: z.string().regex(/^https:\/\/openalex\.org\/A\d+$/, 'author id must be an OpenAlex A-id URL'),
  display_name: nullableString,
  orcid: nullableString,
  works_count: z.number().int().nonnegative().optional(),
});
export type OpenAlexAuthor = z.infer<typeof OpenAlexAuthorSchema>;

export const OpenAlexWorkSchema = z.looseObject({
  id: z.string().regex(/^https:\/\/openalex\.org\/W\d+$/, 'work id must be an OpenAlex W-id URL'),
  doi: nullableString,
  title: nullableString,
  display_name: nullableString,
  publication_year: z.number().int().nullable().optional(),
  type: nullableString,
  primary_location: z
    .looseObject({
      source: z.looseObject({ display_name: nullableString, type: nullableString }).nullable().optional(),
    })
    .nullable()
    .optional(),
  authorships: z
    .array(z.looseObject({ author: z.looseObject({ display_name: nullableString }).nullable().optional() }))
    .nullable()
    .optional(),
});
export type OpenAlexWork = z.infer<typeof OpenAlexWorkSchema>;

export const OpenAlexWorksPageSchema = z.looseObject({
  meta: z.looseObject({
    count: z.number().int().nonnegative(),
    next_cursor: z.string().nullable().optional(),
  }),
  results: z.array(z.unknown()),
});
