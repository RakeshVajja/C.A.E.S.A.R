import { createHash } from 'crypto';
import { Prisma, PrismaClient, PublicationSource } from '@prisma/client';
import { recomputeCanonical, Tx } from '../matching/engine';
import { SOURCE_PRIORITY } from '../matching/canonical';
import { Curation, CURATED_FIELDS, CuratedField, curationJson, isRetainable, readCuration } from '../publications/curation';

/**
 * Provider-data removal (Project_plan.md §13.10, §22.4; decisions #121, #124, #125). An
 * administrator command-line procedure (scripts/provider-removal.ts) in three steps:
 *
 *   1. plan     read-only; classifies everything derived from the provider and every affected
 *               publication, and yields a report without provider content plus a fingerprint;
 *   2. approve  the administrator passes that fingerprint back;
 *   3. execute  one transaction under the synchronization guard: the plan is rebuilt and must have
 *               the same fingerprint (any change aborts), then the provider's data is deleted and
 *               surviving publications are recomputed.
 *
 * A provider's data: its source records (with raw_metadata) and their citation observations;
 * MANUAL entries whose basis names it; curation entries whose basis names it; for JCR every
 * journal with its ISSNs, snapshots and category metrics (publication journal links become NULL);
 * and the error messages of its synchronization tasks. Duplicate-candidate reasons quoting a
 * removed record's key are rewritten. External identities of the provider are reported, not
 * deleted (an identifier of the professor, not provider content).
 *
 * Affected publications are classified: SUPPORTED (another source record remains) — kept,
 * recomputed from the remaining records by §9, retained curated fields excepted, professor
 * decisions untouched; CURATED_ONLY (no record remains, but a retained curated title) — kept with
 * its retained curated values only; UNSUPPORTED — deleted with its professor relationships
 * (APPROVED and REJECTED alike), its candidates' references becoming NULL. Only curated values that
 * are INDEPENDENT with evidence and not excluded by the administrator, or PRE_PHASE15 values the
 * administrator explicitly decided to KEEP, are retained. PRE_PHASE15 values ("edited before basis
 * recording") have unknown provenance: each affected one is listed individually and needs an explicit
 * KEEP or REMOVE decision, the decisions are part of the fingerprint, and execution is refused while
 * any is unresolved (#145). MANUAL records with a missing basis or evidence are likewise of unknown
 * provenance: each one that would otherwise be retained is listed and needs an explicit KEEP or
 * REMOVE (exclusion), fingerprinted, before execution (#146). INDEPENDENT values and manual entries are listed for review and remain
 * subject to Clarivate's written confirmation.
 *
 * Deleting rows is not secure erasure: old row versions persist on disk, in WAL and in backups
 * until overwritten or expired. VACUUM is ordinary maintenance run separately, never here; backups
 * and WAL archives need the separate expiry/purge process of Phase 16, with the execution report
 * kept alongside them so the removal is re-applied after any restore.
 */

export const REMOVABLE_PROVIDERS = ['SCOPUS', 'WOS', 'JCR'] as const;
export type RemovableProvider = (typeof REMOVABLE_PROVIDERS)[number];

export interface RemovalExclusions {
  /** INDEPENDENT curation entries of affected publications the administrator does not retain. */
  curation: { publicationId: string; field: CuratedField }[];
  /** MANUAL records of affected publications the administrator does not retain. */
  manualRecords: string[];
  /**
   * The administrator's decision for each PRE_PHASE15 curated field of an affected publication
   * (#145); a field without a decision is unresolved and blocks execution. Optional for callers;
   * always present in a plan.
   */
  legacy?: { publicationId: string; field: CuratedField; decision: LegacyDecision }[];
  /**
   * MANUAL records of unknown provenance (missing `entry_basis` or `entry_evidence`) the
   * administrator explicitly keeps (#146). Removing one is an entry in `manualRecords`; one with
   * neither decision is unresolved and blocks execution. Optional for callers; always present in a plan.
   */
  keepManual?: string[];
}

export type LegacyDecision = 'KEEP' | 'REMOVE';

