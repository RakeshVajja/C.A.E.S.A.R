import type { Prisma, PrismaClient, PublicationSource } from '@prisma/client';
import { FetchError } from '../../integrations/http/httpClient';
import { JcrClient } from '../../integrations/jcr/client';
import { journalProfile, JournalProfile, mapJournalReport, MappedReport } from '../../integrations/jcr/mapper';
import { openAlexIssns } from '../../integrations/openalex/mapper';
import { orcidIssns } from '../../integrations/orcid/mapper';
import { scopusIssns } from '../../integrations/scopus/mapper';
import { wosIssns } from '../../integrations/wos/mapper';
import { normalizeIssns } from '../normalization/issn';

/**
 * Journal Citation Reports enrichment (Project_plan.md §13.8, §22.4; stage 15.6). Journal-level
 * metrics only: nothing here creates, matches or changes publications' canonical metadata.
 *
 *   ISSNs       source records carry their journal's normalized ISSNs (`issns`); records stored
 *               before stage 15.6 are filled from their raw_metadata (backfillSourceRecordIssns)
 *   identify    ISSNs no known journal has → `GET /journals?q=<ISSN>` → each hit's profile and
 *               history; a hit is kept only when its own ISSNs include the searched one; journals
 *               are keyed by JCR id (upsert), their ISSN rows replaced from the profile
 *   link        `publications.journal_id` only when the publication's ISSNs identify exactly one
 *               journal (D10, #116); none or several → NULL (ambiguous ones reported)
 *   refresh     per journal (one JOURNAL_METRICS task each): profile, then the reports of the JCR
 *               years of its publications plus the latest available year (D9, #115) — fetched and
 *               validated first, then written in one transaction; a report whose normalized hash
 *               equals the latest snapshot of that journal and year adds nothing, anything else adds
 *               the next revision (D16, #122); snapshots are never updated or deleted here
 */

/** Credential, entitlement and quota failures stop the identification step (every request would fail). */
export function isAccessFailure(error: unknown): boolean {
  return error instanceof FetchError && (error.kind === 'AUTH_FAILED' || error.kind === 'NOT_ENTITLED' || error.kind === 'QUOTA_EXCEEDED');
}

/* ── ISSNs of stored source records ───────────────────────────────────────── */

const RAW_ISSNS: Partial<Record<PublicationSource, (raw: unknown) => string[]>> = {
  OPENALEX: openAlexIssns,
  ORCID: orcidIssns,
  SCOPUS: scopusIssns,
  WOS: wosIssns,
};

/**
 * Fills `issns` of source records stored before stage 15.6 (or never seen again since) from their
 * raw_metadata, with the same extraction the mappers use. Only records whose `issns` is empty are
 * read; nothing else is changed. Idempotent. Returns the number of records updated.
 */
export async function backfillSourceRecordIssns(client: PrismaClient, batchSize = 500): Promise<number> {
  let updated = 0;
  let after = '00000000-0000-0000-0000-000000000000';
  for (;;) {
    // Keyset paging on the id (records updated in a batch leave the filter, so no Prisma cursor).
    const records = await client.publicationSourceRecord.findMany({
      where: { id: { gt: after }, issns: { isEmpty: true }, source: { in: Object.keys(RAW_ISSNS) as PublicationSource[] }, rawMetadata: { not: { equals: null } } },
      select: { id: true, source: true, rawMetadata: true },
      orderBy: { id: 'asc' },
      take: batchSize,
    });
    if (records.length === 0) return updated;
    for (const record of records) {
      const issns = normalizeIssns(RAW_ISSNS[record.source]!(record.rawMetadata));
      if (issns.length === 0) continue;
      const { count } = await client.publicationSourceRecord.updateMany({ where: { id: record.id, issns: { isEmpty: true } }, data: { issns } });
      updated += count;
    }
    after = records[records.length - 1].id;
  }
}

/* ── Journal identification ───────────────────────────────────────────────── */

export interface IdentificationResult {
  issnsSearched: number;
  /** Searched ISSNs for which JCR has no journal. */
  issnsWithoutJournal: number;
  journalsAdded: number;
  journalsUpdated: number;
  /** ISSN searches or profile fetches that failed (other than access failures, which stop the step). */
  failures: number;
}

/** Every ISSN of a source record of an ACTIVE publication. */
async function publicationIssns(client: PrismaClient): Promise<Set<string>> {
  const records = await client.publicationSourceRecord.findMany({
    where: { NOT: { issns: { isEmpty: true } }, publication: { status: 'ACTIVE' } },
    select: { issns: true },
  });
  return new Set(records.flatMap((record) => record.issns));
}

