import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { PublicationSource, TypeFamily } from '@prisma/client';
import { prisma } from '../../src/config/database';
import { FetchError } from '../../src/integrations/http/httpClient';
import { WosStarterClient } from '../../src/integrations/wos/client';
import { DiscoveryPreconditionError } from '../../src/services/discovery/discoveryIdentity';
import { discoverWosIdentity } from '../../src/services/discovery/wosDiscovery';
import { ingestPublication } from '../../src/services/matching/engine';
import { buildNormalizedPublication } from '../../src/services/normalization/normalizedPublication';
import { resetDatabase } from '../helpers/database';
import { noSleep, replayFetch, Route } from '../helpers/fixtures';
import { API_KEY, documentsPage, OTHER_RID, RID, searchUrl, status, threeDocumentPages, wosDocument } from '../fixtures/wos/synthetic';

/* Web of Science discovery through the shared pipeline (stage 15.4) — synthetic responses, isolated test database. */

const T1 = new Date('2026-11-01T02:00:00.000Z');
const T2 = new Date('2026-12-01T02:00:00.000Z');

function wos(recorded = threeDocumentPages(), overrides: Record<string, Route> = {}) {
  const replay = replayFetch(recorded, overrides);
  return new WosStarterClient({ apiKey: API_KEY, perPage: 2, http: { maxRetries: 0 }, deps: { fetchImpl: replay.fetchImpl, sleep: noSleep } });
}

async function wosIdentity(professorName = 'Prof Web of Science') {
  const professor = await prisma.professor.create({ data: { name: professorName } });
  const identity = await prisma.externalIdentity.create({ data: { professorId: professor.id, source: 'WOS', externalId: RID } });
  return { professor, identity };
}

/** A discovery SyncRun/SyncTask pair, as the engine creates them, so observations can reference the task. */
async function syncTask(identityId: string, startedAt = T1) {
  const run = await prisma.syncRun.create({
    data: { kind: 'PUBLICATION_DISCOVERY', trigger: 'MANUAL', status: 'RUNNING', startedAt, tasks: { create: [{ kind: 'IDENTITY_DISCOVERY', identityId, source: 'WOS', status: 'RUNNING' }] } },
    include: { tasks: true },
  });
  return run.tasks[0].id;
}

/** An existing publication from another source, ingested through the same engine. */
async function existing(source: PublicationSource, externalId: string, fields: { title: string; doi?: string; year?: number; typeFamily?: TypeFamily; venue?: string; authors?: string }) {
  return ingestPublication(
    buildNormalizedPublication({
      source,
      externalId,
      title: fields.title,
      dois: fields.doi ? [fields.doi] : [],
      year: fields.year ?? 2021,
      venue: fields.venue ?? null,
      typeFamily: fields.typeFamily ?? 'JOURNAL',
      authorNamesDisplay: fields.authors ?? null,
      rawMetadata: { synthetic: true },
    }),
    { seenAt: T1 },
  );
}

const counts = async () => ({
  publications: await prisma.publication.count(),
  sourceRecords: await prisma.publicationSourceRecord.count(),
  links: await prisma.professorPublication.count(),
  candidates: await prisma.duplicateCandidate.count(),
  observations: await prisma.citationObservation.count(),
});
const NOTHING = { publications: 0, sourceRecords: 0, links: 0, candidates: 0, observations: 0 };

beforeEach(async () => {
  await resetDatabase();
});

afterAll(async () => {
  await resetDatabase();
  await prisma.$disconnect();
});