export type RecordReason = 'PROVIDER_RECORD' | 'MANUAL_DERIVED' | 'MANUAL_EXCLUDED';
export type PublicationClass = 'SUPPORTED' | 'CURATED_ONLY' | 'UNSUPPORTED';
export type CurationRemovalReason = 'PROVIDER_DERIVED' | 'EXCLUDED' | 'NO_EVIDENCE' | 'LEGACY_REMOVE';

export interface RemovalPlan {
  provider: RemovableProvider;
  exclusions: RemovalExclusions;
  sourceRecords: { id: string; publicationId: string; source: PublicationSource; reason: RecordReason }[];
  citationObservationIds: string[];
  journals: { id: string; issns: number; snapshots: number; categoryMetrics: number; linkedPublications: number }[];
  curationRemoved: { publicationId: string; field: CuratedField; basis: string; reason: CurationRemovalReason }[];
  /** Retained INDEPENDENT curation entries of affected publications, with their evidence, for review. */
  curationReview: { publicationId: string; field: CuratedField; evidence: string | null }[];
  /**
   * Every PRE_PHASE15 ("edited before basis recording") curated field of an affected publication,
   * with the administrator's decision; null = unresolved (treated as not retained in this plan, and
   * execution is refused).
   */
  legacyReview: { publicationId: string; field: CuratedField; decision: LegacyDecision | null }[];
  /**
   * Every MANUAL record of an affected publication with a missing basis or evidence (unknown
   * provenance, #146) that is not removed anyway as the provider's data, with the administrator's
   * decision: KEEP (`keepManual`), REMOVE (`manualRecords`) or null = unresolved (treated as not
   * supporting the publication in this plan, and execution is refused).
   */
  unknownManualReview: { recordId: string; publicationId: string; basis: string | null; evidence: string | null; decision: LegacyDecision | null }[];
  /** Retained MANUAL entries of affected publications with a declared basis and evidence, for review. */
  manualReview: { recordId: string; publicationId: string; basis: string | null; evidence: string | null }[];
  publications: {
    id: string;
    status: string;
    class: PublicationClass;
    remainingSources: PublicationSource[];
    retainedCuration: CuratedField[];
    relationships: { id: string; professorId: string; status: string; origin: string }[];
  }[];
  candidateIdsNulled: string[];
  candidateIdsReworded: string[];
  syncTaskIdsCleared: string[];
  identitiesRetained: { id: string; professorId: string }[];
}

export interface RemovalReport {
  kind: 'PROVIDER_REMOVAL_PLAN' | 'PROVIDER_REMOVAL_EXECUTED';
  provider: RemovableProvider;
  fingerprint: string;
  generatedAt: string;
  summary: Record<string, number>;
  plan: RemovalPlan;
  /** Execution only: publications recomputed because a DOI they carry was released. */
  recomputedForReleasedDoi?: string[];
  notes: string[];
}

export class RemovalError extends Error {
  constructor(
    readonly code: 'INVALID_EXCLUSION' | 'INVALID_DECISION' | 'LEGACY_UNRESOLVED' | 'PLAN_CHANGED' | 'SYNC_RUNNING' | 'LOCK_TIMEOUT',
    message: string,
  ) {
    super(message);
  }
}

const NOTES = [
  'The report holds internal IDs, counts, field names and the declared bases and evidence of retained values only — no provider content.',
  'INDEPENDENT values are declarations, not proof of legal independence; their retention remains subject to Clarivate\'s written confirmation.',
  'Deleting rows is not secure erasure. VACUUM is ordinary maintenance, run separately and never inside the removal transaction.',
  'Database backups and WAL archives cannot be edited: they expire under the separate Phase 16 purge process; keep the execution report with the backups so the removal is re-applied after any restore.',
  'Developer copies (development/test databases, local recorded responses, scratch files) and any administrator exports are deleted by procedure.',
];

/** The fingerprint of a plan: SHA-256 of its canonical JSON (the plan is built in a fixed order). */
export function planFingerprint(plan: RemovalPlan): string {
  return createHash('sha256').update(JSON.stringify(plan)).digest('hex');
}