/**
 * Finds the JCR journals of the ISSNs that no known journal has yet. Per-ISSN failures are counted
 * and the step continues; an access failure (401/403/429) is rethrown.
 */
export async function identifyJournals(client: PrismaClient, jcr: JcrClient): Promise<IdentificationResult> {
  const result: IdentificationResult = { issnsSearched: 0, issnsWithoutJournal: 0, journalsAdded: 0, journalsUpdated: 0, failures: 0 };
  const known = new Set((await client.journalIssn.findMany({ select: { issn: true } })).map((row) => row.issn));
  const wanted = [...(await publicationIssns(client))].filter((issn) => !known.has(issn)).sort();
  const profiles = new Map<string, JournalProfile | null>(); // per run: each journal fetched once

  for (const issn of wanted) {
    if (known.has(issn)) continue; // found meanwhile through another ISSN of the same journal
    result.issnsSearched++;
    try {
      const ids = await jcr.searchByIssn(issn);
      let matched = 0;
      for (const id of ids) {
        if (!profiles.has(id)) profiles.set(id, await fetchProfile(jcr, id));
        const profile = profiles.get(id);
        // Free-text search: only a journal whose own ISSNs include the searched one is accepted.
        if (!profile || !profile.issns.some((row) => row.issn === issn)) continue;
        matched++;
        const added = await saveJournal(client, profile);
        if (added) result.journalsAdded++;
        else result.journalsUpdated++;
        for (const row of profile.issns) known.add(row.issn);
      }
      if (matched === 0) result.issnsWithoutJournal++;
    } catch (error) {
      if (isAccessFailure(error)) throw error;
      result.failures++;
      console.warn(`JCR identification: ISSN ${issn} failed (${error instanceof FetchError ? `${error.kind}: ${error.message}` : 'unexpected error'})`);
    }
  }
  return result;
}

async function fetchProfile(jcr: JcrClient, id: string): Promise<JournalProfile> {
  const record = await jcr.journal(id);
  const history = await jcr.history(id);
  return journalProfile(record, history);
}

/**
 * Creates or updates a journal (keyed by JCR id) and replaces its ISSN rows with the profile's.
 * Returns true when the journal is new.
 */
export async function saveJournal(client: PrismaClient, profile: JournalProfile): Promise<boolean> {
  return client.$transaction(async (tx) => {
    const existing = await tx.journal.findUnique({ where: { jcrId: profile.jcrId }, select: { id: true } });
    const journalId = existing?.id ?? (await tx.journal.create({ data: { jcrId: profile.jcrId, ...journalFields(profile) } })).id;
    await writeProfile(tx, journalId, profile);
    return !existing;
  });
}

/** The profile fields stored on `journals` (profile data is updated in place; metrics never are). */
function journalFields(profile: JournalProfile) {
  return {
    name: profile.name,
    jcrTitle: profile.jcrTitle,
    isoTitle: profile.isoTitle,
    publisherName: profile.publisherName,
    firstIssueYear: profile.firstIssueYear,
    frequency: profile.frequency,
    language: profile.language,
  };
}

/** Updates a journal's profile and replaces its ISSN rows with the profile's. */
async function writeProfile(tx: Prisma.TransactionClient, journalId: string, profile: JournalProfile): Promise<void> {
  await tx.journal.update({ where: { id: journalId }, data: journalFields(profile) });
  await tx.journalIssn.deleteMany({ where: { journalId, issn: { notIn: profile.issns.map((row) => row.issn) } } });
  for (const row of profile.issns) {
    await tx.journalIssn.upsert({
      where: { journalId_issn: { journalId, issn: row.issn } },
      create: { journalId, ...row },
      update: { kind: row.kind, validFromYear: row.validFromYear, validToYear: row.validToYear },
    });
  }
}

/* ── Publication ↔ journal links (D10) ────────────────────────────────────── */

export interface LinkResult {
  /** Publications whose journal changed (linked, relinked or unlinked). */
  changed: number;
  /** Publications currently linked to exactly one journal. */
  linked: number;
  /** Publications whose ISSNs belong to more than one journal: left unlinked. */
  ambiguous: number;
}

/**
 * Sets `journal_id` for every publication whose source-record ISSNs identify exactly one journal,
 * and clears it where they identify none or several (an ISSN shared by two journals is never
 * linked). Only journal links change.
 */
