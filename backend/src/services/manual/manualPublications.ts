import { PrismaClient, TypeFamily } from '@prisma/client';
import { randomUUID } from 'crypto';
import { prisma as defaultClient } from '../../config/database';
import { HttpError } from '../../utils/httpError';
import { ingestPublication, IngestOutcome } from '../matching/engine';
import { serializeByTitle } from '../matching/titleSerialization';
import { normalizeDoi } from '../normalization/doi';
import { DeclaredBasis, isEntryEvidence } from '../publications/curation';
import { buildNormalizedPublication, NormalizationError } from '../normalization/normalizedPublication';
import { readItem } from '../verification/verification';

/**
 * Manual publication addition by a professor (Project_plan.md §12; Phase 11, decisions #77–#80).
 *
 *   normalize → match → duplicate detection → canonical Publication → ProfessorPublication
 *
 * The entry becomes a MANUAL source record and goes through the unchanged matching engine
 * (rules 1–3, vetoes, DuplicateCandidates, canonical priority, curated publications untouched).
 * In the same transaction the professor's relationship becomes APPROVED with origin MANUAL: created
 * if missing, upgraded from PENDING or REJECTED (§12.2), left unchanged if already APPROVED. A
 * match with a SUPPRESSED publication is refused and rolled back (#78). Only metadata is stored:
 * there are no fields for abstracts, full text or files. The entry declares its basis —
 * INDEPENDENT or the provider it was derived from — with a DOI or publisher/repository URL as
 * evidence (§12.1, #124, #125); retyping provider data never makes it independent, and an entry
 * derived from a provider is removed with that provider's data (providerRemoval.ts).
 */

export interface ManualPublicationInput {
  title: string;
  typeFamily: TypeFamily;
  doi?: string | null;
  year?: number | null;
  venue?: string | null;
  authorNames?: string | null;
  /** INDEPENDENT or the provider the entry was derived from (§12.1, #125). */
  basis: DeclaredBasis;
  /** DOI, publisher or repository URL supporting the entry. */
  evidence: string;
}

export type RelationshipChange = 'CREATED' | 'UPGRADED' | 'UNCHANGED';

export async function addManualPublication(
  professorId: string,
  userId: string,
  input: ManualPublicationInput,
  now: Date,
  client: PrismaClient = defaultClient,
) {
  // A DOI the professor typed must be usable: refuse it rather than silently dropping it (#79).
  let doi: string | null = null;
  if (input.doi) {
    doi = normalizeDoi(input.doi);
    if (!doi) throw new HttpError(400, 'INVALID_DOI', 'The DOI is not valid (expected e.g. 10.1234/abcd)');
  }

  const evidence = input.evidence.trim();
  if (!isEntryEvidence(evidence)) {
    throw new HttpError(400, 'INVALID_EVIDENCE', 'Give a DOI or a publisher or repository link (https://…) as evidence');
  }

  let record;
  try {
    record = buildNormalizedPublication({
      source: 'MANUAL',
      externalId: randomUUID(), // MANUAL external IDs are generated UUIDs (§6.5)
      title: input.title,
      dois: doi ? [doi] : [],
      year: input.year ?? null,
      venue: input.venue ?? null,
      typeFamily: input.typeFamily,
      authorNamesDisplay: input.authorNames ?? null,
    });
  } catch (error) {
    if (error instanceof NormalizationError) throw new HttpError(400, 'INVALID_TITLE', 'The title has no usable text');
    throw error;
  }

  let relationship: RelationshipChange = 'UNCHANGED';
  // Shared with synchronization ingestion (#80, #84): same-title records are matched one at a time.
  const result = await serializeByTitle(record.normalizedTitle, () =>
    ingestPublication(record, {
      client,
      createdByUserId: userId,
      entry: { basis: input.basis, evidence },
      onIngested: async (tx, ingested) => {
        if (ingested.publicationStatus === 'SUPPRESSED') {
          // Throwing rolls back the whole entry, including the source record (#78).
          throw new HttpError(409, 'PUBLICATION_SUPPRESSED', 'This publication was removed by the administrator and cannot be added');
        }
        const decided = { status: 'APPROVED' as const, origin: 'MANUAL' as const, decidedAt: now, decidedByUserId: userId };
        const created = await tx.professorPublication.createMany({
          data: [{ professorId, publicationId: ingested.publicationId, ...decided }],
          skipDuplicates: true,
        });
        if (created.count === 1) {
          relationship = 'CREATED';
          return;
        }
        const upgraded = await tx.professorPublication.updateMany({
          where: { professorId, publicationId: ingested.publicationId, status: { in: ['PENDING', 'REJECTED'] } },
          data: decided,
        });
        relationship = upgraded.count === 1 ? 'UPGRADED' : 'UNCHANGED';
      },
    }),
  );

  const link = await client.professorPublication.findUniqueOrThrow({
    where: { professorId_publicationId: { professorId, publicationId: result.publicationId } },
    select: { id: true },
  });
  return {
    item: await readItem(link.id, client),
    match: { outcome: result.outcome as IngestOutcome, candidatesCreated: result.candidatesCreated, relationship },
  };
}
