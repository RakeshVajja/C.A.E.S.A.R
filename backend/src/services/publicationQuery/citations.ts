import { Prisma } from '@prisma/client';
import type { Tx } from '../matching/engine';

/**
 * Scopus citation data for publication queries (Project_plan.md §24.3–§24.4; decisions #112, D6,
 * D9). A publication's count follows the display rule of `scopusCitations`: the latest observation
 * of each Scopus source record, and the highest of those when a publication has several Scopus
 * records — never added up across records or providers. A publication without a Scopus record or
 * observation has no count (it is not zero).
 */

export interface CitationCount {
  count: number;
  observedAt: Date;
}

/** Whether any Scopus citation observation is stored at all (D6: otherwise citation queries are refused). */
export async function scopusDataAvailable(db: Tx): Promise<boolean> {
  const [row] = await db.$queryRaw<{ available: boolean }[]>`
    SELECT EXISTS (SELECT 1 FROM citation_observations WHERE provider = 'SCOPUS') AS available`;
  return row?.available === true;
}

/** Every publication's Scopus count (fixed query, no input). */
export async function scopusCounts(db: Tx): Promise<Map<string, CitationCount>> {
  const rows = await db.$queryRaw<{ publication_id: string; count: number; observed_at: Date }[]>(Prisma.sql`
    SELECT r.publication_id, l.count, l.observed_at
    FROM (
      SELECT DISTINCT ON (o.source_record_id) o.source_record_id, o.count, o.observed_at
      FROM citation_observations o
      WHERE o.provider = 'SCOPUS'
      ORDER BY o.source_record_id, o.observed_at DESC, o.id DESC
    ) l
    JOIN publication_source_records r ON r.id = l.source_record_id AND r.source = 'SCOPUS'`);
  const counts = new Map<string, CitationCount>();
  for (const row of rows) {
    const known = counts.get(row.publication_id);
    if (!known || row.count > known.count || (row.count === known.count && row.observed_at > known.observedAt)) {
      counts.set(row.publication_id, { count: Number(row.count), observedAt: row.observed_at });
    }
  }
  return counts;
}

/** The publications whose count satisfies a numeric citation condition (publications without a count never do). */
export function idsWithCount(counts: Map<string, CitationCount>, test: (count: number) => boolean): string[] {
  return [...counts].filter(([, c]) => test(c.count)).map(([id]) => id);
}
