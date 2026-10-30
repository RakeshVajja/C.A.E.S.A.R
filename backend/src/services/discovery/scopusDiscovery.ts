import type { PrismaClient } from '@prisma/client';
import { prisma as defaultClient } from '../../config/database';
import { ScopusClient, scopusEid } from '../../integrations/scopus/client';
import { mapScopusDocument, scopusCitationCount } from '../../integrations/scopus/mapper';
import { DiscoveryPreconditionError, loadActiveIdentity } from './discoveryIdentity';
import { DiscoverySummary, ingestDiscoveredRecords } from './ingestDiscoveredRecords';

/**
 * Discovery for one Scopus identity (Project_plan.md §13.6, §14; stage 15.3):
 *   check identity → revalidate the author with Scopus (every run, so a manually verified identity
 *   is confirmed by the API before anything is accepted) → fetch every page → validate → map →
 *   normalize → match (the shared engine, §8) → write → citation observations.
 *
 * Nothing is written unless the author check and the complete fetch succeeded; any FetchError
 * propagates to the SyncTask (FAILED) and existing data stays untouched. Citation observations are
 * written only after every record was ingested, and only for synchronization tasks (decision #111):
 * one per source record per task, never updated, never merged with another provider's counts.
 */

export interface ScopusDiscoverySummary extends DiscoverySummary {
  identityId: string;
  authorId: string;
  reportedCount: number;
  /** Citation observations written by this run (0 outside a synchronization task). */
  citationObservations: number;
}

export async function discoverScopusIdentity(
  identityId: string,
  options: { client?: PrismaClient; scopus: ScopusClient | null; now?: () => Date; syncTaskId?: string | null },
): Promise<ScopusDiscoverySummary> {
  const client = options.client ?? defaultClient;
  const now = options.now ?? (() => new Date());

  const identity = await loadActiveIdentity(client, identityId, 'SCOPUS');
  if (!options.scopus) throw new DiscoveryPreconditionError('Scopus is not configured: no API credentials are set');

  // 1. Revalidate the identity and fetch everything first (throws FetchError; nothing written yet).
  const fetched = await options.scopus.fetchAuthorDocuments(identity.externalId);
  const seenAt = now();

  // 2. Write through the shared pipeline.
  const summary = await ingestDiscoveredRecords(
    { id: identity.id, professorId: identity.professorId },
    fetched.documents.map(mapScopusDocument),
    { seenAt, client },
  );

  // 3. Citation observations, after every record was processed.
  const citationObservations = options.syncTaskId
    ? await recordCitations(client, fetched.documents, options.syncTaskId, seenAt, summary.warnings)
    : 0;

  return { ...summary, identityId: identity.id, authorId: fetched.author.authorId, reportedCount: fetched.reportedCount, citationObservations };
}

async function recordCitations(
  client: PrismaClient,
  documents: Parameters<typeof mapScopusDocument>[0][],
  syncTaskId: string,
  observedAt: Date,
  warnings: string[],
): Promise<number> {
  const counts = new Map<string, number>();
  for (const document of documents) {
    const count = scopusCitationCount(document);
    const eid = scopusEid(document['dc:identifier']);
    if (count === null) warnings.push(`Scopus document ${eid} has no valid cited-by count; no citation observation recorded`);
    else counts.set(eid, count);
  }
  if (counts.size === 0) return 0;

  // Records that could not be normalized (e.g. no title) have no source record and get no observation.
  const records = await client.publicationSourceRecord.findMany({
    where: { source: 'SCOPUS', externalId: { in: [...counts.keys()] } },
    select: { id: true, externalId: true },
  });
  const { count } = await client.citationObservation.createMany({
    data: records.map((record) => ({
      sourceRecordId: record.id,
      provider: 'SCOPUS' as const,
      count: counts.get(record.externalId)!,
      observedAt,
      syncTaskId,
    })),
    // UNIQUE(source_record_id, sync_task_id): a retried write of the same task adds nothing.
    skipDuplicates: true,
  });
  return count;
}