describe('discoverWosIdentity', () => {
  it('ingests every attributed document, links them PENDING via the identity and records one Times Cited observation each', async () => {
    const { professor, identity } = await wosIdentity();
    const taskId = await syncTask(identity.id);
    const summary = await discoverWosIdentity(identity.id, { wos: wos(), now: () => T1, syncTaskId: taskId });

    expect(summary).toMatchObject({
      identityId: identity.id,
      researcherId: RID,
      reportedCount: 3,
      recordsFetched: 3,
      recordsNew: 3,
      linksCreated: 3,
      citationObservations: 3,
      documentsNotAttributed: 0,
      recordsSkipped: 0,
    });
    const records = await prisma.publicationSourceRecord.findMany({ where: { source: 'WOS' }, orderBy: { externalId: 'asc' } });
    expect(records.map((r) => r.externalId)).toEqual(['WOS:000900000000001', 'WOS:000900000000002', 'WOS:000900000000003']);
    expect(records.every((r) => r.matchMethod === 'NEW_PUBLICATION' && r.lastSeenAt?.getTime() === T1.getTime())).toBe(true);
    expect(records[0]).toMatchObject({ title: 'Synthetic Web of Science study number 1 on deterministic matching', doi: '10.5555/synthetic.wos.1', year: 2021, typeFamily: 'JOURNAL' });
    const links = await prisma.professorPublication.findMany({ where: { professorId: professor.id } });
    expect(links.every((l) => l.status === 'PENDING' && l.origin === 'DISCOVERED' && l.discoveredViaIdentityId === identity.id)).toBe(true);

    const observations = await prisma.citationObservation.findMany({ include: { sourceRecord: { select: { externalId: true } } }, orderBy: { count: 'asc' } });
    expect(observations.map((o) => [o.sourceRecord.externalId, o.provider, o.database, o.count, o.syncTaskId, o.observedAt.toISOString()])).toEqual([
      ['WOS:000900000000001', 'WOS', 'WOS', 4, taskId, T1.toISOString()],
      ['WOS:000900000000002', 'WOS', 'WOS', 8, taskId, T1.toISOString()],
      ['WOS:000900000000003', 'WOS', 'WOS', 12, taskId, T1.toISOString()],
    ]);
  });

  it('every later synchronization appends observations and never overwrites earlier ones', async () => {
    const { identity } = await wosIdentity();
    await discoverWosIdentity(identity.id, { wos: wos(), now: () => T1, syncTaskId: await syncTask(identity.id, T1) });
    const later = threeDocumentPages(RID, [wosDocument(1, { citations: [{ db: 'WOS', count: 25 }] }), wosDocument(2), wosDocument(3)]);
    const summary = await discoverWosIdentity(identity.id, { wos: wos(later), now: () => T2, syncTaskId: await syncTask(identity.id, T2) });

    expect(summary).toMatchObject({ recordsNew: 0, recordsUpdated: 3, linksCreated: 0, citationObservations: 3 });
    const first = await prisma.citationObservation.findMany({ where: { sourceRecord: { externalId: 'WOS:000900000000001' } }, orderBy: { observedAt: 'asc' } });
    expect(first.map((o) => [o.count, o.observedAt.toISOString()])).toEqual([
      [4, T1.toISOString()],
      [25, T2.toISOString()],
    ]);
    expect(await prisma.publicationSourceRecord.count()).toBe(3);
  });

  it('a retried write of the same task adds no duplicate observations, and outside a task none are recorded', async () => {
    const { identity } = await wosIdentity();
    const taskId = await syncTask(identity.id);
    await discoverWosIdentity(identity.id, { wos: wos(), now: () => T1, syncTaskId: taskId });
    expect((await discoverWosIdentity(identity.id, { wos: wos(), now: () => T1, syncTaskId: taskId })).citationObservations).toBe(0);
    expect((await discoverWosIdentity(identity.id, { wos: wos(), now: () => T1 })).citationObservations).toBe(0);
    expect(await prisma.citationObservation.count()).toBe(3);
  });

  it('skips untitled documents; documents without a valid Times Cited are recorded without an observation', async () => {
    const { identity } = await wosIdentity();
    const pages = threeDocumentPages(RID, [wosDocument(1, { title: null }), wosDocument(2, { citations: [{ db: 'BCI', count: 3 }] }), wosDocument(3)]);
    const summary = await discoverWosIdentity(identity.id, { wos: wos(pages), now: () => T1, syncTaskId: await syncTask(identity.id) });
    expect(summary).toMatchObject({ recordsFetched: 3, recordsSkipped: 1, recordsNew: 2, citationObservations: 1 });
    expect(summary.warnings.some((w) => w.includes('WOS:WOS:000900000000001') && w.includes('no usable title'))).toBe(true);
    expect(summary.warnings).toContain('Web of Science document WOS:000900000000002 has no valid Times Cited; no citation observation recorded');
  });
});

