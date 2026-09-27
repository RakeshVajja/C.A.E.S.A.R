import { Prisma, PrismaClient, PublicationStatus } from '@prisma/client';
import { prisma as defaultClient } from '../../config/database';
import type { NormalizedPublication } from '../normalization/normalizedPublication';
import { selectCanonicalMetadata } from './canonical';
import { evaluateDoiMatch, evaluateTitleMatch, PublicationSnapshot } from './rules';

/**
 * Matching & deduplication engine (Project_plan.md §8). Ingests one NormalizedPublication in
 * one transaction:
 *   1. same source + external ID   → update that source record
 *   2. normalized DOI match        → attach, unless a contradiction applies
 *   3. exact title + year ±1       → attach only when rules.evaluateTitleMatch allows it
 *   4. otherwise                   → new Publication, plus DuplicateCandidates for possible matches
 *
 * Professor relationships are not created here (Phase 4 / Phase 11 build on the result).
 * SUPPRESSED publications take part in matching so that they absorb their own source records and
 * never reappear as new publications; callers must not create professor links for them
 * (`IngestResult.publicationStatus`, decision #30).
 */

type Tx = Prisma.TransactionClient;

export type IngestOutcome = 'UPDATED_EXISTING' | 'MATCHED_DOI' | 'MATCHED_TITLE_YEAR' | 'NEW_PUBLICATION';

export interface IngestResult {
  outcome: IngestOutcome;
  publicationId: string;
  sourceRecordId: string;
  candidatesCreated: number;
  /**
   * Status of the publication the record ended up on. A SUPPRESSED publication absorbs matching
   * source records (provenance only, so it never reappears as a new publication) but must never
   * receive professor links automatically (§6.4, §14; decision #30).
   */
  publicationStatus: PublicationStatus;
}

export interface IngestOptions {
  /** When the source reported this record (sync); omit for manual entries. */
  seenAt?: Date;
  /** The professor/admin who entered a MANUAL record. */
  createdByUserId?: string | null;
  client?: PrismaClient;
}

interface PossibleDuplicate {
  publicationId: string;
  reason: string;
}

type Decision =
  | { kind: 'attach'; publicationId: string; method: 'DOI' | 'TITLE_YEAR'; detail: string }
  | { kind: 'new'; possibleDuplicates: PossibleDuplicate[]; detail: string };

export async function ingestPublication(
  record: NormalizedPublication,
  options: IngestOptions = {},
): Promise<IngestResult> {
  const client = options.client ?? defaultClient;
  const run = () => client.$transaction((tx) => ingestInTransaction(tx, record, options));

  try {
    return await run();
  } catch (error) {
    // A concurrent ingest may have created the same source record or claimed the same DOI;
    // re-running sees the committed state and takes rule 1 / rule 2 instead.
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') return run();
    throw error;
  }
}

async function ingestInTransaction(tx: Tx, record: NormalizedPublication, options: IngestOptions): Promise<IngestResult> {
  const result = await applyRules(tx, record, options);
  const { status } = await tx.publication.findUniqueOrThrow({
    where: { id: result.publicationId },
    select: { status: true },
  });
  return { ...result, publicationStatus: status };
}

async function applyRules(
  tx: Tx,
  record: NormalizedPublication,
  options: IngestOptions,
): Promise<Omit<IngestResult, 'publicationStatus'>> {
  const existing = await tx.publicationSourceRecord.findUnique({
    where: { source_externalId: { source: record.source, externalId: record.externalId } },
  });

  // Rule 1: same source + external ID → update the existing source record in place.
  if (existing) {
    await tx.publicationSourceRecord.update({
      where: { id: existing.id },
      data: {
        ...sourceRecordFields(record),
        lastSeenAt: options.seenAt ?? existing.lastSeenAt,
      },
    });

    // A changed DOI never moves the record to another publication (§8.3); flag it instead.
    let candidatesCreated = 0;
    const otherOwners = (await findDoiOwners(tx, record.dois)).filter((id) => id !== existing.publicationId);
    for (const otherId of otherOwners) {
      const reason = `Source record ${record.source}:${record.externalId} reports a DOI that belongs to another publication`;
      if (await createDuplicateCandidate(tx, existing.publicationId, otherId, reason)) candidatesCreated++;
    }

    await recomputeCanonical(tx, existing.publicationId);
    return {
      outcome: 'UPDATED_EXISTING',
      publicationId: existing.publicationId,
      sourceRecordId: existing.id,
      candidatesCreated,
    };
  }

  const decision = await decide(tx, record);

  if (decision.kind === 'attach') {
    const sourceRecord = await tx.publicationSourceRecord.create({
      data: {
        ...sourceRecordFields(record),
        publicationId: decision.publicationId,
        matchMethod: decision.method,
        matchDetail: decision.detail,
        createdByUserId: options.createdByUserId ?? null,
        lastSeenAt: options.seenAt ?? null,
      },
    });
    await recomputeCanonical(tx, decision.publicationId);
    return {
      outcome: decision.method === 'DOI' ? 'MATCHED_DOI' : 'MATCHED_TITLE_YEAR',
      publicationId: decision.publicationId,
      sourceRecordId: sourceRecord.id,
      candidatesCreated: 0,
    };
  }

  // Rule 4: new canonical publication (canonical fields, including the DOI, are then derived
  // from its source record; a DOI already owned by another publication is not copied).
  const publication = await tx.publication.create({
    data: {
      title: record.title,
      normalizedTitle: record.normalizedTitle,
      year: record.year,
      venue: record.venue,
      typeFamily: record.typeFamily,
      authorNamesDisplay: record.authorNamesDisplay,
    },
  });
  const sourceRecord = await tx.publicationSourceRecord.create({
    data: {
      ...sourceRecordFields(record),
      publicationId: publication.id,
      matchMethod: 'NEW_PUBLICATION',
      matchDetail: decision.detail,
      createdByUserId: options.createdByUserId ?? null,
      lastSeenAt: options.seenAt ?? null,
    },
  });
  await recomputeCanonical(tx, publication.id);

  let candidatesCreated = 0;
  for (const duplicate of decision.possibleDuplicates) {
    if (await createDuplicateCandidate(tx, publication.id, duplicate.publicationId, duplicate.reason)) {
      candidatesCreated++;
    }
  }

  return { outcome: 'NEW_PUBLICATION', publicationId: publication.id, sourceRecordId: sourceRecord.id, candidatesCreated };
}