/** Step 1: the read-only plan, built in one read-only REPEATABLE READ snapshot. */
export async function planProviderRemoval(
  provider: RemovableProvider,
  exclusions: RemovalExclusions,
  options: { client: PrismaClient; now: () => Date },
): Promise<RemovalReport> {
  const plan = await options.client.$transaction(
    async (tx) => {
      await tx.$executeRaw`SET TRANSACTION READ ONLY`;
      return buildPlan(tx, provider, exclusions);
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead, timeout: 600_000, maxWait: 30_000 },
  );
  return report('PROVIDER_REMOVAL_PLAN', plan, options.now());
}

/** Steps 2–3: executes the plan only when it still has the approved fingerprint. */
export async function executeProviderRemoval(
  provider: RemovableProvider,
  exclusions: RemovalExclusions,
  approvedFingerprint: string,
  options: { client: PrismaClient; now: () => Date; lockTimeoutMs?: number },
): Promise<RemovalReport> {
  try {
    return await options.client.$transaction(
      async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL lock_timeout = '${Math.max(1, Math.floor(options.lockTimeoutMs ?? 10_000))}ms'`);
        // The synchronization guard across processes: no run may start (a run inserts a sync_runs
        // row) while this transaction holds the lock, and a run in progress refuses the removal.
        await tx.$executeRaw`LOCK TABLE sync_runs IN EXCLUSIVE MODE`;
        if (await tx.syncRun.findFirst({ where: { status: 'RUNNING' }, select: { id: true } })) {
          throw new RemovalError('SYNC_RUNNING', 'A synchronization run is in progress; run the removal when it has finished');
        }
        // Concurrent writers (manual entries, merges, detachments, edits) wait until the removal ends.
        await tx.$executeRaw`LOCK TABLE publications, publication_source_records, professor_publications, duplicate_candidates,
          citation_observations, journals, journal_issns, journal_metric_snapshots, journal_category_metrics,
          sync_tasks, external_identities IN SHARE ROW EXCLUSIVE MODE`;

        const plan = await buildPlan(tx, provider, exclusions);
        const unresolvedFields = plan.legacyReview.filter((l) => l.decision === null).length;
        const unresolvedManual = plan.unknownManualReview.filter((m) => m.decision === null).length;
        if (unresolvedFields > 0 || unresolvedManual > 0) {
          throw new RemovalError(
            'LEGACY_UNRESOLVED',
            `${unresolvedFields} curated field(s) edited before basis recording and ${unresolvedManual} manual entr${unresolvedManual === 1 ? 'y' : 'ies'} without basis or evidence need an explicit KEEP or REMOVE decision; nothing was removed`,
          );
        }
        if (planFingerprint(plan) !== approvedFingerprint) {
          throw new RemovalError('PLAN_CHANGED', 'The data changed since the plan was approved (fingerprint differs); nothing was removed. Create and review a new plan');
        }
        const recomputed = await applyPlan(tx, plan);
        return { ...report('PROVIDER_REMOVAL_EXECUTED', plan, options.now()), recomputedForReleasedDoi: recomputed };
      },
      { timeout: 600_000, maxWait: 30_000 },
    );
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError || error instanceof Prisma.PrismaClientUnknownRequestError) {
      if (/lock timeout|55P03/i.test(error.message)) {
        throw new RemovalError('LOCK_TIMEOUT', 'Other database work held the tables too long; nothing was removed. Try again when the application is idle');
      }
    }
    throw error;
  }
}

function report(kind: RemovalReport['kind'], plan: RemovalPlan, now: Date): RemovalReport {
  const count = (c: PublicationClass) => plan.publications.filter((p) => p.class === c).length;
  const deleted = plan.publications.filter((p) => p.class === 'UNSUPPORTED');
  return {
    kind,
    provider: plan.provider,
    fingerprint: planFingerprint(plan),
    generatedAt: now.toISOString(),
    summary: {
      sourceRecords: plan.sourceRecords.length,
      providerRecords: plan.sourceRecords.filter((r) => r.reason === 'PROVIDER_RECORD').length,
      manualEntriesDerived: plan.sourceRecords.filter((r) => r.reason === 'MANUAL_DERIVED').length,
      manualEntriesExcluded: plan.sourceRecords.filter((r) => r.reason === 'MANUAL_EXCLUDED').length,
      citationObservations: plan.citationObservationIds.length,
      journals: plan.journals.length,
      journalLinks: plan.journals.reduce((n, j) => n + j.linkedPublications, 0),
      curationEntriesRemoved: plan.curationRemoved.length,
      curationEntriesForReview: plan.curationReview.length,
      legacyFieldsForDecision: plan.legacyReview.length,
      legacyFieldsUnresolved: plan.legacyReview.filter((l) => l.decision === null).length,
      manualEntriesForReview: plan.manualReview.length,
      unknownManualEntriesForDecision: plan.unknownManualReview.length,
      unknownManualEntriesUnresolved: plan.unknownManualReview.filter((m) => m.decision === null).length,
      affectedPublications: plan.publications.length,
      publicationsSupported: count('SUPPORTED'),
      publicationsCuratedOnly: count('CURATED_ONLY'),
      publicationsDeleted: deleted.length,
      relationshipsDeleted: deleted.reduce((n, p) => n + p.relationships.length, 0),
      candidatesNulled: plan.candidateIdsNulled.length,
      candidatesReworded: plan.candidateIdsReworded.length,
      syncTaskMessagesCleared: plan.syncTaskIdsCleared.length,
      identitiesRetained: plan.identitiesRetained.length,
    },
    plan,
    notes: NOTES,
  };
}

const byId = <T extends { id: string }>(a: T, b: T) => a.id.localeCompare(b.id);

/** A MANUAL record whose provenance is unknown: no declared basis or no evidence (#146). */
function isUnknownManual(record: { source: PublicationSource; entryBasis: string | null; entryEvidence: string | null }): boolean {
  return record.source === 'MANUAL' && (!record.entryBasis?.trim() || !record.entryEvidence?.trim());
}

async function buildPlan(tx: Tx, provider: RemovableProvider, exclusions: RemovalExclusions): Promise<RemovalPlan> {
  const excludedCuration = [...exclusions.curation].sort((a, b) => a.publicationId.localeCompare(b.publicationId) || a.field.localeCompare(b.field));
  const excludedManual = [...new Set(exclusions.manualRecords)].sort();
  const keptManual = [...new Set(exclusions.keepManual ?? [])].sort();
  const excludedKeys = new Set(excludedCuration.map((e) => `${e.publicationId}:${e.field}`));
  const legacyDecisions = new Map<string, LegacyDecision>();
  for (const d of exclusions.legacy ?? []) {
    const key = `${d.publicationId}:${d.field}`;
    if (legacyDecisions.has(key) && legacyDecisions.get(key) !== d.decision) {
      throw new RemovalError('INVALID_DECISION', `Both KEEP and REMOVE were given for curated ${d.field} of publication ${d.publicationId}`);
    }
    legacyDecisions.set(key, d.decision);
  }
  const legacy = [...legacyDecisions]
    .map(([key, decision]) => {
      const [publicationId, field] = key.split(':') as [string, CuratedField];
      return { publicationId, field, decision };
    })
    .sort((a, b) => a.publicationId.localeCompare(b.publicationId) || a.field.localeCompare(b.field));

  // Affected publications: a record of the provider, a MANUAL entry derived from it, or a curated
  // value derived from it (curation is JSON, so its basis is matched in SQL).
  const providerRecordSource = provider === 'JCR' ? [] : [provider];
  const seeds = await tx.publicationSourceRecord.findMany({
    where: { OR: [{ source: { in: providerRecordSource } }, { source: 'MANUAL', entryBasis: provider }] },
    select: { publicationId: true },
  });
  const curatedFromProvider = await tx.$queryRaw<{ id: string }[]>`
    SELECT p.id FROM publications p, jsonb_each(p.curation) AS e(field, entry)
    WHERE e.entry ->> 'basis' = ${provider}`;
  const affectedIds = [...new Set([...seeds.map((s) => s.publicationId), ...curatedFromProvider.map((p) => p.id)])].sort();

  const publications = await tx.publication.findMany({
    where: { id: { in: affectedIds } },
    select: {
      id: true,
      status: true,
      isCurated: true,
      curation: true,
      sourceRecords: { select: { id: true, source: true, entryBasis: true, entryEvidence: true }, orderBy: { id: 'asc' } },
      professors: { select: { id: true, professorId: true, status: true, origin: true }, orderBy: { id: 'asc' } },
    },
    orderBy: { id: 'asc' },
  });

  // Exclusions must name reviewable entries of affected publications, so a typo never passes silently.
  const curationOf = new Map(publications.map((p) => [p.id, readCuration(p)]));
  for (const e of excludedCuration) {
    if (curationOf.get(e.publicationId)?.[e.field]?.basis !== 'INDEPENDENT') {
      throw new RemovalError('INVALID_EXCLUSION', `No INDEPENDENT curated ${e.field} on an affected publication ${e.publicationId}`);
    }
  }
  for (const d of legacy) {
    if (curationOf.get(d.publicationId)?.[d.field]?.basis !== 'PRE_PHASE15') {
      throw new RemovalError('INVALID_DECISION', `No curated ${d.field} edited before basis recording on an affected publication ${d.publicationId}`);
    }
  }
  const manualOnAffected = new Map(publications.flatMap((p) => p.sourceRecords.filter((r) => r.source === 'MANUAL').map((r) => [r.id, r] as const)));
  for (const id of excludedManual) {
    const record = manualOnAffected.get(id);
    if (!record || record.entryBasis === provider) {
      throw new RemovalError('INVALID_EXCLUSION', `No retained manual entry ${id} on an affected publication`);
    }
  }
  for (const id of keptManual) {
    const record = manualOnAffected.get(id);
    if (!record || record.entryBasis === provider || !isUnknownManual(record)) {
      throw new RemovalError('INVALID_DECISION', `No manual entry ${id} without basis or evidence on an affected publication`);
    }
    if (excludedManual.includes(id)) throw new RemovalError('INVALID_DECISION', `Manual entry ${id} was both kept and excluded`);
  }

  const sourceRecords: RemovalPlan['sourceRecords'] = [];
  const curationRemoved: RemovalPlan['curationRemoved'] = [];
  const curationReview: RemovalPlan['curationReview'] = [];
  const legacyReview: RemovalPlan['legacyReview'] = [];
  const manualReview: RemovalPlan['manualReview'] = [];
  const unknownManualReview: RemovalPlan['unknownManualReview'] = [];
  const planned: RemovalPlan['publications'] = [];

  for (const publication of publications) {
    const remaining: PublicationSource[] = [];
    for (const record of publication.sourceRecords) {
      let reason: RecordReason | null = null;
      if (record.source === provider) reason = 'PROVIDER_RECORD';
      else if (record.source === 'MANUAL' && record.entryBasis === provider) reason = 'MANUAL_DERIVED';
      else if (record.source === 'MANUAL' && excludedManual.includes(record.id)) reason = 'MANUAL_EXCLUDED';
      const unknown = isUnknownManual(record) && reason !== 'MANUAL_DERIVED';
      if (unknown) {
        // Unknown provenance: never supports a publication without an explicit decision (#146).
        const decision = reason === 'MANUAL_EXCLUDED' ? 'REMOVE' : keptManual.includes(record.id) ? 'KEEP' : null;
        unknownManualReview.push({ recordId: record.id, publicationId: publication.id, basis: record.entryBasis, evidence: record.entryEvidence, decision });
        if (decision === null) continue;
      }
      if (reason) {
        sourceRecords.push({ id: record.id, publicationId: publication.id, source: record.source, reason });
        continue;
      }
      remaining.push(record.source);
      if (unknown) continue;
      if (record.source === 'MANUAL') {
        manualReview.push({ recordId: record.id, publicationId: publication.id, basis: record.entryBasis, evidence: record.entryEvidence });
      }
    }

    const curation = curationOf.get(publication.id)!;
    const retained: CuratedField[] = [];
    for (const field of CURATED_FIELDS) {
      const entry = curation[field];
      if (!entry) continue;
      let reason: CurationRemovalReason | null = null;
      if (entry.basis === provider) reason = 'PROVIDER_DERIVED';
      else if (excludedKeys.has(`${publication.id}:${field}`)) reason = 'EXCLUDED';
      else if (entry.basis === 'INDEPENDENT' && !isRetainable(entry)) reason = 'NO_EVIDENCE';
      else if (entry.basis === 'PRE_PHASE15') {
        // Unknown provenance: never retained without an explicit decision (#145).
        const decision = legacyDecisions.get(`${publication.id}:${field}`) ?? null;
        legacyReview.push({ publicationId: publication.id, field, decision });
        if (decision === null) continue;
        if (decision === 'REMOVE') reason = 'LEGACY_REMOVE';
      }
      if (reason) {
        curationRemoved.push({ publicationId: publication.id, field, basis: entry.basis, reason });
        continue;
      }
      retained.push(field);
      if (entry.basis === 'INDEPENDENT') curationReview.push({ publicationId: publication.id, field, evidence: entry.evidence });
    }

    const cls: PublicationClass = remaining.length > 0 ? 'SUPPORTED' : retained.includes('title') ? 'CURATED_ONLY' : 'UNSUPPORTED';
    planned.push({
      id: publication.id,
      status: publication.status,
      class: cls,
      remainingSources: SOURCE_PRIORITY.filter((s) => remaining.includes(s)),
      retainedCuration: retained,
      // Listed (IDs and decisions only) for deleted publications; survivors keep theirs untouched.
      relationships:
        cls === 'UNSUPPORTED'
          ? publication.professors.map((r) => ({ id: r.id, professorId: r.professorId, status: r.status, origin: r.origin }))
          : [],
    });
  }

  const removedRecordIds = sourceRecords.map((r) => r.id);
  const deletedIds = planned.filter((p) => p.class === 'UNSUPPORTED').map((p) => p.id);

  const observations = await tx.citationObservation.findMany({
    where: { sourceRecordId: { in: removedRecordIds } },
    select: { id: true },
    orderBy: { id: 'asc' },
  });

  const journals =
    provider === 'JCR'
      ? (
          await tx.journal.findMany({
            select: {
              id: true,
              _count: { select: { issns: true, snapshots: true, publications: true } },
              snapshots: { select: { _count: { select: { categoryMetrics: true } } } },
            },
            orderBy: { id: 'asc' },
          })
        ).map((j) => ({
          id: j.id,
          issns: j._count.issns,
          snapshots: j._count.snapshots,
          categoryMetrics: j.snapshots.reduce((n, s) => n + s._count.categoryMetrics, 0),
          linkedPublications: j._count.publications,
        }))
      : [];

  const candidatesNulled = await tx.duplicateCandidate.findMany({
    where: { OR: [{ publicationAId: { in: deletedIds } }, { publicationBId: { in: deletedIds } }] },
    select: { id: true },
    orderBy: { id: 'asc' },
  });
  const removedKeys = (
    await tx.publicationSourceRecord.findMany({ where: { id: { in: removedRecordIds }, source: { not: 'MANUAL' } }, select: { source: true, externalId: true } })
  ).map((r) => `${r.source}:${r.externalId}`);
  const reworded =
    removedKeys.length === 0
      ? []
      : (
          await tx.duplicateCandidate.findMany({
            where: { reason: { contains: `${provider}:` } },
            select: { id: true, reason: true },
            orderBy: { id: 'asc' },
          })
        ).filter((c) => removedKeys.some((key) => c.reason.includes(key)));

  const tasks = await tx.syncTask.findMany({
    where: {
      errorMessage: { not: null },
      ...(provider === 'JCR' ? { kind: 'JOURNAL_METRICS' as const } : { source: provider }),
    },
    select: { id: true },
    orderBy: { id: 'asc' },
  });

  const identities =
    provider === 'JCR'
      ? []
      : await tx.externalIdentity.findMany({ where: { source: provider }, select: { id: true, professorId: true }, orderBy: { id: 'asc' } });

  return {
    provider,
    exclusions: { curation: excludedCuration, manualRecords: excludedManual, legacy, keepManual: keptManual },
    sourceRecords: sourceRecords.sort(byId),
    citationObservationIds: observations.map((o) => o.id),
    journals,
    curationRemoved,
    curationReview,
    legacyReview,
    unknownManualReview,
    manualReview,
    publications: planned,
    candidateIdsNulled: candidatesNulled.map((c) => c.id),
    candidateIdsReworded: reworded.map((c) => c.id),
    syncTaskIdsCleared: tasks.map((t) => t.id),
    identitiesRetained: identities,
  };
}

/** Applies a verified plan inside the removal transaction; returns publications recomputed for released DOIs. */
async function applyPlan(tx: Tx, plan: RemovalPlan): Promise<string[]> {
  const affectedIds = plan.publications.map((p) => p.id);
  const deleted = plan.publications.filter((p) => p.class === 'UNSUPPORTED');
  const deletedIds = deleted.map((p) => p.id);
  const removedRecordIds = plan.sourceRecords.map((r) => r.id);

  // DOIs held by affected publications before the removal: a survivor may then take one (§9).
  const heldDois = (await tx.publication.findMany({ where: { id: { in: affectedIds }, doi: { not: null } }, select: { doi: true } })).map((p) => p.doi!);

  // 1. Run messages that could quote provider data; candidate reasons quoting removed record keys.
  await tx.syncTask.updateMany({ where: { id: { in: plan.syncTaskIdsCleared } }, data: { errorMessage: null } });
  if (plan.candidateIdsReworded.length > 0) {
    const records = await tx.publicationSourceRecord.findMany({
      where: { id: { in: removedRecordIds }, source: { not: 'MANUAL' } },
      select: { source: true, externalId: true },
    });
    for (const candidate of await tx.duplicateCandidate.findMany({ where: { id: { in: plan.candidateIdsReworded } }, select: { id: true, reason: true } })) {
      let reason = candidate.reason;
      for (const r of records) reason = reason.split(`${r.source}:${r.externalId}`).join(`[removed ${r.source} record]`);
      await tx.duplicateCandidate.update({ where: { id: candidate.id }, data: { reason } });
    }
  }

  // 2. The provider's source records (citation observations cascade), then unsupported publications
  //    with their relationships (candidate references become NULL).
  await tx.publicationSourceRecord.deleteMany({ where: { id: { in: removedRecordIds } } });
  await tx.professorPublication.deleteMany({ where: { publicationId: { in: deletedIds } } });
  await tx.publication.deleteMany({ where: { id: { in: deletedIds } } });

  // 3. JCR journal data (ISSNs, snapshots and category metrics cascade; publication and task links → NULL).
  if (plan.journals.length > 0) await tx.journal.deleteMany({ where: { id: { in: plan.journals.map((j) => j.id) } } });

  // 4. Survivors keep only their retained curation, then are recomputed from their remaining records.
  for (const p of plan.publications.filter((x) => x.class !== 'UNSUPPORTED')) {
    const current = await tx.publication.findUniqueOrThrow({ where: { id: p.id }, select: { isCurated: true, curation: true } });
    const full = readCuration(current);
    const kept: Curation = {};
    for (const field of p.retainedCuration) kept[field] = full[field];
    const data: Prisma.PublicationUpdateInput = { curation: curationJson(kept), isCurated: p.retainedCuration.length > 0 };
    if (p.class === 'CURATED_ONLY') {
      // No source record remains: every field without a retained value is emptied.
      if (!kept.year) data.year = null;
      if (!kept.venue) data.venue = null;
      if (!kept.type_family) data.typeFamily = 'OTHER';
      if (!kept.author_names_display) data.authorNamesDisplay = null;
      if (!kept.doi) data.doi = null;
    }
    await tx.publication.update({ where: { id: p.id }, data });
    await recomputeCanonical(tx, p.id);
  }

  // 5. A DOI released by the removal may now be the canonical DOI of another publication carrying it.
  const stillHeld = new Set(
    (await tx.publication.findMany({ where: { doi: { in: heldDois } }, select: { doi: true } })).map((p) => p.doi),
  );
  const released = heldDois.filter((doi) => !stillHeld.has(doi));
  const carriers = released.length
    ? (
        await tx.publication.findMany({
          where: { doi: null, id: { notIn: affectedIds }, sourceRecords: { some: { doi: { in: released } } } },
          select: { id: true },
          orderBy: { id: 'asc' },
        })
      ).map((p) => p.id)
    : [];
  for (const id of carriers) await recomputeCanonical(tx, id);
  return carriers;
}