describe('researcher attribution and identity revalidation', () => {
  it('only documents whose author list carries the ResearcherID are attributed; the others are skipped with a warning', async () => {
    const { professor, identity } = await wosIdentity();
    const pages = threeDocumentPages(RID, [wosDocument(1), wosDocument(2, {}, OTHER_RID), wosDocument(3, { names: { authors: [{ displayName: 'Verma, A' }] } })]);
    const summary = await discoverWosIdentity(identity.id, { wos: wos(pages), now: () => T1, syncTaskId: await syncTask(identity.id) });

    expect(summary).toMatchObject({ reportedCount: 3, recordsFetched: 1, recordsNew: 1, linksCreated: 1, documentsNotAttributed: 2, citationObservations: 1 });
    expect(summary.warnings).toEqual([
      `Web of Science document WOS:000900000000002 does not list ResearcherID ${RID} among its authors; not attributed`,
      `Web of Science document WOS:000900000000003 does not list ResearcherID ${RID} among its authors; not attributed`,
    ]);
    expect(await prisma.publicationSourceRecord.findMany({ select: { externalId: true } })).toEqual([{ externalId: 'WOS:000900000000001' }]);
    expect(await prisma.professorPublication.count({ where: { professorId: professor.id } })).toBe(1);
  });

  it('documents of which none carries the ResearcherID fail the identity check and write nothing', async () => {
    const { identity } = await wosIdentity();
    const pages = threeDocumentPages(RID, [wosDocument(1, {}, OTHER_RID), wosDocument(2, {}, OTHER_RID), wosDocument(3, { names: null })]);
    const error = await discoverWosIdentity(identity.id, { wos: wos(pages), now: () => T1, syncTaskId: await syncTask(identity.id) }).catch((e: unknown) => e);
    expect(error).toMatchObject({ kind: 'IDENTITY_INVALID' });
    expect((error as Error).message).toBe(
      `None of the 3 Web of Science documents found for ResearcherID ${RID} lists it among its authors; nothing was saved. Check the ResearcherID on the author’s Web of Science record.`,
    );
    expect(await counts()).toEqual(NOTHING);
    expect(await prisma.externalIdentity.findUniqueOrThrow({ where: { id: identity.id } })).toMatchObject({ externalId: RID, isActive: true });
  });

  it('a ResearcherID without linked documents is a valid zero with a warning (nothing to accept)', async () => {
    const { identity } = await wosIdentity();
    const summary = await discoverWosIdentity(identity.id, { wos: wos([documentsPage(RID, 1, 2, 0, [])]), now: () => T1, syncTaskId: await syncTask(identity.id) });
    expect(summary).toMatchObject({ reportedCount: 0, recordsFetched: 0, recordsNew: 0, citationObservations: 0 });
    expect(summary.warnings).toEqual([`No Web of Science document is linked to ResearcherID ${RID}; the identity could not be confirmed by this synchronization`]);
  });

  it('a plan that returns no Times Cited at all (e.g. Free Trial) is NOT_ENTITLED and writes nothing', async () => {
    const { identity } = await wosIdentity();
    const pages = threeDocumentPages(RID, [wosDocument(1, { citations: undefined }), wosDocument(2, { citations: null }), wosDocument(3, { citations: undefined })]);
    await expect(discoverWosIdentity(identity.id, { wos: wos(pages), now: () => T1, syncTaskId: await syncTask(identity.id) })).rejects.toMatchObject({ kind: 'NOT_ENTITLED' });
    expect(await counts()).toEqual(NOTHING);
  });
});

