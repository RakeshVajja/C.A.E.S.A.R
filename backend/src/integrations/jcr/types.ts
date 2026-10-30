import { z } from 'zod';

/**
 * Web of Science Journals API (JCR) response shapes used by the integration (Project_plan.md §13.8),
 * from Clarivate's OpenAPI specification (developer.clarivate.com/apis/wos-journal/swagger, version
 * 1.0.0, read 2026-10-31). Loose objects: unused fields pass through. Only the fields the client and
 * mapper rely on are checked; numbers and booleans must have their documented types.
 */

const optionalText = z.string().nullable().optional();
const optionalNumber = z.number().nullable().optional();
const optionalInt = z.number().int().nullable().optional();
const yearRange = z.looseObject({ start: optionalInt, end: optionalInt }).nullable().optional();

/** `Metadata` of a list response. */
const ListMetadataSchema = z.looseObject({
  total: z.number().int().nonnegative(),
  page: z.number().int().optional(),
  limit: z.number().int().optional(),
});

/** `JournalList` (`GET /journals?q=…`): only the identifier of each hit is used. */
export const JcrJournalListSchema = z.looseObject({
  metadata: ListMetadataSchema,
  hits: z.array(z.looseObject({ id: z.string(), name: optionalText })).nullable().optional(),
});

/** `JournalRecord` (`GET /journals/{id}`). */
export const JcrJournalRecordSchema = z.looseObject({
  id: z.string(),
  name: optionalText,
  jcrTitle: optionalText,
  isoTitle: optionalText,
  issn: optionalText,
  eIssn: optionalText,
  previousIssn: z.array(z.string()).nullable().optional(),
  publisher: z.looseObject({ name: optionalText }).nullable().optional(),
  frequency: optionalInt,
  firstIssueYear: optionalInt,
  language: optionalText,
  /** "List of all available Journal Citation Reports by year". */
  journalCitationReports: z
    .array(z.looseObject({ year: z.number().int(), url: optionalText }))
    .nullable()
    .optional(),
});
export type JcrJournalRecord = z.infer<typeof JcrJournalRecordSchema>;

/** `JournalHistoryRecord` (`GET /journals/{id}/history`): ISSNs with the years they were used. */
export const JcrJournalHistorySchema = z.looseObject({
  issn: z
    .array(z.looseObject({ issn: z.string(), year: yearRange }))
    .nullable()
    .optional(),
});
export type JcrJournalHistory = z.infer<typeof JcrJournalHistorySchema>;

const jifRank = z.looseObject({
  category: z.string(),
  edition: optionalText,
  self: optionalText,
  rank: optionalText,
  quartile: optionalText,
  jifPercentile: optionalNumber,
});
const jciRank = z.looseObject({
  category: z.string(),
  edition: optionalText,
  self: optionalText,
  rank: optionalText,
  quartile: optionalText,
  jciPercentile: optionalNumber,
});

/** `JournalReports` (`GET /journals/{id}/reports/year/{year}`): the fields stored by decision #114. */
export const JcrJournalReportSchema = z.looseObject({
  year: optionalInt,
  suppressed: z.boolean().nullable().optional(),
  onHold: z.boolean().nullable().optional(),
  delisted: z.boolean().nullable().optional(),
  journal: z.looseObject({ id: optionalText }).nullable().optional(),
  metrics: z
    .looseObject({
      impactMetrics: z
        .looseObject({
          totalCites: optionalInt,
          jif: optionalText,
          jifWithoutSelfCitations: optionalText,
          jif5Years: optionalNumber,
          immediacyIndex: optionalNumber,
          jci: optionalNumber,
        })
        .nullable()
        .optional(),
      sourceMetrics: z.looseObject({ jifPercentile: optionalNumber }).nullable().optional(),
    })
    .nullable()
    .optional(),
  ranks: z
    .looseObject({
      jif: z.array(jifRank).nullable().optional(),
      jci: z.array(jciRank).nullable().optional(),
    })
    .nullable()
    .optional(),
});
export type JcrJournalReport = z.infer<typeof JcrJournalReportSchema>;

/** `GET /last-updated`: only the database-wide content date (no per-report version exists). */
export const JcrLastUpdatedSchema = z.looseObject({
  jcrDataUpdate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD'),
});
