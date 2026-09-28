import type { PrismaClient } from '@prisma/client';
import { prisma as defaultClient } from '../../config/database';
import { ingestPublication } from '../matching/engine';
import {
  buildNormalizedPublication,
  NormalizationError,
  PublicationInput,
} from '../normalization/normalizedPublication';

/**
 * Source-independent write step for records discovered through one external identity
 * (Project_plan.md §11, §14). Runs only after the complete fetch has been validated.
 *
 * For every record: normalize → match (Phase 3 engine) → create a PENDING relationship
 * for the identity's professor if none exists. An existing relationship is never changed
 * (a REJECTED one stays rejected), and SUPPRESSED publications never get links (§6.4).
 */

export interface DiscoveryIdentity {
  id: string;
  professorId: string;
}

export interface DiscoverySummary {
  recordsFetched: number;
  /** Source records created (new to this system). */
  recordsNew: number;
  /** Existing source records updated (rule 1). */
  recordsUpdated: number;
  linksCreated: number;
  candidatesCreated: number;
  /** Records skipped because they could not be normalized (e.g. no title). */
  recordsSkipped: number;
  /** Records attached to SUPPRESSED publications (no link created). */
  suppressedMatches: number;
  warnings: string[];
}

export async function ingestDiscoveredRecords(
  identity: DiscoveryIdentity,
  inputs: readonly PublicationInput[],
  options: { seenAt: Date; client?: PrismaClient },
): Promise<DiscoverySummary> {
  const client = options.client ?? defaultClient;
  const summary: DiscoverySummary = {
    recordsFetched: inputs.length,
    recordsNew: 0,
    recordsUpdated: 0,
    linksCreated: 0,
    candidatesCreated: 0,
    recordsSkipped: 0,
    suppressedMatches: 0,
    warnings: [],
  };

  for (const input of inputs) {
    let record;
    try {
      record = buildNormalizedPublication(input);
    } catch (error) {
      if (!(error instanceof NormalizationError)) throw error;
      summary.recordsSkipped++;
      summary.warnings.push(`Skipped ${input.source}:${input.externalId || '(no id)'}: ${error.message}`);
      continue;
    }

    const result = await ingestPublication(record, { seenAt: options.seenAt, client });
    if (result.outcome === 'UPDATED_EXISTING') summary.recordsUpdated++;
    else summary.recordsNew++;
    summary.candidatesCreated += result.candidatesCreated;

    if (result.publicationStatus === 'SUPPRESSED') {
      summary.suppressedMatches++;
      continue;
    }

    // Create-only: skipDuplicates leaves any existing relationship (and its status) untouched.
    const { count } = await client.professorPublication.createMany({
      data: [
        {
          professorId: identity.professorId,
          publicationId: result.publicationId,
          status: 'PENDING',
          origin: 'DISCOVERED',
          discoveredViaIdentityId: identity.id,
        },
      ],
      skipDuplicates: true,
    });
    summary.linksCreated += count;
  }

  return summary;
}
