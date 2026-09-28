import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { prisma } from '../../src/config/database';
import { DblpClient } from '../../src/integrations/dblp/client';
import { FetchError } from '../../src/integrations/http/httpClient';
import { ORCID_API_BASE_URL, OrcidClient } from '../../src/integrations/orcid/client';
import { discoverDblpIdentity } from '../../src/services/discovery/dblpDiscovery';
import { DiscoveryPreconditionError } from '../../src/services/discovery/discoveryIdentity';
import { discoverOrcidIdentity } from '../../src/services/discovery/orcidDiscovery';
import { resetDatabase } from '../helpers/database';
import { loadFixture, noSleep, replayFetch, Route, toResponse } from '../helpers/fixtures';

// The cross-source test ingests 830 DBLP records first.
vi.setConfig({ testTimeout: 30_000 });

const fx = (name: string) => loadFixture('orcid', name);
const PIWOWAR = '0000-0003-1613-5981';
const VARDI = '0000-0002-0661-5773';
const worksUrl = (orcid: string) => `${ORCID_API_BASE_URL}/${orcid}/works`;

function orcidClient(overrides: Record<string, Route> = {}) {
  const replay = replayFetch(
    ['works-piwowar', 'works-vardi', 'works-carberry', 'works-not-found', 'works-deactivated'].map(fx),
    overrides,
  );
  return { client: new OrcidClient({ deps: { fetchImpl: replay.fetchImpl, sleep: noSleep } }), calls: replay.calls };
}

async function identityFor(externalId: string, source: 'ORCID' | 'DBLP' = 'ORCID', professorName = 'Prof') {
  const professor = await prisma.professor.create({ data: { name: professorName } });
  const identity = await prisma.externalIdentity.create({ data: { professorId: professor.id, source, externalId } });
  return { professor, identity };
}

const counts = async () => ({
  publications: await prisma.publication.count(),
  sourceRecords: await prisma.publicationSourceRecord.count(),
  links: await prisma.professorPublication.count(),
  candidates: await prisma.duplicateCandidate.count(),
});
const empty = { publications: 0, sourceRecords: 0, links: 0, candidates: 0 };
const at = (iso: string) => () => new Date(iso);

beforeEach(async () => {
  await resetDatabase();
});

afterAll(async () => {
  await resetDatabase();
  await prisma.$disconnect();
});

describe('discoverOrcidIdentity — recorded ORCID record', () => {
  it('ingests one source record per work summary and links each publication once as PENDING', async () => {
    const { professor, identity } = await identityFor(PIWOWAR);
    const summary = await discoverOrcidIdentity(identity.id, { orcid: orcidClient().client, now: at('2026-09-01T00:00:00Z') });

    expect(summary).toMatchObject({ identityId: identity.id, orcid: PIWOWAR, recordsFetched: 100, recordsNew: 100, recordsSkipped: 0 });
    const records = await prisma.publicationSourceRecord.findMany();
    expect(records).toHaveLength(100);
    expect(records.every((r) => r.source === 'ORCID' && r.externalId.startsWith(`${PIWOWAR}:`))).toBe(true);
    expect(records.every((r) => r.lastSeenAt?.toISOString() === '2026-09-01T00:00:00.000Z')).toBe(true);

    const links = await prisma.professorPublication.findMany();
    expect(links).toHaveLength(new Set(records.map((r) => r.publicationId)).size);
    expect(links.every((l) => l.professorId === professor.id && l.status === 'PENDING' && l.discoveredViaIdentityId === identity.id)).toBe(true);
  });

  it('merges ORCID in-source duplicates (several put-codes, one DOI) into one publication', async () => {
    const { identity } = await identityFor(PIWOWAR);
    await discoverOrcidIdentity(identity.id, { orcid: orcidClient().client });

    const body = fx('works-piwowar').body as {
      group: Array<{ 'work-summary': Array<{ 'put-code': number }>; 'external-ids': { 'external-id': Array<{ 'external-id-type': string }> } }>;
    };
    const duplicateGroups = body.group.filter(
      (g) => g['work-summary'].length > 1 && g['external-ids']['external-id'].some((e) => e['external-id-type'] === 'doi'),
    );
    expect(duplicateGroups.length).toBeGreaterThan(0);
    for (const group of duplicateGroups) {
      const publicationIds = new Set(
        await Promise.all(
          group['work-summary'].map(async (w) =>
            (await prisma.publicationSourceRecord.findUniqueOrThrow({
              where: { source_externalId: { source: 'ORCID', externalId: `${PIWOWAR}:${w['put-code']}` } },
            })).publicationId,
          ),
        ),
      );
      expect(publicationIds.size).toBe(1);
    }
    expect(await prisma.publication.count()).toBeLessThan(100);
  });

  it('skips titleless summaries with a warning and keeps a record with no year', async () => {
    const { identity } = await identityFor(VARDI);
    const summary = await discoverOrcidIdentity(identity.id, { orcid: orcidClient().client });
    expect(summary).toMatchObject({ recordsFetched: 8, recordsNew: 5, recordsSkipped: 3 });
    expect(summary.warnings.filter((w) => w.includes('no usable title'))).toHaveLength(3);
    const noYear = await prisma.publicationSourceRecord.findUniqueOrThrow({
      where: { source_externalId: { source: 'ORCID', externalId: `${VARDI}:5160615` } },
    });
    expect(noYear.year).toBeNull();
  });

  it('treats a well-formed record with no works as a genuine empty result (nothing written, no error)', async () => {
    const { identity } = await identityFor(VARDI);
    const emptyWorks = structuredClone(fx('works-vardi'));
    (emptyWorks.body as { group: unknown[] }).group = [];
    const summary = await discoverOrcidIdentity(identity.id, {
      orcid: orcidClient({ [worksUrl(VARDI)]: () => toResponse(emptyWorks) }).client,
    });
    expect(summary).toMatchObject({ recordsFetched: 0, recordsNew: 0, linksCreated: 0 });
    expect(await counts()).toEqual(empty);
  });
});

