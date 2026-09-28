import type { PrismaClient } from '@prisma/client';
import { prisma as defaultClient } from '../../config/database';
import { env } from '../../config/env';
import { OpenAlexClient } from '../../integrations/openalex/client';
import { mapOpenAlexWork } from '../../integrations/openalex/mapper';
import { DiscoverySummary, ingestDiscoveredRecords } from './ingestDiscoveredRecords';

/**
 * Discovery for one OpenAlex identity (Project_plan.md §13.3, §14):
 *   validate identity → fetch every page → validate → map → normalize → match → write.
 * Nothing is written unless the complete fetch succeeded; any FetchError propagates to the
 * caller (the Phase 12 SyncTask records it as FAILED) and existing data stays untouched.
 */

export class DiscoveryPreconditionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DiscoveryPreconditionError';
  }
}

export interface OpenAlexDiscoverySummary extends DiscoverySummary {
  identityId: string;
  requestedAuthorId: string;
  /** The ID works were fetched with (differs when OpenAlex merged the author). */
  resolvedAuthorId: string;
  reportedCount: number;
}

export async function discoverOpenAlexIdentity(
  identityId: string,
  options: { client?: PrismaClient; openAlex?: OpenAlexClient; now?: () => Date } = {},
): Promise<OpenAlexDiscoverySummary> {
  const client = options.client ?? defaultClient;
  const openAlex = options.openAlex ?? new OpenAlexClient({ apiKey: env.openAlexApiKey });
  const now = options.now ?? (() => new Date());

  const identity = await client.externalIdentity.findUnique({
    where: { id: identityId },
    include: { professor: { select: { isActive: true } } },
  });
  if (!identity) throw new DiscoveryPreconditionError(`External identity ${identityId} not found`);
  if (identity.source !== 'OPENALEX') {
    throw new DiscoveryPreconditionError(`Identity ${identityId} is a ${identity.source} identity, not OPENALEX`);
  }
  // Identities of inactive professors, and inactive identities, are not synchronized (§6.10, §14).
  if (!identity.isActive) throw new DiscoveryPreconditionError(`Identity ${identityId} is inactive`);
  if (!identity.professor.isActive) {
    throw new DiscoveryPreconditionError(`The professor of identity ${identityId} is inactive`);
  }

  // 1. Fetch and validate everything first (throws FetchError; nothing written yet).
  const fetched = await openAlex.fetchAuthorWorks(identity.externalId);
  const seenAt = now();

  // 2. Write.
  const inputs = fetched.works.map(mapOpenAlexWork);
  const summary = await ingestDiscoveredRecords(
    { id: identity.id, professorId: identity.professorId },
    inputs,
    { seenAt, client },
  );

  if (fetched.author.merged) {
    // Logged, not auto-corrected: identities are admin-managed (§6.3).
    summary.warnings.unshift(
      `OpenAlex author ${fetched.author.requestedId} has been merged into ${fetched.author.authorId}; ` +
        'works were fetched with the new ID. The admin should update this identity.',
    );
  }

  return {
    ...summary,
    identityId: identity.id,
    requestedAuthorId: fetched.author.requestedId,
    resolvedAuthorId: fetched.author.authorId,
    reportedCount: fetched.reportedCount,
  };
}
