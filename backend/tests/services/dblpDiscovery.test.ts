import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { prisma } from '../../src/config/database';
import { DblpClient } from '../../src/integrations/dblp/client';
import { FetchError } from '../../src/integrations/http/httpClient';
import { mapOpenAlexWork } from '../../src/integrations/openalex/mapper';
import { OpenAlexWorkSchema } from '../../src/integrations/openalex/types';
import { discoverDblpIdentity } from '../../src/services/discovery/dblpDiscovery';
import { DiscoveryPreconditionError } from '../../src/services/discovery/discoveryIdentity';
import { ingestDiscoveredRecords } from '../../src/services/discovery/ingestDiscoveredRecords';
import { ingestPublication } from '../../src/services/matching/engine';
import { buildNormalizedPublication } from '../../src/services/normalization/normalizedPublication';
import { resetDatabase } from '../helpers/database';
import { loadFixture, noSleep, replayFetch, Route, toResponse } from '../helpers/fixtures';

// Each discovery ingests 830 real records (~2–3 s); reruns double that.
vi.setConfig({ testTimeout: 30_000 });

const fx = (name: string) => loadFixture('dblp', name);
const PID = 'v/MosheYVardi';
const identityPerson = fx('identity-person');
const records = fx('records-person');
const authors = fx('authors-person');

function dblp(overrides: Record<string, Route> = {}) {
  const replay = replayFetch([identityPerson, records, authors, fx('identity-ambiguous'), fx('identity-missing')], overrides);
  return { client: new DblpClient({ deps: { fetchImpl: replay.fetchImpl, sleep: noSleep } }), calls: replay.calls };
}