describe('discoverOrcidIdentity — reruns (§14)', () => {
  it('is idempotent, refreshes last_seen_at and keeps REJECTED relationships', async () => {
    const { identity } = await identityFor(PIWOWAR);
    await discoverOrcidIdentity(identity.id, { orcid: orcidClient().client, now: at('2026-09-01T00:00:00Z') });
    const before = await counts();
    const link = await prisma.professorPublication.findFirstOrThrow({ orderBy: { id: 'asc' } });
    await prisma.professorPublication.update({ where: { id: link.id }, data: { status: 'REJECTED', decidedAt: new Date() } });

    const second = await discoverOrcidIdentity(identity.id, { orcid: orcidClient().client, now: at('2026-10-01T00:00:00Z') });
    expect(second).toMatchObject({ recordsNew: 0, recordsUpdated: 100, linksCreated: 0, candidatesCreated: 0 });
    expect(await counts()).toEqual(before);
    expect(await prisma.publicationSourceRecord.count({ where: { lastSeenAt: new Date('2026-10-01T00:00:00Z') } })).toBe(100);
    expect((await prisma.professorPublication.findUniqueOrThrow({ where: { id: link.id } })).status).toBe('REJECTED');
  });
});

describe('discoverOrcidIdentity — failures write nothing (§13.1, §14)', () => {
  const failures: Array<[string, string, Record<string, Route>, FetchError['kind']]> = [
    ['the real 404 for a nonexistent iD', '0000-0001-2345-6789', {}, 'IDENTITY_NOT_FOUND'],
    ['the real 409 for a deactivated record', '0000-0002-0155-3227', {}, 'IDENTITY_INVALID'],
    ['a deprecated iD (documented 301, simulated)', PIWOWAR, {
      [worksUrl(PIWOWAR)]: () => new Response('', { status: 301, headers: { location: 'https://orcid.org/0000-0002-1825-0097' } }),
    }, 'IDENTITY_INVALID'],
    ['an HTML page with HTTP 200', PIWOWAR, {
      [worksUrl(PIWOWAR)]: () => new Response('<!doctype html><html></html>', { status: 200, headers: { 'content-type': 'text/html' } }),
    }, 'CONTENT_TYPE'],
    ['malformed JSON with HTTP 200', PIWOWAR, {
      [worksUrl(PIWOWAR)]: () => new Response('{"group":[', { status: 200, headers: { 'content-type': 'application/json' } }),
    }, 'MALFORMED_BODY'],
  ];

  it.each(failures)('writes nothing for %s', async (_label, orcidId, overrides, kind) => {
    const { identity } = await identityFor(orcidId);
    const error = await discoverOrcidIdentity(identity.id, { orcid: orcidClient(overrides).client }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(FetchError);
    expect((error as FetchError).kind).toBe(kind);
    expect(await counts()).toEqual(empty);
  });

  it('leaves earlier data and last_seen_at untouched when a later fetch fails', async () => {
    const { identity } = await identityFor(PIWOWAR);
    await discoverOrcidIdentity(identity.id, { orcid: orcidClient().client, now: at('2026-09-01T00:00:00Z') });
    const before = await counts();
    await expect(
      discoverOrcidIdentity(identity.id, {
        orcid: orcidClient({ [worksUrl(PIWOWAR)]: () => new Response('', { status: 503 }) }).client,
        now: at('2026-10-01T00:00:00Z'),
      }),
    ).rejects.toBeInstanceOf(FetchError);
    expect(await counts()).toEqual(before);
    expect(await prisma.publicationSourceRecord.count({ where: { lastSeenAt: new Date('2026-09-01T00:00:00Z') } })).toBe(100);
  });

  it('refuses non-ORCID and inactive identities without calling ORCID', async () => {
    const { identity: dblp } = await identityFor('v/MosheYVardi', 'DBLP');
    const { client, calls } = orcidClient();
    await expect(discoverOrcidIdentity(dblp.id, { orcid: client })).rejects.toThrow(/not ORCID/);
    const { professor, identity } = await identityFor(PIWOWAR);
    await prisma.professor.update({ where: { id: professor.id }, data: { isActive: false } });
    await expect(discoverOrcidIdentity(identity.id, { orcid: client })).rejects.toBeInstanceOf(DiscoveryPreconditionError);
    expect(calls).toHaveLength(0);
  });
});

describe('cross-source: recorded DBLP and ORCID data for the same professor (Vardi)', () => {
  it('matches ORCID works without DOIs to DBLP records through the Phase 3 rules', async () => {
    const { professor, identity: dblpIdentity } = await identityFor('v/MosheYVardi', 'DBLP', 'Moshe Y. Vardi');
    const orcidIdentity = await prisma.externalIdentity.create({ data: { professorId: professor.id, source: 'ORCID', externalId: VARDI } });

    const dblpReplay = replayFetch(['identity-person', 'records-person', 'authors-person'].map((n) => loadFixture('dblp', n)));
    await discoverDblpIdentity(dblpIdentity.id, { dblp: new DblpClient({ deps: { fetchImpl: dblpReplay.fetchImpl, sleep: noSleep } }) });
    const linksAfterDblp = await prisma.professorPublication.count();

    const summary = await discoverOrcidIdentity(orcidIdentity.id, { orcid: orcidClient().client });

    const pub = (source: 'DBLP' | 'ORCID', externalId: string) =>
      prisma.publicationSourceRecord.findUniqueOrThrow({ where: { source_externalId: { source, externalId } } });

    // "Module Checking" (ORCID 2001 journal article, no DOI) matches the 2001 journal version by exact
    // title + year + type — not the 1996 conference version, which is only a candidate.
    const moduleChecking = await pub('ORCID', `${VARDI}:5160614`);
    expect(moduleChecking.matchMethod).toBe('TITLE_YEAR');
    expect(moduleChecking.publicationId).toBe((await pub('DBLP', 'journals/iandc/KupfermanVW01')).publicationId);
    expect(moduleChecking.publicationId).not.toBe((await pub('DBLP', 'conf/cav/KupfermanV96')).publicationId);

    // "Endmarkers can make a difference" (1990) matches DBLP journals/ipl/Vardi90.
    const endmarkers = await pub('ORCID', `${VARDI}:5160613`);
    expect(endmarkers.publicationId).toBe((await pub('DBLP', 'journals/ipl/Vardi90')).publicationId);

    // No year on ORCID's "On decomposition of relational databases": the exact-title match with the
    // FOCS 1982 paper is blocked and recorded as a candidate, not merged.
    const noYear = await pub('ORCID', `${VARDI}:5160615`);
    const focs = await pub('DBLP', 'conf/focs/Vardi82');
    expect(noYear.publicationId).not.toBe(focs.publicationId);
    const [a, b] = [noYear.publicationId, focs.publicationId].sort();
    const candidate = await prisma.duplicateCandidate.findUniqueOrThrow({
      where: { publicationAId_publicationBId: { publicationAId: a, publicationBId: b } },
    });
    expect(candidate.reason).toContain('year unknown');

    // DBLP metadata outranks ORCID for the merged publication (§9).
    const merged = await prisma.publication.findUniqueOrThrow({ where: { id: moduleChecking.publicationId } });
    expect(merged.doi).toBe('10.1006/inco.2000.2893');

    // The professor keeps one relationship per publication across both identities.
    const links = await prisma.professorPublication.findMany({ where: { professorId: professor.id } });
    expect(new Set(links.map((l) => l.publicationId)).size).toBe(links.length);
    expect(summary.linksCreated).toBe(links.length - linksAfterDblp);
  });
});