/** Rules 2–4 for a record that is not yet stored. */
async function decide(tx: Tx, record: NormalizedPublication): Promise<Decision> {
  // Rule 2: DOI.
  const doiOwners = await findDoiOwners(tx, record.dois);
  if (doiOwners.length > 1) {
    const reason = `DOI(s) ${record.dois.join(', ')} match ${doiOwners.length} different publications`;
    return {
      kind: 'new',
      possibleDuplicates: doiOwners.map((publicationId) => ({ publicationId, reason })),
      detail: `No automatic match: ${reason}`,
    };
  }
  if (doiOwners.length === 1) {
    const [owner] = await loadSnapshots(tx, doiOwners);
    const evaluation = evaluateDoiMatch(record, owner);
    if (evaluation.kind === 'match') {
      const shared = record.dois.find((doi) => owner.dois.includes(doi));
      return { kind: 'attach', publicationId: owner.id, method: 'DOI', detail: `Matched on DOI ${shared}` };
    }
    return {
      kind: 'new',
      possibleDuplicates: [{ publicationId: owner.id, reason: `DOI match blocked: ${evaluation.reason}` }],
      detail: `No automatic match: DOI match blocked (${evaluation.reason})`,
    };
  }

  // Rule 3: exact normalized title + year ±1 (subject to vetoes).
  const titleMatches = await loadSnapshots(tx, await findTitleMatches(tx, record.normalizedTitle));
  const mergeable: PublicationSnapshot[] = [];
  const blocked: PossibleDuplicate[] = [];
  for (const snapshot of titleMatches) {
    const evaluation = evaluateTitleMatch(record, snapshot);
    if (evaluation.kind === 'merge') mergeable.push(snapshot);
    else blocked.push({ publicationId: snapshot.id, reason: `Exact title match blocked: ${evaluation.reasons.join('; ')}` });
  }

  if (mergeable.length === 1) {
    const [target] = mergeable;
    return {
      kind: 'attach',
      publicationId: target.id,
      method: 'TITLE_YEAR',
      detail: `Matched on exact normalized title, year ${record.year} vs ${target.year}, type ${record.typeFamily}`,
    };
  }
  if (mergeable.length > 1) {
    const reason = `Exact title match is ambiguous: ${mergeable.length} publications qualify`;
    return {
      kind: 'new',
      possibleDuplicates: titleMatches.map((snapshot) => ({ publicationId: snapshot.id, reason })),
      detail: `No automatic match: ${reason}`,
    };
  }
  if (blocked.length > 0) {
    return {
      kind: 'new',
      possibleDuplicates: blocked,
      detail: `No automatic match: ${blocked.length} exact-title match(es) blocked by vetoes`,
    };
  }
  return { kind: 'new', possibleDuplicates: [], detail: 'No matching publication' };
}

/**
 * Publications that own any of the DOIs. The canonical DOI owner takes precedence; source-record
 * DOIs — primary (`doi` column) and secondary (`raw_metadata`, §6.5) — are only consulted when no
 * publication carries the DOI canonically.
 */
async function findDoiOwners(tx: Tx, dois: readonly string[]): Promise<string[]> {
  if (dois.length === 0) return [];

  const canonicalOwners = await tx.publication.findMany({
    where: { doi: { in: [...dois] } },
    select: { id: true },
    orderBy: { id: 'asc' },
  });
  if (canonicalOwners.length > 0) return canonicalOwners.map((p) => p.id);

  const recordOwners = await tx.publicationSourceRecord.findMany({
    where: {
      OR: [
        { doi: { in: [...dois] } },
        ...dois.map((doi) => ({ rawMetadata: { path: [RAW_METADATA_DOIS_KEY], array_contains: [doi] } })),
      ],
    },
    select: { publicationId: true },
    distinct: ['publicationId'],
    orderBy: { publicationId: 'asc' },
  });
  return recordOwners.map((r) => r.publicationId);
}

