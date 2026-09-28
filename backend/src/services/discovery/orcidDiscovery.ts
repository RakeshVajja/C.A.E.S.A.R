import type { PrismaClient } from '@prisma/client';
import { prisma as defaultClient } from '../../config/database';
import { OrcidClient } from '../../integrations/orcid/client';
import { mapOrcidWorkSummary } from '../../integrations/orcid/mapper';
import { loadActiveIdentity } from './discoveryIdentity';
import { DiscoverySummary, ingestDiscoveredRecords } from './ingestDiscoveredRecords';

/**
 * Discovery for one ORCID identity (Project_plan.md §13.5, §14):
 *   validate iD → fetch the complete works list → validate → map → normalize → match → write.
 * Nothing is written unless the complete fetch succeeded; any FetchError propagates to the caller
 * (the Phase 12 SyncTask records it as FAILED) and existing data stays untouched. Once writing
 * starts, records are written one transaction at a time (as for OpenAlex and DBLP).
 */

export interface OrcidDiscoverySummary extends DiscoverySummary {
  identityId: string;
  orcid: string;
}

export async function discoverOrcidIdentity(
  identityId: string,
  options: { client?: PrismaClient; orcid?: OrcidClient; now?: () => Date } = {},
): Promise<OrcidDiscoverySummary> {
  const client = options.client ?? defaultClient;
  const orcidClient = options.orcid ?? new OrcidClient();
  const now = options.now ?? (() => new Date());

  const identity = await loadActiveIdentity(client, identityId, 'ORCID');

  // 1. Fetch and validate everything first (throws FetchError; nothing written yet).
  const fetched = await orcidClient.fetchWorks(identity.externalId);
  const seenAt = now();

  // 2. Write.
  const summary = await ingestDiscoveredRecords(
    { id: identity.id, professorId: identity.professorId },
    fetched.summaries.map((work) => mapOrcidWorkSummary(fetched.orcid, work)),
    { seenAt, client },
  );
  if (fetched.duplicatePutCodes.length > 0) {
    summary.warnings.push(
      `ORCID listed put-code(s) ${fetched.duplicatePutCodes.join(', ')} more than once; each was ingested once`,
    );
  }

  return { ...summary, identityId: identity.id, orcid: fetched.orcid };
}