async function identityFor(externalId = PID, source: 'DBLP' | 'OPENALEX' = 'DBLP') {
  const professor = await prisma.professor.create({ data: { name: 'Moshe Y. Vardi' } });
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

describe('discoverDblpIdentity — first discovery', () => {
  it('ingests all 830 authored records and creates PENDING relationships via the identity', async () => {
    const { professor, identity } = await identityFor();
    const summary = await discoverDblpIdentity(identity.id, { dblp: dblp().client, now: at('2026-09-01T00:00:00Z') });

    expect(summary).toMatchObject({
      identityId: identity.id,
      pid: PID,
      personName: 'Moshe Y. Vardi',
      recordsFetched: 830,
      recordsNew: 830,
      recordsUpdated: 0,
      recordsSkipped: 0,
    });

    const recordsInDb = await prisma.publicationSourceRecord.findMany();
    expect(recordsInDb).toHaveLength(830);
    expect(recordsInDb.every((r) => r.source === 'DBLP' && r.lastSeenAt?.toISOString() === '2026-09-01T00:00:00.000Z')).toBe(true);

    const publicationIds = new Set(recordsInDb.map((r) => r.publicationId));
    const links = await prisma.professorPublication.findMany();
    expect(links).toHaveLength(publicationIds.size);
    expect(links.every((l) => l.professorId === professor.id && l.status === 'PENDING' && l.origin === 'DISCOVERED' && l.discoveredViaIdentityId === identity.id)).toBe(true);
  });

  it('never ingests editor-only records', async () => {
    const { identity } = await identityFor();
    await discoverDblpIdentity(identity.id, { dblp: dblp().client });
    for (const key of ['conf/cav/1998', 'conf/aaai/2016ethics', 'conf/forte/2002']) {
      expect(await prisma.publicationSourceRecord.count({ where: { source: 'DBLP', externalId: key } }), key).toBe(0);
    }
  });

  it('keeps the CoRR preprint apart from its published version (a candidate, not a merge)', async () => {
    const { identity } = await identityFor();
    await discoverDblpIdentity(identity.id, { dblp: dblp().client });
    const [published, corr] = await Promise.all(
      ['conf/cp/ChakrabortyMV13', 'journals/corr/ChakrabortyMV13'].map((externalId) =>
        prisma.publicationSourceRecord.findUniqueOrThrow({ where: { source_externalId: { source: 'DBLP', externalId } } }),
      ),
    );
    expect(corr.publicationId).not.toBe(published.publicationId);
    const [a, b] = [corr.publicationId, published.publicationId].sort();
    const candidate = await prisma.duplicateCandidate.findUniqueOrThrow({
      where: { publicationAId_publicationBId: { publicationAId: a, publicationBId: b } },
    });
    expect(candidate.reason).toContain('preprint vs published');
  });
});

describe('discoverDblpIdentity — preprint classification in the pipeline (decision #40)', () => {
  it('merges a published LMCS paper filed under journals/corr/ with the same paper from another source (no split)', async () => {
    // The LMCS article as another source reports it (OpenAlex lists this DOI as a journal article).
    const other = await ingestPublication(
      buildNormalizedPublication({
        source: 'OPENALEX',
        externalId: 'W1644968762',
        title: 'State of Büchi Complementation',
        dois: ['https://doi.org/10.2168/LMCS-10(4:13)2014'],
        year: 2014,
        typeFamily: 'JOURNAL',
      }),
    );
    const { identity } = await identityFor();
    await discoverDblpIdentity(identity.id, { dblp: dblp().client });

    const dblpRecord = await prisma.publicationSourceRecord.findUniqueOrThrow({
      where: { source_externalId: { source: 'DBLP', externalId: 'journals/corr/TsaiFVT14' } },
    });
    expect(dblpRecord).toMatchObject({ publicationId: other.publicationId, typeFamily: 'JOURNAL', matchMethod: 'DOI' });
    const candidates = await prisma.duplicateCandidate.findMany({
      where: { OR: [{ publicationAId: other.publicationId }, { publicationBId: other.publicationId }] },
    });
    // No preprint-vs-published split any more. The only candidate is the separate conference
    // version (conf/wia/TsaiFVT10: same title, different DOI/year/type), as Phase 3 intends.
    expect(candidates.some((c) => c.reason.includes('preprint vs published'))).toBe(false);
    expect(candidates).toHaveLength(1);
    const wia = await prisma.publicationSourceRecord.findUniqueOrThrow({
      where: { source_externalId: { source: 'DBLP', externalId: 'conf/wia/TsaiFVT10' } },
    });
    expect([candidates[0].publicationAId, candidates[0].publicationBId]).toContain(wia.publicationId);
    expect(candidates[0].reason).toContain('incompatible type families');
  });

  it('stores Dagstuhl seminar items as OTHER and real CoRR preprints as PREPRINT', async () => {
    const { identity } = await identityFor();
    await discoverDblpIdentity(identity.id, { dblp: dblp().client });
    const family = async (externalId: string) =>
      (await prisma.publicationSourceRecord.findUniqueOrThrow({ where: { source_externalId: { source: 'DBLP', externalId } } })).typeFamily;
    expect(await family('conf/dagstuhl/KautzTV05')).toBe('OTHER');
    expect(await family('journals/dagstuhl-reports/MehlhornVH12')).toBe('OTHER');
    expect(await family('journals/corr/ChakrabortyMV13')).toBe('PREPRINT');
    expect(await family('journals/corr/abs-2005-09125')).toBe('CONFERENCE');
    expect(await prisma.publicationSourceRecord.count({ where: { source: 'DBLP', typeFamily: 'PREPRINT' } })).toBe(97);
  });
});

describe('discoverDblpIdentity — reruns (§14)', () => {
  it('is idempotent and refreshes last_seen_at', async () => {
    const { identity } = await identityFor();
    await discoverDblpIdentity(identity.id, { dblp: dblp().client, now: at('2026-09-01T00:00:00Z') });
    const before = await counts();

    const second = await discoverDblpIdentity(identity.id, { dblp: dblp().client, now: at('2026-10-01T00:00:00Z') });
    expect(second).toMatchObject({ recordsNew: 0, recordsUpdated: 830, linksCreated: 0, candidatesCreated: 0 });
    expect(await counts()).toEqual(before);
    expect(await prisma.publicationSourceRecord.count({ where: { lastSeenAt: new Date('2026-10-01T00:00:00Z') } })).toBe(830);
  });

  it('keeps REJECTED relationships rejected', async () => {
    const { identity } = await identityFor();
    await discoverDblpIdentity(identity.id, { dblp: dblp().client });
    const link = await prisma.professorPublication.findFirstOrThrow({ orderBy: { id: 'asc' } });
    await prisma.professorPublication.update({ where: { id: link.id }, data: { status: 'REJECTED', decidedAt: new Date() } });

    await discoverDblpIdentity(identity.id, { dblp: dblp().client });
    expect((await prisma.professorPublication.findUniqueOrThrow({ where: { id: link.id } })).status).toBe('REJECTED');
  });
});

describe('discoverDblpIdentity — failures write nothing (§13.1, §14)', () => {
  const failureCases: Array<[string, Record<string, Route>]> = [
    ['the real dblp bot-protection page on the records query', { [records.request]: () => toResponse(fx('dblp-org-pid-xml')) }],
    ['the real SPARQL 400 error on the records query', { [records.request]: () => toResponse(fx('sparql-syntax-error')) }],
    ['an HTML page on the authors query (after records succeeded)', {
      [authors.request]: () => new Response('<!doctype html><html></html>', { status: 200, headers: { 'content-type': 'text/html' } }),
    }],
  ];

  it.each(failureCases)('writes nothing for %s', async (_label, overrides) => {
    const { identity } = await identityFor();
    const error = await discoverDblpIdentity(identity.id, { dblp: dblp(overrides).client }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(FetchError);
    expect(await counts()).toEqual(empty);
  });

  it('leaves earlier data and last_seen_at untouched when a later sync fails', async () => {
    const { identity } = await identityFor();
    await discoverDblpIdentity(identity.id, { dblp: dblp().client, now: at('2026-09-01T00:00:00Z') });
    const before = await counts();

    await expect(
      discoverDblpIdentity(identity.id, {
        dblp: dblp({ [authors.request]: () => toResponse(fx('dblp-org-pid-xml')) }).client,
        now: at('2026-10-01T00:00:00Z'),
      }),
    ).rejects.toBeInstanceOf(FetchError);

    expect(await counts()).toEqual(before);
    expect(await prisma.publicationSourceRecord.count({ where: { lastSeenAt: new Date('2026-09-01T00:00:00Z') } })).toBe(830);
  });

  it('writes nothing for a disambiguation PID (IDENTITY_INVALID) and never queries its records', async () => {
    const { identity } = await identityFor('00/10049');
    const { client, calls } = dblp();
    const error = await discoverDblpIdentity(identity.id, { dblp: client }).catch((e: unknown) => e);
    expect(error).toMatchObject({ kind: 'IDENTITY_INVALID' });
    expect(calls).toHaveLength(1);
    expect(await counts()).toEqual(empty);
  });

  it('writes nothing for a nonexistent PID (never "zero publications")', async () => {
    const { identity } = await identityFor('00/0000000');
    const error = await discoverDblpIdentity(identity.id, { dblp: dblp().client }).catch((e: unknown) => e);
    expect(error).toMatchObject({ kind: 'IDENTITY_NOT_FOUND' });
    expect(await counts()).toEqual(empty);
  });

  it('refuses non-DBLP and inactive identities without calling dblp', async () => {
    const { identity: openAlexIdentity } = await identityFor('A5000059818', 'OPENALEX');
    const { client, calls } = dblp();
    await expect(discoverDblpIdentity(openAlexIdentity.id, { dblp: client })).rejects.toThrow(/not DBLP/);

    const { identity } = await identityFor();
    await prisma.externalIdentity.update({ where: { id: identity.id }, data: { isActive: false } });
    await expect(discoverDblpIdentity(identity.id, { dblp: client })).rejects.toBeInstanceOf(DiscoveryPreconditionError);
    expect(calls).toHaveLength(0);
  });
});

describe('cross-source: recorded OpenAlex and DBLP data for the same professor', () => {
  it('merges the same papers from both sources into one canonical publication each', async () => {
    const { professor, identity } = await identityFor();
    // OpenAlex first (recorded Vardi works), attributed to an OpenAlex identity of the same professor.
    const openAlexIdentity = await prisma.externalIdentity.create({
      data: { professorId: professor.id, source: 'OPENALEX', externalId: 'A5000059818' },
    });
    const works = (loadFixture('openalex', 'works-cases').body as { results: unknown[] }).results.map((w) =>
      mapOpenAlexWork(OpenAlexWorkSchema.parse(w)),
    );
    await ingestDiscoveredRecords({ id: openAlexIdentity.id, professorId: professor.id }, works, { seenAt: new Date() });

    const summary = await discoverDblpIdentity(identity.id, { dblp: dblp().client });

    const publicationOf = (source: 'OPENALEX' | 'DBLP', externalId: string) =>
      prisma.publicationSourceRecord
        .findUniqueOrThrow({ where: { source_externalId: { source, externalId } } })
        .then((r) => r.publicationId);
    const pairs: Array<[string, string, string]> = [
      ['W1632042597', 'conf/aaai/ChakrabortyFMSV14', 'DOI (DBLP uppercase DOI)'],
      ['W2889619879', 'conf/aaai/PratesALLV19', 'DOI (two OpenAlex works + one DBLP record)'],
      ['W1989783863', 'conf/stoc/Vardi82', 'DOI'],
      ['W1505349556', 'conf/stacs/KupfermanLVY11', 'DOI (OpenAlex repository-hosted, OTHER)'],
      ['W2033071128', 'journals/jcss/VardiW86', 'DOI'],
      ['W42364276', 'conf/lics/VardiW86', 'exact title + year, no DOI'],
      ['W3037471945', 'journals/corr/abs-2003-00330', 'two preprints, exact title + year'],
    ];
    for (const [workId, key, how] of pairs) {
      expect(await publicationOf('DBLP', key), `${workId} ↔ ${key} (${how})`).toBe(await publicationOf('OPENALEX', workId));
    }
    expect(await publicationOf('OPENALEX', 'W2963382544')).toBe(await publicationOf('DBLP', 'conf/aaai/PratesALLV19'));

    // Canonical metadata: OpenAlex outranks DBLP (§9).
    const aaai = await prisma.publication.findUniqueOrThrow({ where: { id: await publicationOf('DBLP', 'conf/aaai/ChakrabortyFMSV14') } });
    expect(aaai.title).toBe('Distribution-Aware Sampling and Weighted Model Counting for SAT');
    expect(aaai.doi).toBe('10.1609/aaai.v28i1.8990');

    // One relationship per publication for the professor, whichever identity found it first.
    const links = await prisma.professorPublication.findMany({ where: { professorId: professor.id } });
    expect(new Set(links.map((l) => l.publicationId)).size).toBe(links.length);
    expect(summary.recordsFetched).toBe(830);
  });
});
