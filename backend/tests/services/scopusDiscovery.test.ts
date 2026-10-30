import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { PublicationSource, TypeFamily } from '@prisma/client';
import { prisma } from '../../src/config/database';
import { FetchError } from '../../src/integrations/http/httpClient';
import { ScopusClient } from '../../src/integrations/scopus/client';
import { DiscoveryPreconditionError } from '../../src/services/discovery/discoveryIdentity';
import { discoverScopusIdentity } from '../../src/services/discovery/scopusDiscovery';
import { ingestPublication } from '../../src/services/matching/engine';
import { buildNormalizedPublication } from '../../src/services/normalization/normalizedPublication';
import { resetDatabase } from '../helpers/database';
import { noSleep, replayFetch, Route } from '../helpers/fixtures';
import { API_KEY, AUTHOR, authorFound, authorUrl, scopusEntry, searchPage, searchUrl, status, threeDocumentPages } from '../fixtures/scopus/synthetic';

/* Scopus discovery through the shared pipeline (stage 15.3) — synthetic responses, isolated test database. */

const T1 = new Date('2026-11-01T02:00:00.000Z');
const T2 = new Date('2026-12-01T02:00:00.000Z');

function scopus(recorded = [authorFound(), ...threeDocumentPages()], overrides: Record<string, Route> = {}) {
  const replay = replayFetch(recorded, overrides);
  return new ScopusClient({ apiKey: API_KEY, perPage: 2, http: { maxRetries: 0 }, deps: { fetchImpl: replay.fetchImpl, sleep: noSleep } });
}

async function scopusIdentity(professorName = 'Prof Scopus') {
  const professor = await prisma.professor.create({ data: { name: professorName } });
  const identity = await prisma.externalIdentity.create({ data: { professorId: professor.id, source: 'SCOPUS', externalId: AUTHOR } });
  return { professor, identity };
}

/** A discovery SyncRun/SyncTask pair, as the engine creates them, so observations can reference the task. */
async function syncTask(identityId: string, startedAt = T1) {
  const run = await prisma.syncRun.create({
    data: { kind: 'PUBLICATION_DISCOVERY', trigger: 'MANUAL', status: 'RUNNING', startedAt, tasks: { create: [{ kind: 'IDENTITY_DISCOVERY', identityId, source: 'SCOPUS', status: 'RUNNING' }] } },
    include: { tasks: true },
  });
  return run.tasks[0].id;
}

