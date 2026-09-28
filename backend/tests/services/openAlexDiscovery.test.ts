import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '../../src/config/database';
import { FetchError } from '../../src/integrations/http/httpClient';
import { OPENALEX_BASE_URL, OpenAlexClient } from '../../src/integrations/openalex/client';
import { DiscoveryPreconditionError, discoverOpenAlexIdentity } from '../../src/services/discovery/openAlexDiscovery';
import { normalizeDoi } from '../../src/services/normalization/doi';
import { resetDatabase } from '../helpers/database';
import { loadFixture, noSleep, replayFetch, Route } from '../helpers/fixtures';

const fx = (name: string) => loadFixture('openalex', name);
const AUTHOR = 'A5023888391';
const authorValid = fx('author-valid');
const pages = [fx('works-page-1'), fx('works-page-2'), fx('works-page-3')];
const authorUrl = (id: string) => `${OPENALEX_BASE_URL}/authors/${id}?select=id,display_name,orcid,works_count`;

function openAlex(overrides: Record<string, Route> = {}) {
  const replay = replayFetch([authorValid, ...pages, fx('author-not-found')], overrides);
  return {
    client: new OpenAlexClient({ perPage: 25, deps: { fetchImpl: replay.fetchImpl, sleep: noSleep } }),
    calls: replay.calls,
  };
}

async function identityFor(externalId = AUTHOR, professorName = 'Prof A') {
  const professor = await prisma.professor.create({ data: { name: professorName } });
  const identity = await prisma.externalIdentity.create({
    data: { professorId: professor.id, source: 'OPENALEX', externalId },
  });
  return { professor, identity };
}

const counts = async () => ({
  publications: await prisma.publication.count(),
  sourceRecords: await prisma.publicationSourceRecord.count(),
  links: await prisma.professorPublication.count(),
  candidates: await prisma.duplicateCandidate.count(),
});

const at = (iso: string) => () => new Date(iso);

beforeEach(async () => {
  await resetDatabase();
});

afterAll(async () => {
  await resetDatabase();
  await prisma.$disconnect();
});

describe('discoverOpenAlexIdentity — first discovery', () => {
  it('ingests every recorded work and creates PENDING relationships via the identity', async () => {
    const { professor, identity } = await identityFor();
    const summary = await discoverOpenAlexIdentity(identity.id, {
      openAlex: openAlex().client,
      now: at('2026-09-01T00:00:00Z'),
    });

    expect(summary).toMatchObject({
      identityId: identity.id,
      requestedAuthorId: AUTHOR,
      resolvedAuthorId: AUTHOR,
      reportedCount: 67,
      recordsFetched: 67,
      recordsUpdated: 0,
      suppressedMatches: 0,
    });
    expect(summary.recordsNew + summary.recordsSkipped).toBe(67);
    expect(summary.warnings).toHaveLength(summary.recordsSkipped);

    const records = await prisma.publicationSourceRecord.findMany();
    expect(records).toHaveLength(summary.recordsNew);
    expect(records.every((r) => r.source === 'OPENALEX' && /^W\d+$/.test(r.externalId))).toBe(true);
    expect(records.every((r) => r.lastSeenAt?.toISOString() === '2026-09-01T00:00:00.000Z')).toBe(true);

    const links = await prisma.professorPublication.findMany();
    const linkedPublications = new Set(records.map((r) => r.publicationId));
    expect(links).toHaveLength(linkedPublications.size);
    expect(summary.linksCreated).toBe(linkedPublications.size);
    for (const link of links) {
      expect(link).toMatchObject({
        professorId: professor.id,
        status: 'PENDING',
        origin: 'DISCOVERED',
        discoveredViaIdentityId: identity.id,
        decidedAt: null,
      });
    }
  });

  it('never makes a discovered relationship APPROVED automatically', async () => {
    const { identity } = await identityFor();
    await discoverOpenAlexIdentity(identity.id, { openAlex: openAlex().client });
    expect(await prisma.professorPublication.count({ where: { status: { not: 'PENDING' } } })).toBe(0);
  });
});