describe('matching against existing records (the shared engine, unchanged)', () => {
  it('attaches to existing OpenAlex, DBLP, ORCID, Scopus and manual publications instead of duplicating them', async () => {
    const docs = [1, 2, 3, 4, 5].map((n) => wosDocument(n));
    // The same papers as other sources report them (capitalization, punctuation, DOI form).
    const openAlex = await existing('OPENALEX', 'W1', { title: 'SYNTHETIC WEB OF SCIENCE STUDY NUMBER 1 ON DETERMINISTIC MATCHING', doi: '10.5555/synthetic.wos.1', venue: 'OpenAlex Venue' });
    const dblp = await existing('DBLP', 'journals/synth/Verma21', { title: 'Synthetic Web of Science study number 2 on deterministic matching.', year: 2021 });
    const orcid = await existing('ORCID', '0000-0002-1825-0097:3', { title: 'Synthetic Web of Science study number 3 on deterministic matching', doi: 'https://doi.org/10.5555/SYNTHETIC.WOS.3' });
    const scopus = await existing('SCOPUS', '2-s2.0-85000000004', { title: 'Synthetic Web of Science study number 4 on deterministic matching', doi: '10.5555/synthetic.wos.4', venue: 'Scopus Venue', authors: 'Verma A., Rao S.' });
    const manual = await existing('MANUAL', '00000000-0000-4000-8000-000000000005', { title: 'Synthetic Web of Science study number 5 on deterministic matching', doi: '10.5555/synthetic.wos.5' });
    const before = await counts();

    const { identity } = await wosIdentity();
    const pages = [documentsPage(RID, 1, 2, 5, docs.slice(0, 2)), documentsPage(RID, 2, 2, 5, docs.slice(2, 4)), documentsPage(RID, 3, 2, 5, docs.slice(4))];
    const summary = await discoverWosIdentity(identity.id, { wos: wos(pages), now: () => T1, syncTaskId: await syncTask(identity.id) });

    expect(summary).toMatchObject({ recordsNew: 5, candidatesCreated: 0, citationObservations: 5 });
    expect(await prisma.publication.count()).toBe(before.publications); // nothing duplicated
    const wosRecords = await prisma.publicationSourceRecord.findMany({ where: { source: 'WOS' }, orderBy: { externalId: 'asc' } });
    expect(wosRecords.map((r) => [r.publicationId, r.matchMethod])).toEqual([
      [openAlex.publicationId, 'DOI'],
      [dblp.publicationId, 'TITLE_YEAR'],
      [orcid.publicationId, 'DOI'],
      [scopus.publicationId, 'DOI'],
      [manual.publicationId, 'DOI'],
    ]);
    // Canonical metadata keeps the higher-priority sources: OpenAlex → DBLP → ORCID → Scopus → WoS → MANUAL.
    expect(await prisma.publication.findUniqueOrThrow({ where: { id: openAlex.publicationId } })).toMatchObject({ venue: 'OpenAlex Venue' });
    expect(await prisma.publication.findUniqueOrThrow({ where: { id: scopus.publicationId } })).toMatchObject({ venue: 'Scopus Venue', authorNamesDisplay: 'Verma A., Rao S.' });
    // …but WoS outranks MANUAL, and fills fields the higher sources lack.
    expect(await prisma.publication.findUniqueOrThrow({ where: { id: manual.publicationId } })).toMatchObject({ venue: 'JOURNAL OF SYNTHETIC RESULTS', authorNamesDisplay: 'Verma, A; Rao, S' });
    // Every provider keeps its own provenance.
    for (const publicationId of [openAlex, dblp, orcid, scopus, manual].map((p) => p.publicationId)) {
      expect(await prisma.publicationSourceRecord.count({ where: { publicationId } })).toBe(2);
    }
  });

  it('Scopus and Web of Science citation counts for the same paper stay separate observations', async () => {
    const scopus = await existing('SCOPUS', '2-s2.0-85000000001', { title: 'Synthetic Web of Science study number 1 on deterministic matching', doi: '10.5555/synthetic.wos.1' });
    const scopusRecord = await prisma.publicationSourceRecord.findFirstOrThrow({ where: { source: 'SCOPUS' } });
    await prisma.citationObservation.create({ data: { sourceRecordId: scopusRecord.id, provider: 'SCOPUS', count: 99, observedAt: T1 } });

    const { identity } = await wosIdentity();
    await discoverWosIdentity(identity.id, { wos: wos(), now: () => T1, syncTaskId: await syncTask(identity.id) });

    const observations = await prisma.citationObservation.findMany({
      where: { sourceRecord: { publicationId: scopus.publicationId } },
      include: { sourceRecord: { select: { source: true } } },
      orderBy: { provider: 'asc' },
    });
    expect(observations.map((o) => [o.provider, o.sourceRecord.source, o.database, o.count])).toEqual([
      ['SCOPUS', 'SCOPUS', null, 99],
      ['WOS', 'WOS', 'WOS', 4],
    ]);
  });

  it('leaves an uncertain title match as a duplicate candidate and keeps the #22 DOI contradiction rule', async () => {
    // Same title as WoS document 2 but a different known type family: blocked, so a candidate.
    await existing('ORCID', '0000-0002-1825-0097:2', { title: 'Synthetic Web of Science study number 2 on deterministic matching', typeFamily: 'CONFERENCE' });
    // Shares WoS document 1's DOI but has an unrelated title: not merged.
    const other = await existing('OPENALEX', 'W1', { title: 'An entirely different paper about compilers', doi: '10.5555/synthetic.wos.1' });

    const { identity } = await wosIdentity();
    const summary = await discoverWosIdentity(identity.id, { wos: wos(), now: () => T1 });
    expect(summary.candidatesCreated).toBe(2);
    const first = await prisma.publicationSourceRecord.findFirstOrThrow({ where: { source: 'WOS', externalId: 'WOS:000900000000001' } });
    expect(first.publicationId).not.toBe(other.publicationId);
    expect(await prisma.publication.count()).toBe(5); // ORCID, OpenAlex, and the three WoS papers kept separate
  });

  it('keeps existing professor approvals and rejections unchanged', async () => {
    const approved = await existing('OPENALEX', 'W1', { title: 'Synthetic Web of Science study number 1 on deterministic matching', doi: '10.5555/synthetic.wos.1' });
    const rejected = await existing('SCOPUS', '2-s2.0-85000000002', { title: 'Synthetic Web of Science study number 2 on deterministic matching', doi: '10.5555/synthetic.wos.2' });
    const { professor, identity } = await wosIdentity();
    const decidedAt = new Date('2026-10-01T00:00:00.000Z');
    await prisma.professorPublication.createMany({
      data: [
        { professorId: professor.id, publicationId: approved.publicationId, status: 'APPROVED', origin: 'DISCOVERED', decidedAt },
        { professorId: professor.id, publicationId: rejected.publicationId, status: 'REJECTED', origin: 'DISCOVERED', decidedAt },
      ],
    });

    const summary = await discoverWosIdentity(identity.id, { wos: wos(), now: () => T1 });
    expect(summary.linksCreated).toBe(1); // only document 3 is new for this professor
    const links = await prisma.professorPublication.findMany({ where: { professorId: professor.id } });
    expect(links.find((l) => l.publicationId === approved.publicationId)).toMatchObject({ status: 'APPROVED', decidedAt });
    expect(links.find((l) => l.publicationId === rejected.publicationId)).toMatchObject({ status: 'REJECTED', decidedAt });
  });
});