export async function linkPublications(client: PrismaClient): Promise<LinkResult> {
  const journalsByIssn = new Map<string, Set<string>>();
  for (const row of await client.journalIssn.findMany({ select: { issn: true, journalId: true } })) {
    if (!journalsByIssn.has(row.issn)) journalsByIssn.set(row.issn, new Set());
    journalsByIssn.get(row.issn)!.add(row.journalId);
  }
  const target = new Map<string, Set<string>>();
  for (const record of await client.publicationSourceRecord.findMany({ where: { NOT: { issns: { isEmpty: true } } }, select: { publicationId: true, issns: true } })) {
    if (!target.has(record.publicationId)) target.set(record.publicationId, new Set());
    for (const issn of record.issns) for (const journalId of journalsByIssn.get(issn) ?? []) target.get(record.publicationId)!.add(journalId);
  }

  const result: LinkResult = { changed: 0, linked: 0, ambiguous: 0 };
  const candidates = await client.publication.findMany({
    where: { OR: [{ id: { in: [...target.keys()] } }, { journalId: { not: null } }] },
    select: { id: true, journalId: true },
  });
  for (const publication of candidates) {
    const journals = target.get(publication.id) ?? new Set<string>();
    if (journals.size > 1) result.ambiguous++;
    const next = journals.size === 1 ? [...journals][0] : null;
    if (next) result.linked++;
    if (next !== publication.journalId) {
      await client.publication.update({ where: { id: publication.id }, data: { journalId: next } });
      result.changed++;
    }
  }
  return result;
}

/* ── Refreshing one journal ───────────────────────────────────────────────── */

export interface JournalRefreshResult {
  reportsFetched: number;
  snapshotsAdded: number;
  warnings: string[];
}

/**
 * Refreshes one journal for a JOURNAL_METRICS task: profile and ISSNs, then the reports of the JCR
 * years of its ACTIVE publications plus the latest available year, limited to the years the
 * profile lists. All requests and validation happen before anything is written; then the profile
 * and every changed report are written in one transaction. An UNAVAILABLE report (HTTP 404, "not
 * found" or suppressed — ambiguous) is a warning that stores nothing and changes nothing; any other
 * failure fails the task and writes nothing.
 */
export async function refreshJournal(
  client: PrismaClient,
  jcr: JcrClient,
  journalId: string,
  options: { syncTaskId: string; retrievedAt: Date; jcrDataUpdate: Date | null },
): Promise<JournalRefreshResult> {
  const journal = await client.journal.findUniqueOrThrow({ where: { id: journalId }, select: { jcrId: true } });
  const profile = await fetchProfile(jcr, journal.jcrId);
  const warnings: string[] = [];

  const publicationYears = (
    await client.publication.findMany({ where: { journalId, status: 'ACTIVE', year: { not: null } }, select: { year: true }, distinct: ['year'] })
  ).map((p) => p.year!);
  const available = new Set(profile.reportYears);
  const latest = profile.reportYears.at(-1);
  const years = [...new Set([...publicationYears.filter((year) => available.has(year)), ...(latest !== undefined ? [latest] : [])])].sort((a, b) => a - b);
  if (profile.reportYears.length === 0) warnings.push(`JCR lists no report years for journal ${journal.jcrId}`);

  const reports: { year: number; mapped: MappedReport }[] = [];
  for (const year of years) {
    const lookup = await jcr.report(journal.jcrId, year);
    if (lookup.kind === 'UNAVAILABLE') {
      // Not "no report": HTTP 404 is also how a suppressed title is reported. Nothing is stored for
      // this year, and earlier snapshots of it stay exactly as they are.
      warnings.push(`JCR ${year} report for journal ${journal.jcrId} unavailable (HTTP 404: not found or suppressed, not distinguishable); earlier snapshots unchanged`);
      continue;
    }
    const mapped = mapJournalReport(lookup.report);
    warnings.push(...mapped.warnings);
    reports.push({ year, mapped });
  }

  const snapshotsAdded = await client.$transaction(async (tx) => {
    await writeProfile(tx, journalId, profile);
    let added = 0;
    for (const { year, mapped } of reports) {
      const latestSnapshot = await tx.journalMetricSnapshot.findFirst({
        where: { journalId, jcrYear: year },
        orderBy: { revision: 'desc' },
        select: { revision: true, payloadHash: true },
      });
      if (latestSnapshot?.payloadHash === mapped.payloadHash) continue; // unchanged report: no revision
      const { categories, ...metrics } = mapped.report;
      await tx.journalMetricSnapshot.create({
        data: {
          journalId,
          jcrYear: year,
          revision: (latestSnapshot?.revision ?? 0) + 1,
          payloadHash: mapped.payloadHash,
          jcrDataUpdate: options.jcrDataUpdate,
          retrievedAt: options.retrievedAt,
          syncTaskId: options.syncTaskId,
          ...metrics,
          jifValue: mapped.jifValue,
          jifWithoutSelfValue: mapped.jifWithoutSelfValue,
          categoryMetrics: { create: categories },
        },
      });
      added++;
    }
    return added;
  });

  return { reportsFetched: reports.length, snapshotsAdded, warnings };
}