describe('discoverOpenAlexIdentity — reruns (§14)', () => {
  it('is idempotent and refreshes last_seen_at', async () => {
    const { identity } = await identityFor();
    const first = await discoverOpenAlexIdentity(identity.id, { openAlex: openAlex().client, now: at('2026-09-01T00:00:00Z') });
    const before = await counts();

    const second = await discoverOpenAlexIdentity(identity.id, { openAlex: openAlex().client, now: at('2026-10-01T00:00:00Z') });
    expect(second).toMatchObject({ recordsNew: 0, recordsUpdated: first.recordsNew, linksCreated: 0, candidatesCreated: 0 });
    expect(await counts()).toEqual(before);
    const seen = await prisma.publicationSourceRecord.findMany({ select: { lastSeenAt: true } });
    expect(seen.every((r) => r.lastSeenAt?.toISOString() === '2026-10-01T00:00:00.000Z')).toBe(true);
  });

  it('keeps REJECTED and APPROVED relationships unchanged', async () => {
    const { identity } = await identityFor();
    await discoverOpenAlexIdentity(identity.id, { openAlex: openAlex().client });
    const [rejected, approved] = await prisma.professorPublication.findMany({ take: 2, orderBy: { id: 'asc' } });
    await prisma.professorPublication.update({ where: { id: rejected.id }, data: { status: 'REJECTED', decidedAt: new Date() } });
    await prisma.professorPublication.update({ where: { id: approved.id }, data: { status: 'APPROVED', decidedAt: new Date() } });

    await discoverOpenAlexIdentity(identity.id, { openAlex: openAlex().client });

    expect((await prisma.professorPublication.findUniqueOrThrow({ where: { id: rejected.id } })).status).toBe('REJECTED');
    expect((await prisma.professorPublication.findUniqueOrThrow({ where: { id: approved.id } })).status).toBe('APPROVED');
  });

  it('never re-links a SUPPRESSED publication', async () => {
    const { identity } = await identityFor();
    await discoverOpenAlexIdentity(identity.id, { openAlex: openAlex().client });
    const link = await prisma.professorPublication.findFirstOrThrow({ orderBy: { id: 'asc' } });
    await prisma.publication.update({ where: { id: link.publicationId }, data: { status: 'SUPPRESSED' } });
    await prisma.professorPublication.delete({ where: { id: link.id } });

    const rerun = await discoverOpenAlexIdentity(identity.id, { openAlex: openAlex().client });
    expect(rerun.suppressedMatches).toBeGreaterThanOrEqual(1);
    expect(rerun.linksCreated).toBe(0);
    expect(await prisma.professorPublication.count({ where: { publicationId: link.publicationId } })).toBe(0);
  });
});