/** An existing publication from another source, ingested through the same engine. */
async function existing(source: PublicationSource, externalId: string, fields: { title: string; doi?: string; year?: number; typeFamily?: TypeFamily; venue?: string }) {
  return ingestPublication(
    buildNormalizedPublication({
      source,
      externalId,
      title: fields.title,
      dois: fields.doi ? [fields.doi] : [],
      year: fields.year ?? 2021,
      venue: fields.venue ?? null,
      typeFamily: fields.typeFamily ?? 'JOURNAL',
      authorNamesDisplay: null,
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

beforeEach(async () => {
  await resetDatabase();
});

afterAll(async () => {
  await resetDatabase();
  await prisma.$disconnect();
});

describe('discoverScopusIdentity', () => {
  it('ingests every document, links them PENDING via the identity and records one citation observation each', async () => {
    const { professor, identity } = await scopusIdentity();
    const taskId = await syncTask(identity.id);
    const summary = await discoverScopusIdentity(identity.id, { scopus: scopus(), now: () => T1, syncTaskId: taskId });

    expect(summary).toMatchObject({ identityId: identity.id, authorId: AUTHOR, reportedCount: 3, recordsFetched: 3, recordsNew: 3, linksCreated: 3, citationObservations: 3, recordsSkipped: 0 });
    const records = await prisma.publicationSourceRecord.findMany({ where: { source: 'SCOPUS' }, orderBy: { externalId: 'asc' } });
    expect(records.map((r) => r.externalId)).toEqual(['2-s2.0-85000000001', '2-s2.0-85000000002', '2-s2.0-85000000003']);
    expect(records.every((r) => r.matchMethod === 'NEW_PUBLICATION' && r.lastSeenAt?.getTime() === T1.getTime())).toBe(true);
    const links = await prisma.professorPublication.findMany({ where: { professorId: professor.id } });
    expect(links.every((l) => l.status === 'PENDING' && l.origin === 'DISCOVERED' && l.discoveredViaIdentityId === identity.id)).toBe(true);

    const observations = await prisma.citationObservation.findMany({ include: { sourceRecord: { select: { externalId: true } } }, orderBy: { count: 'asc' } });
    expect(observations.map((o) => [o.sourceRecord.externalId, o.provider, o.count, o.syncTaskId, o.observedAt.toISOString()])).toEqual([
      ['2-s2.0-85000000001', 'SCOPUS', 3, taskId, T1.toISOString()],
      ['2-s2.0-85000000002', 'SCOPUS', 6, taskId, T1.toISOString()],
      ['2-s2.0-85000000003', 'SCOPUS', 9, taskId, T1.toISOString()],
    ]);
  });

  it('every later synchronization adds observations and never overwrites earlier ones', async () => {
    const { identity } = await scopusIdentity();
    await discoverScopusIdentity(identity.id, { scopus: scopus(), now: () => T1, syncTaskId: await syncTask(identity.id, T1) });
    const later = threeDocumentPages(AUTHOR, [scopusEntry(1, { 'citedby-count': '10' }), scopusEntry(2), scopusEntry(3)]);
    const secondTask = await syncTask(identity.id, T2);
    const summary = await discoverScopusIdentity(identity.id, { scopus: scopus([authorFound(), ...later]), now: () => T2, syncTaskId: secondTask });

    expect(summary).toMatchObject({ recordsNew: 0, recordsUpdated: 3, linksCreated: 0, citationObservations: 3 });
    const first = await prisma.citationObservation.findMany({ where: { sourceRecord: { externalId: '2-s2.0-85000000001' } }, orderBy: { observedAt: 'asc' } });
    expect(first.map((o) => [o.count, o.observedAt.toISOString()])).toEqual([
      [3, T1.toISOString()],
      [10, T2.toISOString()],
    ]);
    expect(await prisma.publicationSourceRecord.count()).toBe(3);
  });

  it('a retried write of the same task adds no duplicate observations', async () => {
    const { identity } = await scopusIdentity();
    const taskId = await syncTask(identity.id);
    await discoverScopusIdentity(identity.id, { scopus: scopus(), now: () => T1, syncTaskId: taskId });
    const again = await discoverScopusIdentity(identity.id, { scopus: scopus(), now: () => T1, syncTaskId: taskId });
    expect(again.citationObservations).toBe(0);
    expect(await prisma.citationObservation.count()).toBe(3);
  });

  it('outside a synchronization task no observation is recorded', async () => {
    const { identity } = await scopusIdentity();
    const summary = await discoverScopusIdentity(identity.id, { scopus: scopus(), now: () => T1 });
    expect(summary.citationObservations).toBe(0);
    expect(await prisma.citationObservation.count()).toBe(0);
    expect(await prisma.publicationSourceRecord.count()).toBe(3);
  });

  it('skips documents without a title and documents without a valid count are recorded without an observation', async () => {
    const { identity } = await scopusIdentity();
    const pages = threeDocumentPages(AUTHOR, [scopusEntry(1, { 'dc:title': null }), scopusEntry(2, { 'citedby-count': null }), scopusEntry(3)]);
    const summary = await discoverScopusIdentity(identity.id, { scopus: scopus([authorFound(), ...pages]), now: () => T1, syncTaskId: await syncTask(identity.id) });
    expect(summary).toMatchObject({ recordsFetched: 3, recordsSkipped: 1, recordsNew: 2, citationObservations: 1 });
    expect(summary.warnings.some((w) => w.includes('SCOPUS:2-s2.0-85000000001') && w.includes('no usable title'))).toBe(true);
    expect(summary.warnings).toContain('Scopus document 2-s2.0-85000000002 has no valid cited-by count; no citation observation recorded');
  });
});

describe('matching against existing records (the shared engine, unchanged)', () => {
  it('attaches to existing OpenAlex, DBLP, ORCID and manual publications instead of duplicating them', async () => {
    // Same papers as Scopus documents 1–3, as other sources report them (capitalization, punctuation, DOI case).
    const openAlex = await existing('OPENALEX', 'W1', { title: 'SYNTHETIC SCOPUS STUDY NUMBER 1 ON DETERMINISTIC MATCHING', doi: '10.5555/synthetic.1', venue: 'OpenAlex Venue' });
    const manual = await existing('MANUAL', '00000000-0000-4000-8000-000000000001', { title: 'Synthetic Scopus study number 2 on deterministic matching', doi: 'https://doi.org/10.5555/SYNTHETIC.2' });
    const dblp = await existing('DBLP', 'journals/synth/Verma21', { title: 'Synthetic Scopus study number 3 on deterministic matching.', year: 2021 });
    const before = await counts();

    const { identity } = await scopusIdentity();
    const summary = await discoverScopusIdentity(identity.id, { scopus: scopus(), now: () => T1, syncTaskId: await syncTask(identity.id) });

    expect(summary).toMatchObject({ recordsNew: 3, candidatesCreated: 0 });
    expect(await prisma.publication.count()).toBe(before.publications); // nothing duplicated
    const scopusRecords = await prisma.publicationSourceRecord.findMany({ where: { source: 'SCOPUS' }, orderBy: { externalId: 'asc' } });
    expect(scopusRecords.map((r) => [r.publicationId, r.matchMethod])).toEqual([
      [openAlex.publicationId, 'DOI'],
      [manual.publicationId, 'DOI'],
      [dblp.publicationId, 'TITLE_YEAR'],
    ]);
    // Canonical metadata keeps the higher-priority sources (OpenAlex → DBLP → ORCID → Scopus, #110).
    const canonical = await prisma.publication.findUniqueOrThrow({ where: { id: openAlex.publicationId } });
    expect(canonical).toMatchObject({ title: 'SYNTHETIC SCOPUS STUDY NUMBER 1 ON DETERMINISTIC MATCHING', venue: 'OpenAlex Venue' });
    // Every provider keeps its own provenance.
    expect(await prisma.publicationSourceRecord.count({ where: { publicationId: openAlex.publicationId } })).toBe(2);
  });

  it('attaches to an ORCID record by DOI and leaves an uncertain title match as a duplicate candidate', async () => {
    const orcid = await existing('ORCID', '0000-0002-1825-0097:1', { title: 'Synthetic Scopus study number 1 on deterministic matching', doi: '10.5555/synthetic.1' });
    // Same title as Scopus document 2 but a different known type family: blocked, so a candidate.
    await existing('ORCID', '0000-0002-1825-0097:2', { title: 'Synthetic Scopus study number 2 on deterministic matching', typeFamily: 'CONFERENCE' });

    const { identity } = await scopusIdentity();
    const summary = await discoverScopusIdentity(identity.id, { scopus: scopus(), now: () => T1 });
    expect(summary.candidatesCreated).toBe(1);
    const first = await prisma.publicationSourceRecord.findFirstOrThrow({ where: { source: 'SCOPUS', externalId: '2-s2.0-85000000001' } });
    expect(first.publicationId).toBe(orcid.publicationId);
    expect(await prisma.publication.count()).toBe(4); // ORCID ×2, plus Scopus 2 (kept separate) and 3
  });

  it('a shared DOI with an unrelated title is not merged: the existing #22 contradiction rule applies to Scopus too', async () => {
    const other = await existing('OPENALEX', 'W1', { title: 'An entirely different paper about compilers', doi: '10.5555/synthetic.1' });
    const { identity } = await scopusIdentity();
    const summary = await discoverScopusIdentity(identity.id, { scopus: scopus(), now: () => T1 });
    expect(summary.candidatesCreated).toBe(1);
    const record = await prisma.publicationSourceRecord.findFirstOrThrow({ where: { source: 'SCOPUS', externalId: '2-s2.0-85000000001' } });
    expect(record.publicationId).not.toBe(other.publicationId);
    expect(await prisma.duplicateCandidate.count({ where: { OR: [{ publicationAId: other.publicationId }, { publicationBId: other.publicationId }] } })).toBe(1);
  });

  it('keeps existing professor approvals and rejections unchanged', async () => {
    const approved = await existing('OPENALEX', 'W1', { title: 'Synthetic Scopus study number 1 on deterministic matching', doi: '10.5555/synthetic.1' });
    const rejected = await existing('OPENALEX', 'W2', { title: 'Synthetic Scopus study number 2 on deterministic matching', doi: '10.5555/synthetic.2' });
    const { professor, identity } = await scopusIdentity();
    const decidedAt = new Date('2026-10-01T00:00:00.000Z');
    await prisma.professorPublication.createMany({
      data: [
        { professorId: professor.id, publicationId: approved.publicationId, status: 'APPROVED', origin: 'DISCOVERED', decidedAt },
        { professorId: professor.id, publicationId: rejected.publicationId, status: 'REJECTED', origin: 'DISCOVERED', decidedAt },
      ],
    });

    const summary = await discoverScopusIdentity(identity.id, { scopus: scopus(), now: () => T1 });
    expect(summary.linksCreated).toBe(1); // only document 3 is new for this professor
    const links = await prisma.professorPublication.findMany({ where: { professorId: professor.id }, orderBy: { createdAt: 'asc' } });
    expect(links.find((l) => l.publicationId === approved.publicationId)).toMatchObject({ status: 'APPROVED', decidedAt });
    expect(links.find((l) => l.publicationId === rejected.publicationId)).toMatchObject({ status: 'REJECTED', decidedAt });
  });
});

describe('failures write nothing', () => {
  it('a failing later page leaves no records, links or observations', async () => {
    const { identity } = await scopusIdentity();
    const taskId = await syncTask(identity.id);
    for (const broken of [status(500), status(200, {}, { 'search-results': { entry: [] } })]) {
      const client = scopus([authorFound(), threeDocumentPages()[0]], { [searchUrl(AUTHOR, 2, 2)]: broken });
      await expect(discoverScopusIdentity(identity.id, { scopus: client, now: () => T1, syncTaskId: taskId })).rejects.toBeInstanceOf(FetchError);
    }
    expect(await counts()).toEqual({ publications: 0, sourceRecords: 0, links: 0, candidates: 0, observations: 0 });
  });

  it('an incomplete result (fewer documents than reported) writes nothing', async () => {
    const { identity } = await scopusIdentity();
    const pages = [searchPage(AUTHOR, 0, 2, 3, [scopusEntry(1), scopusEntry(2)]), searchPage(AUTHOR, 2, 2, 3, [])];
    await expect(discoverScopusIdentity(identity.id, { scopus: scopus([authorFound(), ...pages]), now: () => T1 })).rejects.toMatchObject({ kind: 'INCOMPLETE' });
    expect(await counts()).toEqual({ publications: 0, sourceRecords: 0, links: 0, candidates: 0, observations: 0 });
  });

  it('a replaced (merged) Scopus author fails before any document is fetched', async () => {
    const { identity } = await scopusIdentity();
    const replay = replayFetch([], { [authorUrl()]: status(301, { location: 'https://api.elsevier.com/content/author/author_id/57000000002' }) });
    const client = new ScopusClient({ apiKey: API_KEY, http: { maxRetries: 0 }, deps: { fetchImpl: replay.fetchImpl, sleep: noSleep } });
    await expect(discoverScopusIdentity(identity.id, { scopus: client, now: () => T1 })).rejects.toMatchObject({ kind: 'IDENTITY_INVALID' });
    expect(replay.calls).toHaveLength(1);
    expect(await counts()).toEqual({ publications: 0, sourceRecords: 0, links: 0, candidates: 0, observations: 0 });
    // The identity is not changed or moved.
    expect(await prisma.externalIdentity.findUniqueOrThrow({ where: { id: identity.id } })).toMatchObject({ externalId: AUTHOR, isActive: true });
  });

  it('credential failures are classified and write nothing', async () => {
    for (const [code, kind] of [[401, 'AUTH_FAILED'], [403, 'NOT_ENTITLED'], [429, 'QUOTA_EXCEEDED']] as const) {
      await resetDatabase();
      const { identity } = await scopusIdentity();
      const client = scopus([], { [authorUrl()]: status(code) });
      await expect(discoverScopusIdentity(identity.id, { scopus: client, now: () => T1 })).rejects.toMatchObject({ kind });
      expect(await counts()).toEqual({ publications: 0, sourceRecords: 0, links: 0, candidates: 0, observations: 0 });
    }
  });

  it('without a configured client, or for an inactive identity, nothing is requested or written', async () => {
    const { professor, identity } = await scopusIdentity();
    await expect(discoverScopusIdentity(identity.id, { scopus: null })).rejects.toBeInstanceOf(DiscoveryPreconditionError);
    await prisma.externalIdentity.update({ where: { id: identity.id }, data: { isActive: false } });
    const replay = replayFetch([authorFound(), ...threeDocumentPages()]);
    const client = new ScopusClient({ apiKey: API_KEY, perPage: 2, deps: { fetchImpl: replay.fetchImpl, sleep: noSleep } });
    await expect(discoverScopusIdentity(identity.id, { scopus: client })).rejects.toBeInstanceOf(DiscoveryPreconditionError);
    expect(replay.calls).toHaveLength(0);
    expect(await prisma.professorPublication.count({ where: { professorId: professor.id } })).toBe(0);
  });
});
