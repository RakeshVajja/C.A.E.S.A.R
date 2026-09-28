import { z } from 'zod';

/**
 * Structural validation of ORCID Public API v3.0 `/works` responses (Project_plan.md §13.1, §13.5).
 * Only fields the integration relies on are checked; the rest is kept (loose objects) for raw_metadata.
 */

const valueOf = <T extends z.ZodType>(inner: T) => z.looseObject({ value: inner }).nullable().optional();

export const OrcidExternalIdSchema = z.looseObject({
  'external-id-type': z.string(),
  'external-id-value': z.string(),
  'external-id-relationship': z.string().nullable().optional(),
});

export const OrcidWorkSummarySchema = z.looseObject({
  'put-code': z.number().int().positive(),
  path: z.string(),
  type: z.string().nullable().optional(),
  title: z
    .looseObject({
      title: valueOf(z.string().nullable()),
      subtitle: valueOf(z.string().nullable()),
    })
    .nullable()
    .optional(),
  'external-ids': z.looseObject({ 'external-id': z.array(OrcidExternalIdSchema) }).nullable().optional(),
  'publication-date': z
    .looseObject({ year: valueOf(z.string().nullable()) })
    .nullable()
    .optional(),
  'journal-title': valueOf(z.string().nullable()),
});
export type OrcidWorkSummary = z.infer<typeof OrcidWorkSummarySchema>;

export const OrcidWorksSchema = z.looseObject({
  path: z.string(),
  group: z.array(
    z.looseObject({
      'work-summary': z.array(OrcidWorkSummarySchema).min(1),
    }),
  ),
});
export type OrcidWorks = z.infer<typeof OrcidWorksSchema>;