describe('failures write nothing', () => {
  it('a failing later page leaves no records, links or observations', async () => {
    const { identity } = await wosIdentity();
    const taskId = await syncTask(identity.id);
    for (const broken of [status(500), status(401), status(200, {}, { metadata: { total: 3, page: 2, limit: 2 }, hits: [{ uid: 'bad' }] }), status(200, {}, { hits: [] })]) {
      const client = wos([threeDocumentPages()[0]], { [searchUrl(RID, 2, 2)]: broken });
      await expect(discoverWosIdentity(identity.id, { wos: client, now: () => T1, syncTaskId: taskId })).rejects.toBeInstanceOf(FetchError);
    }
    expect(await counts()).toEqual(NOTHING);
  });

  it('an incomplete result (fewer distinct documents than reported) writes nothing', async () => {
    const { identity } = await wosIdentity();
    const pages = [documentsPage(RID, 1, 2, 3, [wosDocument(1), wosDocument(2)]), documentsPage(RID, 2, 2, 3, [wosDocument(1)])];
    await expect(discoverWosIdentity(identity.id, { wos: wos(pages), now: () => T1, syncTaskId: await syncTask(identity.id) })).rejects.toMatchObject({ kind: 'INCOMPLETE' });
    expect(await counts()).toEqual(NOTHING);
  });

  it('credential failures are classified and write nothing', async () => {
    for (const [code, kind] of [[401, 'AUTH_FAILED'], [403, 'NOT_ENTITLED'], [429, 'QUOTA_EXCEEDED']] as const) {
      await resetDatabase();
      const { identity } = await wosIdentity();
      await expect(discoverWosIdentity(identity.id, { wos: wos([], { [searchUrl(RID, 1, 2)]: status(code) }), now: () => T1 })).rejects.toMatchObject({ kind });
      expect(await counts()).toEqual(NOTHING);
    }
  });

  it('without a configured client, or for an inactive identity, nothing is requested or written', async () => {
    const { professor, identity } = await wosIdentity();
    await expect(discoverWosIdentity(identity.id, { wos: null })).rejects.toBeInstanceOf(DiscoveryPreconditionError);
    await prisma.externalIdentity.update({ where: { id: identity.id }, data: { isActive: false } });
    const replay = replayFetch(threeDocumentPages());
    const client = new WosStarterClient({ apiKey: API_KEY, perPage: 2, deps: { fetchImpl: replay.fetchImpl, sleep: noSleep } });
    await expect(discoverWosIdentity(identity.id, { wos: client })).rejects.toBeInstanceOf(DiscoveryPreconditionError);
    expect(replay.calls).toHaveLength(0);
    expect(await prisma.professorPublication.count({ where: { professorId: professor.id } })).toBe(0);
  });
});