async function findTitleMatches(tx: Tx, normalizedTitle: string): Promise<string[]> {
  const publications = await tx.publication.findMany({
    where: {
      OR: [{ normalizedTitle }, { sourceRecords: { some: { normalizedTitle } } }],
    },
    select: { id: true },
    orderBy: { id: 'asc' },
  });
  return publications.map((p) => p.id);
}

async function loadSnapshots(tx: Tx, publicationIds: readonly string[]): Promise<PublicationSnapshot[]> {
  if (publicationIds.length === 0) return [];
  const publications = await tx.publication.findMany({
    where: { id: { in: [...publicationIds] } },
    include: { sourceRecords: { select: { doi: true, normalizedTitle: true, rawMetadata: true } } },
    orderBy: { id: 'asc' },
  });
  return publications.map((p) => ({
    id: p.id,
    year: p.year,
    typeFamily: p.typeFamily,
    dois: unique([p.doi, ...p.sourceRecords.flatMap((r) => [r.doi, ...storedDois(r.rawMetadata)])]),
    normalizedTitles: unique([p.normalizedTitle, ...p.sourceRecords.map((r) => r.normalizedTitle)]),
  }));
}

/** Re-derives canonical fields from source records (§9); curated publications are left untouched. */
export async function recomputeCanonical(tx: Tx, publicationId: string): Promise<void> {
  const publication = await tx.publication.findUniqueOrThrow({
    where: { id: publicationId },
    include: { sourceRecords: true },
  });
  if (publication.isCurated || publication.sourceRecords.length === 0) return;

  const candidateDois = unique(publication.sourceRecords.map((r) => r.doi));
  const taken = new Set(
    (
      await tx.publication.findMany({
        where: { doi: { in: candidateDois }, id: { not: publicationId } },
        select: { doi: true },
      })
    ).map((p) => p.doi),
  );

  const canonical = selectCanonicalMetadata(publication.sourceRecords, (doi) => taken.has(doi));
  await tx.publication.update({ where: { id: publicationId }, data: canonical });
}

/**
 * Records a possible duplicate pair (stored once, in canonical order a < b).
 * An existing pair — including a DISMISSED one — is left unchanged. Returns true if created.
 */
export async function createDuplicateCandidate(tx: Tx, x: string, y: string, reason: string): Promise<boolean> {
  if (x === y) return false;
  const [publicationAId, publicationBId] = x < y ? [x, y] : [y, x];
  const existing = await tx.duplicateCandidate.findUnique({
    where: { publicationAId_publicationBId: { publicationAId, publicationBId } },
    select: { id: true },
  });
  if (existing) return false;
  await tx.duplicateCandidate.create({ data: { publicationAId, publicationBId, reason } });
  return true;
}

/**
 * Key under which every normalized DOI of a source record is kept in raw_metadata (§6.5): the
 * first DOI also goes to the `doi` column; secondary DOIs are only here, and matching searches them.
 */
export const RAW_METADATA_DOIS_KEY = '_normalizedDois';

function sourceRecordFields(record: NormalizedPublication) {
  return {
    source: record.source,
    externalId: record.externalId,
    title: record.title,
    normalizedTitle: record.normalizedTitle,
    doi: record.dois[0] ?? null,
    year: record.year,
    venue: record.venue,
    typeFamily: record.typeFamily,
    authorNamesDisplay: record.authorNamesDisplay,
    rawMetadata: rawMetadataWithDois(record),
  };
}

/** The source payload, plus the full normalized DOI list under RAW_METADATA_DOIS_KEY. */
function rawMetadataWithDois(record: NormalizedPublication): Prisma.InputJsonValue | typeof Prisma.DbNull {
  const payload = record.rawMetadata;
  if (record.dois.length === 0) {
    return payload === null ? Prisma.DbNull : (payload as Prisma.InputJsonValue);
  }
  const base =
    payload !== null && typeof payload === 'object' && !Array.isArray(payload)
      ? payload
      : payload === null
        ? {}
        : { payload }; // a non-object payload is kept intact under "payload"
  return { ...base, [RAW_METADATA_DOIS_KEY]: [...record.dois] } as Prisma.InputJsonValue;
}

function storedDois(rawMetadata: Prisma.JsonValue): string[] {
  if (rawMetadata === null || typeof rawMetadata !== 'object' || Array.isArray(rawMetadata)) return [];
  const value = (rawMetadata as Prisma.JsonObject)[RAW_METADATA_DOIS_KEY];
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

function unique(values: ReadonlyArray<string | null>): string[] {
  return [...new Set(values.filter((v): v is string => typeof v === 'string' && v.length > 0))];
}
