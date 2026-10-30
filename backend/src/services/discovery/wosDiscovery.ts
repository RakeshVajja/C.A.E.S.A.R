import type { PrismaClient } from '@prisma/client';
import { prisma as defaultClient } from '../../config/database';
import { FetchError } from '../../integrations/http/httpClient';
import { attributedAuthors, normalizeResearcherId, WosStarterClient } from '../../integrations/wos/client';
import { mapWosDocument, wosTimesCited } from '../../integrations/wos/mapper';
import type { WosDocument } from '../../integrations/wos/types';
import { DiscoveryPreconditionError, loadActiveIdentity } from './discoveryIdentity';
import { DiscoverySummary, ingestDiscoveredRecords } from './ingestDiscoveredRecords';

/**
 * Discovery for one Web of Science identity (Project_plan.md §13.7, §14; stage 15.4):
 *   check identity → fetch every page of the `AI=` ResearcherID search → validate → check Times
 *   Cited and attribution → map → normalize → match (the shared engine, §8) → write → citation
 *   observations.
 *
 * Revalidation (decision #118): the Starter API has no researcher-profile endpoint, so every run
 * revalidates the identity through the documents themselves: a document is attributed to the
 * professor only when its own author list carries the ResearcherID. Found documents of which none
 * carries it fail the task (IDENTITY_INVALID); documents that do not carry it are skipped with a
 * warning. `AI=` finds the documents linked to the ResearcherID, which need not be every
 * publication of the researcher.
 *
 * Nothing is written unless the complete fetch and these checks succeeded; any FetchError
 * propagates to the SyncTask (FAILED) and existing data stays untouched. A plan that returns no
 * Times Cited at all (e.g. Free Trial) is NOT_ENTITLED (§22.4). Citation observations are written
 * only after every record was ingested, and only for synchronization tasks (decision #111): one per
 * source record per task (`database` = WOS), never updated, never merged with Scopus counts.
 */

export interface WosDiscoverySummary extends DiscoverySummary {
  identityId: string;
  researcherId: string;
  reportedCount: number;
  /** Documents found by the search whose author list does not carry the ResearcherID (skipped). */
  documentsNotAttributed: number;
  /** Citation observations written by this run (0 outside a synchronization task). */
  citationObservations: number;
}

export async function discoverWosIdentity(
  identityId: string,
  options: { client?: PrismaClient; wos: WosStarterClient | null; now?: () => Date; syncTaskId?: string | null },
): Promise<WosDiscoverySummary> {
  const client = options.client ?? defaultClient;
  const now = options.now ?? (() => new Date());

  const identity = await loadActiveIdentity(client, identityId, 'WOS');
  if (!options.wos) throw new DiscoveryPreconditionError('Web of Science is not configured: no API credentials are set');
  const researcherId = normalizeResearcherId(identity.externalId);

  // 1. Fetch and check everything first (throws FetchError; nothing written yet).
  const fetched = await options.wos.fetchResearcherDocuments(researcherId);
  const { documents } = fetched;
  if (documents.length > 0 && documents.every((document) => !Array.isArray(document.citations))) {
    throw new FetchError(
      'NOT_ENTITLED',
      'Web of Science returned no Times Cited for any document: the API plan of these credentials does not include Times Cited ' +
        '(for example the Free Trial plan). Nothing was saved.',
    );
  }
  const attributed = documents.filter((document) => attributedAuthors(document, researcherId).length > 0);
  if (documents.length > 0 && attributed.length === 0) {
    throw new FetchError(
      'IDENTITY_INVALID',
      `None of the ${documents.length} Web of Science documents found for ResearcherID ${researcherId} lists it among its authors; ` +
        'nothing was saved. Check the ResearcherID on the author’s Web of Science record.',
    );
  }
  const seenAt = now();

  // 2. Write through the shared pipeline.
  const summary = await ingestDiscoveredRecords(
    { id: identity.id, professorId: identity.professorId },
    attributed.map(mapWosDocument),
    { seenAt, client },
  );
  for (const document of documents) {
    if (!attributed.includes(document)) {
      summary.warnings.push(`Web of Science document ${document.uid} does not list ResearcherID ${researcherId} among its authors; not attributed`);
    }
  }
  if (documents.length === 0) {
    summary.warnings.push(`No Web of Science document is linked to ResearcherID ${researcherId}; the identity could not be confirmed by this synchronization`);
  }

  // 3. Citation observations, after every record was processed.
  const citationObservations = options.syncTaskId ? await recordCitations(client, attributed, options.syncTaskId, seenAt, summary.warnings) : 0;

  return {
    ...summary,
    identityId: identity.id,
    researcherId,
    reportedCount: fetched.reportedCount,
    documentsNotAttributed: documents.length - attributed.length,
    citationObservations,
  };
}

async function recordCitations(client: PrismaClient, documents: WosDocument[], syncTaskId: string, observedAt: Date, warnings: string[]): Promise<number> {
  const counts = new Map<string, number>();
  for (const document of documents) {
    const count = wosTimesCited(document);
    if (count === null) warnings.push(`Web of Science document ${document.uid} has no valid Times Cited; no citation observation recorded`);
    else counts.set(document.uid, count);
  }
  if (counts.size === 0) return 0;

  // Records that could not be normalized (e.g. no title) have no source record and get no observation.
  const records = await client.publicationSourceRecord.findMany({
    where: { source: 'WOS', externalId: { in: [...counts.keys()] } },
    select: { id: true, externalId: true },
  });
  const { count } = await client.citationObservation.createMany({
    data: records.map((record) => ({
      sourceRecordId: record.id,
      provider: 'WOS' as const,
      database: 'WOS',
      count: counts.get(record.externalId)!,
      observedAt,
      syncTaskId,
    })),
    // UNIQUE(source_record_id, sync_task_id): a retried write of the same task adds nothing.
    skipDuplicates: true,
  });
  return count;
}