describe('discoverOpenAlexIdentity — failures never write (§13.1, §14)', () => {
  const html200 = () =>
    new Response('<!DOCTYPE html><html><title>Just a moment...</title></html>', {
      status: 200,
      headers: { 'content-type': 'text/html' },
    });

  it('writes nothing when a later page is an HTML page served with 200', async () => {
    const { identity } = await identityFor();
    const error = await discoverOpenAlexIdentity(identity.id, {
      openAlex: openAlex({ [pages[1].request]: html200 }).client,
    }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(FetchError);
    expect(await counts()).toEqual({ publications: 0, sourceRecords: 0, links: 0, candidates: 0 });
  });

  it('leaves earlier data untouched when a later sync fails', async () => {
    const { identity } = await identityFor();
    await discoverOpenAlexIdentity(identity.id, { openAlex: openAlex().client, now: at('2026-09-01T00:00:00Z') });
    const before = await counts();
    const seenBefore = await prisma.publicationSourceRecord.findMany({ select: { id: true, lastSeenAt: true }, orderBy: { id: 'asc' } });

    await expect(
      discoverOpenAlexIdentity(identity.id, { openAlex: openAlex({ [pages[2].request]: html200 }).client, now: at('2026-10-01T00:00:00Z') }),
    ).rejects.toBeInstanceOf(FetchError);

    expect(await counts()).toEqual(before);
    expect(await prisma.publicationSourceRecord.findMany({ select: { id: true, lastSeenAt: true }, orderBy: { id: 'asc' } })).toEqual(seenBefore);
  });

  it('writes nothing for a nonexistent identity (never "zero publications")', async () => {
    const { identity } = await identityFor('A5999999999');
    const error = await discoverOpenAlexIdentity(identity.id, { openAlex: openAlex().client }).catch((e: unknown) => e);
    expect(error).toMatchObject({ kind: 'IDENTITY_NOT_FOUND' });
    expect(await counts()).toEqual({ publications: 0, sourceRecords: 0, links: 0, candidates: 0 });
  });
});

describe('discoverOpenAlexIdentity — preconditions', () => {
  it.each([
    ['an inactive identity', { identity: { isActive: false } }],
    ['an inactive professor', { professor: { isActive: false } }],
  ])('refuses %s without calling OpenAlex', async (_label, change) => {
    const { professor, identity } = await identityFor();
    if ('identity' in change) await prisma.externalIdentity.update({ where: { id: identity.id }, data: change.identity });
    if ('professor' in change) await prisma.professor.update({ where: { id: professor.id }, data: change.professor });
    const { client, calls } = openAlex();

    await expect(discoverOpenAlexIdentity(identity.id, { openAlex: client })).rejects.toBeInstanceOf(DiscoveryPreconditionError);
    expect(calls).toHaveLength(0);
  });

  it('refuses a non-OpenAlex identity and an unknown identity', async () => {
    const professor = await prisma.professor.create({ data: { name: 'P' } });
    const dblp = await prisma.externalIdentity.create({ data: { professorId: professor.id, source: 'DBLP', externalId: 'v/X' } });
    await expect(discoverOpenAlexIdentity(dblp.id, { openAlex: openAlex().client })).rejects.toThrow(/not OPENALEX/);
    await expect(
      discoverOpenAlexIdentity('00000000-0000-4000-8000-000000000000', { openAlex: openAlex().client }),
    ).rejects.toThrow(/not found/);
  });
});

describe('discoverOpenAlexIdentity — identities and relationships', () => {
  it("writes nothing for OpenAlex's documented merged-author example, which really answers 404 (recorded)", async () => {
    const { identity } = await identityFor('A5092938886');
    const replay = replayFetch([fx('author-merged-documented')]);
    const client = new OpenAlexClient({ perPage: 25, deps: { fetchImpl: replay.fetchImpl, sleep: noSleep } });

    const error = await discoverOpenAlexIdentity(identity.id, { openAlex: client }).catch((e: unknown) => e);

    expect(error).toMatchObject({ kind: 'IDENTITY_NOT_FOUND' });
    expect(replay.calls.some((c) => c.url.includes('/works'))).toBe(false);
    expect(await counts()).toEqual({ publications: 0, sourceRecords: 0, links: 0, candidates: 0 });
    expect((await prisma.externalIdentity.findUniqueOrThrow({ where: { id: identity.id } })).externalId).toBe('A5092938886');
  });

  it('reports a merged author ID and fetches with the resolved ID (simulated redirect)', async () => {
    const { identity } = await identityFor('A1111111111');
    const summary = await discoverOpenAlexIdentity(identity.id, {
      openAlex: openAlex({ [authorUrl('A1111111111')]: authorValid }).client,
    });
    expect(summary).toMatchObject({ requestedAuthorId: 'A1111111111', resolvedAuthorId: AUTHOR });
    expect(summary.warnings[0]).toContain('has been merged into A5023888391');
    // Identities are admin-managed: the stored ID is not changed automatically.
    expect((await prisma.externalIdentity.findUniqueOrThrow({ where: { id: identity.id } })).externalId).toBe('A1111111111');
  });

  it('links each publication once when one professor has two OpenAlex identities (split profile)', async () => {
    const { professor, identity } = await identityFor();
    const second = await prisma.externalIdentity.create({
      data: { professorId: professor.id, source: 'OPENALEX', externalId: 'A1111111111' },
    });
    const client = openAlex({ [authorUrl('A1111111111')]: authorValid }).client;

    const first = await discoverOpenAlexIdentity(identity.id, { openAlex: client });
    const again = await discoverOpenAlexIdentity(second.id, { openAlex: client });

    expect(again.linksCreated).toBe(0);
    expect(await prisma.professorPublication.count()).toBe(first.linksCreated);
    // The relationship keeps the identity that discovered it first.
    expect(await prisma.professorPublication.count({ where: { discoveredViaIdentityId: second.id } })).toBe(0);
  });

  it('links the same publications to a co-author without duplicating publications', async () => {
    const { identity } = await identityFor(AUTHOR, 'Prof A');
    const { professor: b, identity: identityB } = await identityFor('A1111111111', 'Prof B');
    const client = openAlex({ [authorUrl('A1111111111')]: authorValid }).client;

    const first = await discoverOpenAlexIdentity(identity.id, { openAlex: client });
    const publications = await prisma.publication.count();
    const second = await discoverOpenAlexIdentity(identityB.id, { openAlex: client });

    expect(await prisma.publication.count()).toBe(publications);
    expect(second.linksCreated).toBe(first.linksCreated);
    expect(await prisma.professorPublication.count({ where: { professorId: b.id, status: 'PENDING' } })).toBe(first.linksCreated);
  });

  it('attaches to a manually added publication and keeps the professor\'s APPROVED manual relationship', async () => {
    const { professor, identity } = await identityFor();
    const work = (pages[0].body as { results: Array<{ id: string; doi: string | null; title: string; publication_year: number; type: string }> }).results.find(
      (w) => w.doi && w.title,
    )!;
    const doi = normalizeDoi(work.doi)!;
    const manual = await prisma.publication.create({
      data: { title: work.title, normalizedTitle: 'manual', year: work.publication_year, typeFamily: 'OTHER', doi },
    });
    await prisma.publicationSourceRecord.create({
      data: {
        publicationId: manual.id,
        source: 'MANUAL',
        externalId: '6f1f5c3e-1b1e-4a8e-9c1d-00000000000a',
        title: work.title,
        normalizedTitle: work.title.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim(),
        doi,
        year: work.publication_year,
        typeFamily: 'OTHER',
        matchMethod: 'NEW_PUBLICATION',
      },
    });
    await prisma.professorPublication.create({
      data: { professorId: professor.id, publicationId: manual.id, status: 'APPROVED', origin: 'MANUAL' },
    });

    await discoverOpenAlexIdentity(identity.id, { openAlex: openAlex().client });

    const record = await prisma.publicationSourceRecord.findUniqueOrThrow({
      where: { source_externalId: { source: 'OPENALEX', externalId: work.id.replace('https://openalex.org/', '') } },
    });
    expect(record).toMatchObject({ publicationId: manual.id, matchMethod: 'DOI' });
    const link = await prisma.professorPublication.findUniqueOrThrow({
      where: { professorId_publicationId: { professorId: professor.id, publicationId: manual.id } },
    });
    expect(link).toMatchObject({ status: 'APPROVED', origin: 'MANUAL', discoveredViaIdentityId: null });
  });
});
