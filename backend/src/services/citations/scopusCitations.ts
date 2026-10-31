import type { Prisma, PrismaClient } from '@prisma/client';
import { prisma as defaultClient } from '../../config/database';

/**
 * Scopus citation counts for display (Project_plan.md §13.10, §22.3.4; decision #112, stage 15.7).
 *
 * Only Scopus counts are ever read here: Web of Science Times Cited and every JCR metric stay
 * undisplayed until Clarivate's written confirmation (#112, #114). Display follows the Scopus
 * attribution rules: the count is labelled as coming from Scopus, with links to the Scopus record
 * and its cited-by list. The links are the ones Scopus itself returned in the record (`link` with
 * `@ref` "scopus" / "scopus-citedby", stored in raw_metadata); only https links on scopus.com are
 * passed on, and none is invented.
 *
 * A publication's count is its Scopus source record's latest observation. When several Scopus
 * records belong to one publication (in-source duplicates), the record whose latest observation is
 * the highest is shown — counts of one provider are never added up across records.
 */

export interface ScopusCitation {
  count: number;
  /** When this count was observed (the synchronization that fetched it). */
  observedAt: Date;
  /** The record on scopus.com, when Scopus provided the link. */
  recordUrl: string | null;
  /** The record's cited-by list on scopus.com, when Scopus provided the link. */
  citedByUrl: string | null;
}

type Db = PrismaClient | Prisma.TransactionClient;

/** The Scopus citation of each publication that has one (publications without are absent). */
export async function scopusCitations(publicationIds: readonly string[], client: Db = defaultClient): Promise<Map<string, ScopusCitation>> {
  const result = new Map<string, ScopusCitation>();
  if (publicationIds.length === 0) return result;
  const observations = await client.citationObservation.findMany({
    where: { provider: 'SCOPUS', sourceRecord: { source: 'SCOPUS', publicationId: { in: [...publicationIds] } } },
    select: { count: true, observedAt: true, sourceRecordId: true, sourceRecord: { select: { publicationId: true, rawMetadata: true } } },
    orderBy: [{ observedAt: 'desc' }, { id: 'desc' }],
  });

  // The latest observation of each source record (rows are newest first).
  const latestByRecord = new Map<string, (typeof observations)[number]>();
  for (const observation of observations) if (!latestByRecord.has(observation.sourceRecordId)) latestByRecord.set(observation.sourceRecordId, observation);

  for (const observation of latestByRecord.values()) {
    const publicationId = observation.sourceRecord.publicationId;
    const known = result.get(publicationId);
    if (known && known.count >= observation.count) continue;
    const links = scopusLinks(observation.sourceRecord.rawMetadata);
    result.set(publicationId, { count: observation.count, observedAt: observation.observedAt, recordUrl: links.record, citedByUrl: links.citedBy });
  }
  return result;
}

/** The record and cited-by links Scopus returned for a search entry; only https scopus.com URLs. */
export function scopusLinks(rawMetadata: unknown): { record: string | null; citedBy: string | null } {
  const links = (rawMetadata as { link?: unknown } | null)?.link;
  const find = (ref: string) => {
    if (!Array.isArray(links)) return null;
    const entry = links.find((l): l is Record<string, unknown> => l !== null && typeof l === 'object' && (l as Record<string, unknown>)['@ref'] === ref);
    return safeScopusUrl(entry?.['@href']);
  };
  return { record: find('scopus'), citedBy: find('scopus-citedby') };
}

function safeScopusUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && (url.hostname === 'www.scopus.com' || url.hostname === 'scopus.com') && !url.username && !url.password ? url.toString() : null;
  } catch {
    return null;
  }
}
