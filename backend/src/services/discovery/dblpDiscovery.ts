import type { PrismaClient } from '@prisma/client';
import { prisma as defaultClient } from '../../config/database';
import { DblpClient } from '../../integrations/dblp/client';
import { mapDblpPublication } from '../../integrations/dblp/mapper';
import { loadActiveIdentity } from './discoveryIdentity';
import { DiscoverySummary, ingestDiscoveredRecords } from './ingestDiscoveredRecords';

/**
 * Discovery for one DBLP identity (Project_plan.md §13.4, §14):
 *   validate person → fetch all authored records + authors → validate → map → normalize → match → write.
 * Nothing is written unless the complete fetch succeeded; any FetchError propagates to the caller
 * (the Phase 12 SyncTask records it as FAILED) and existing data stays untouched. Once writing
 * starts, records are written one transaction at a time (as for OpenAlex).
 */

export interface DblpDiscoverySummary extends DiscoverySummary {
  identityId: string;
  pid: string;
  personName: string | null;
}

export async function discoverDblpIdentity(
  identityId: string,
  options: { client?: PrismaClient; dblp?: DblpClient; now?: () => Date } = {},
): Promise<DblpDiscoverySummary> {
  const client = options.client ?? defaultClient;
  const dblp = options.dblp ?? new DblpClient();
  const now = options.now ?? (() => new Date());

  const identity = await loadActiveIdentity(client, identityId, 'DBLP');

  // 1. Fetch and validate everything first (throws FetchError; nothing written yet).
  const fetched = await dblp.fetchPersonPublications(identity.externalId);
  const seenAt = now();

  // 2. Write.
  const summary = await ingestDiscoveredRecords(
    { id: identity.id, professorId: identity.professorId },
    fetched.publications.map(mapDblpPublication),
    { seenAt, client },
  );

  return { ...summary, identityId: identity.id, pid: fetched.person.pid, personName: fetched.person.name };
}
