import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { createApp } from '../../src/app';
import { prisma } from '../../src/config/database';
import { discoverDblpIdentity } from '../../src/services/discovery/dblpDiscovery';
import { discoverOpenAlexIdentity } from '../../src/services/discovery/openAlexDiscovery';
import { discoverOrcidIdentity } from '../../src/services/discovery/orcidDiscovery';
import { discoverScopusIdentity } from '../../src/services/discovery/scopusDiscovery';
import { discoverWosIdentity } from '../../src/services/discovery/wosDiscovery';
import { addManualPublication } from '../../src/services/manual/manualPublications';
import { detachSourceRecord, mergeCandidate } from '../../src/services/publications/duplicates';
import { SyncService } from '../../src/services/sync/syncService';
import { createUser, testClock } from '../auth/helpers';
import { resetDatabase } from '../helpers/database';
import { allProvidersPresent } from '../helpers/providers';
import { adminCookie } from '../professors/helpers';
import { fiveProviderClients, IDS, ProviderRecord, ProviderWorld } from '../fixtures/synthetic/fiveProviders';
import * as scopusFixtures from '../fixtures/scopus/synthetic';
import * as wosFixtures from '../fixtures/wos/synthetic';

/*
 * Cross-provider matching and citation validation (stage 15.5): the same papers as OpenAlex, DBLP,
 * ORCID, Scopus, Web of Science and a manual entry describe them, through the real synchronization
 * engine, the real provider clients (synthetic responses, no network) and the unchanged §8 rules.
 */

vi.setConfig({ testTimeout: 120_000 });

const T1 = '2026-11-01T02:00:00.000Z';
const T2 = '2026-12-01T02:00:00.000Z';

/* ── The papers ───────────────────────────────────────────────────────────── */

const A = 'Deterministic Matching of Synthetic Bibliographic Records';
const B = 'Conference Paper on Cross-provider Provenance';
const C = 'Ambiguous Synthetic Study of Duplicate Candidates';
const E = 'Preprint and Published Versions of One Synthetic Study';
const D = 'An unrelated self-reported work about compilers';
const DOI = { A: '10.5555/xp.a', B: '10.5555/xp.b', C: '10.5555/xp.c', E: '10.5555/xp.e', E_ARXIV: '10.48550/arxiv.2101.00001' };

const rec = (n: number, fields: Omit<ProviderRecord, 'n'>): ProviderRecord => ({ n, ...fields });

/**
 * A — a journal article every provider reports with its DOI (spelled differently; WoS gives the
 *     final publication year 2022);
 * B — a conference paper DBLP and ORCID report without a DOI (attached by exact title + year);
 * C — a journal article Scopus reports as an editorial without a DOI (OTHER: never merged by title,
 *     so a duplicate candidate);
 * D — an ORCID work carrying paper A's DOI under an unrelated title (decision #22: not merged);
 * E — a preprint (OpenAlex, DBLP; arXiv DOI) and its published version (Scopus, WoS): never merged.
 */
function papers(cites = { scopusA: 7, wosA: 5 }): ProviderWorld {
  return {
    OPENALEX: [
      rec(1, { title: A, year: 2021, doi: DOI.A, venue: 'Journal of Synthetic Results', kind: 'journal', authors: ['Asha Verma', 'Sunil Rao'] }),
      rec(2, { title: B, year: 2020, doi: DOI.B, venue: 'Synthetic Conference on Provenance', kind: 'conference' }),
      rec(3, { title: C, year: 2019, doi: DOI.C, venue: 'Journal of Synthetic Results', kind: 'journal' }),
      rec(5, { title: E, year: 2020, doi: DOI.E_ARXIV, venue: 'arXiv', kind: 'preprint' }),
    ],
    DBLP: [
      rec(1, { title: `${A}.`, year: 2021, doi: DOI.A, venue: 'J. Synth. Res.', kind: 'journal' }),
      rec(2, { title: `${B}.`, year: 2020, doi: null, venue: 'SynthConf', kind: 'conference' }),
      rec(3, { title: `${C}.`, year: 2019, doi: DOI.C, venue: 'J. Synth. Res.', kind: 'journal' }),
      rec(5, { title: `${E}.`, year: 2020, doi: DOI.E_ARXIV, venue: 'CoRR', kind: 'preprint' }),
    ],
    ORCID: [
      rec(1, { title: A.toUpperCase(), year: 2021, doi: DOI.A.toUpperCase(), venue: null, kind: 'journal' }),
      rec(2, { title: B, year: 2020, doi: null, venue: null, kind: 'conference' }),
      rec(3, { title: C, year: 2019, doi: DOI.C, venue: null, kind: 'journal' }),
      rec(4, { title: D, year: 2021, doi: DOI.A, venue: null, kind: 'journal' }),
    ],
    SCOPUS: [
      rec(1, { title: A, year: 2021, doi: DOI.A, venue: 'Journal of Synthetic Results', kind: 'journal', cites: cites.scopusA }),
      rec(2, { title: B, year: 2020, doi: DOI.B, venue: 'Synthetic Conference on Provenance', kind: 'conference', cites: 2 }),
      rec(3, { title: C, year: 2019, doi: null, venue: 'Journal of Synthetic Results', kind: 'other', cites: 1 }),
      rec(5, { title: E, year: 2021, doi: DOI.E, venue: 'Journal of Synthetic Results', kind: 'journal', cites: 4 }),
    ],
    WOS: [
      rec(1, { title: A.toUpperCase(), year: 2022, doi: DOI.A, venue: 'JOURNAL OF SYNTHETIC RESULTS', kind: 'journal', authors: ['Verma, A', 'Rao, S'], cites: cites.wosA }),
      rec(2, { title: B.toUpperCase(), year: 2020, doi: DOI.B, venue: 'SYNTHETIC CONFERENCE ON PROVENANCE', kind: 'conference', cites: 1 }),
      rec(3, { title: C.toUpperCase(), year: 2019, doi: DOI.C, venue: 'JOURNAL OF SYNTHETIC RESULTS', kind: 'journal', cites: 3 }),
      rec(5, { title: E.toUpperCase(), year: 2021, doi: DOI.E, venue: 'JOURNAL OF SYNTHETIC RESULTS', kind: 'journal', cites: 2 }),
    ],
  };
}

/* ── Helpers ──────────────────────────────────────────────────────────────── */

beforeEach(async () => {
  await resetDatabase();
});

afterAll(async () => {
  await resetDatabase();
  await prisma.$disconnect();
});

async function professorWithFiveIdentities() {
  const professor = await prisma.professor.create({ data: { name: 'Prof Five Providers' } });
  const identities = Object.fromEntries(
    await Promise.all(
      (Object.keys(IDS) as (keyof typeof IDS)[]).map(async (source) => [
        source,
        await prisma.externalIdentity.create({ data: { professorId: professor.id, source, externalId: IDS[source] } }),
      ]),
    ),
  ) as Record<keyof typeof IDS, { id: string }>;
  const user = await createUser({ email: 'manual.entry@example.test', role: 'ADMIN' });
  return { professor, identities, user };
}

async function syncRun(world: ProviderWorld, at: string, overrides = {}) {
  const sync = new SyncService({ clients: fiveProviderClients(world, overrides), now: testClock(at).now, providers: allProvidersPresent() });
  const started = await sync.start('MANUAL');
  await sync.idle();
  const run = await prisma.syncRun.findUniqueOrThrow({ where: { id: started.id }, include: { tasks: true } });
  return { sync, run };
}

/** The publication carrying a source record of this provider and external ID. */
async function publicationOf(source: 'OPENALEX' | 'DBLP' | 'ORCID' | 'SCOPUS' | 'WOS' | 'MANUAL', externalId: string) {
  const record = await prisma.publicationSourceRecord.findFirstOrThrow({ where: { source, externalId }, include: { publication: { include: { sourceRecords: true } } } });
  return record.publication;
}

const ext = {
  OPENALEX: (n: number) => `W9${String(n).padStart(9, '0')}`,
  DBLP: (kind: string, n: number) => `${kind === 'conference' ? 'conf/synth' : kind === 'preprint' ? 'journals/corr' : 'journals/synth'}/Verma${n}`,
  ORCID: (n: number) => `${IDS.ORCID}:${9_000_000 + n}`,
  SCOPUS: (n: number) => `2-s2.0-85000000${String(n).padStart(3, '0')}`,
  WOS: (n: number) => `WOS:00090000000${String(n).padStart(4, '0')}`,
};

/**
 * An order-independent description of the database: each publication by the sorted keys of its
 * source records with its canonical fields, and each duplicate candidate by the two publications'
 * record keys. Internal IDs, timestamps and match methods are left out.
 */
async function outcome(client: PrismaClient = prisma) {
  const publications = await client.publication.findMany({ include: { sourceRecords: { select: { source: true, externalId: true } } } });
  const keyOf = new Map(
    publications.map((p) => [p.id, p.sourceRecords.map((r) => `${r.source}:${r.source === 'MANUAL' ? 'manual' : r.externalId}`).sort().join(' + ')]),
  );
  const candidates = await client.duplicateCandidate.findMany();
  return {
    publications: publications
      .map((p) => ({ records: keyOf.get(p.id)!, title: p.title, year: p.year, venue: p.venue, typeFamily: p.typeFamily, doi: p.doi, authors: p.authorNamesDisplay }))
      .sort((a, b) => a.records.localeCompare(b.records)),
    candidates: candidates.map((c) => [keyOf.get(c.publicationAId!)!, keyOf.get(c.publicationBId!)!].sort().join('  <>  ')).sort(),
  };
}

/* ── 1. Cross-provider matching through the synchronization engine ───────── */

describe('five providers and a manual entry through one synchronization run', () => {
  it('maps each paper to one canonical publication, keeps every provider record, and flags only the uncertain cases', async () => {
    const { professor, user } = await professorWithFiveIdentities();
    // The professor entered paper A by hand before any synchronization (APPROVED, MANUAL origin).
    await addManualPublication(professor.id, user.id, { title: A, typeFamily: 'JOURNAL', doi: `https://doi.org/${DOI.A}`, year: 2021 }, new Date(T1));

    const { run } = await syncRun(papers(), T1);
    expect(run.tasks.map((t) => [t.source, t.status]).sort()).toEqual([
      ['DBLP', 'SUCCESS'],
      ['OPENALEX', 'SUCCESS'],
      ['ORCID', 'SUCCESS'],
      ['SCOPUS', 'SUCCESS'],
      ['WOS', 'SUCCESS'],
    ]);
    expect(run.status).toBe('SUCCESS'); // every provider, Scopus and WoS included, succeeded

    // Paper A: one publication with all six records, canonical metadata by §9 priority (OpenAlex first).
    const a = await publicationOf('OPENALEX', ext.OPENALEX(1));
    expect(a.sourceRecords.map((r) => r.source).sort()).toEqual(['DBLP', 'MANUAL', 'OPENALEX', 'ORCID', 'SCOPUS', 'WOS']);
    expect(a).toMatchObject({ title: A, year: 2021, venue: 'Journal of Synthetic Results', typeFamily: 'JOURNAL', doi: DOI.A, authorNamesDisplay: 'Asha Verma, Sunil Rao' });
    for (const r of a.sourceRecords.filter((r) => r.source !== 'MANUAL' && r.source !== 'OPENALEX')) expect(r.matchMethod, r.source).toBe('DOI');
    // Each provider keeps its own identifiers, values and provenance.
    const wosA = a.sourceRecords.find((r) => r.source === 'WOS')!;
    expect(wosA).toMatchObject({ externalId: ext.WOS(1), year: 2022, venue: 'JOURNAL OF SYNTHETIC RESULTS', authorNamesDisplay: 'Verma, A; Rao, S' });

    // Paper B: DBLP and ORCID (no DOI) attached by exact title + year to the same publication.
    const b = await publicationOf('OPENALEX', ext.OPENALEX(2));
    expect(b.sourceRecords.map((r) => r.source).sort()).toEqual(['DBLP', 'OPENALEX', 'ORCID', 'SCOPUS', 'WOS']);
    expect(b.sourceRecords.filter((r) => r.matchMethod === 'TITLE_YEAR').map((r) => r.source).sort()).toEqual(['DBLP', 'ORCID']);
    expect(b).toMatchObject({ typeFamily: 'CONFERENCE', doi: DOI.B });

    // Paper C: Scopus's untyped (OTHER), DOI-less record is a duplicate candidate, never merged.
    const c = await publicationOf('OPENALEX', ext.OPENALEX(3));
    const cScopus = await publicationOf('SCOPUS', ext.SCOPUS(3));
    expect(c.sourceRecords.map((r) => r.source).sort()).toEqual(['DBLP', 'OPENALEX', 'ORCID', 'WOS']);
    expect(cScopus.id).not.toBe(c.id);

    // Paper D (decision #22): paper A's DOI under an unrelated title is not merged.
    const d = await publicationOf('ORCID', ext.ORCID(4));
    expect(d.id).not.toBe(a.id);
    expect(d.doi).toBeNull(); // the DOI belongs canonically to paper A

    // Paper E: preprint (OpenAlex + DBLP) and published version (Scopus + WoS) stay apart.
    const ePre = await publicationOf('OPENALEX', ext.OPENALEX(5));
    const ePub = await publicationOf('SCOPUS', ext.SCOPUS(5));
    expect(ePre.sourceRecords.map((r) => r.source).sort()).toEqual(['DBLP', 'OPENALEX']);
    expect(ePub.sourceRecords.map((r) => r.source).sort()).toEqual(['SCOPUS', 'WOS']);
    expect([ePre.typeFamily, ePub.typeFamily]).toEqual(['PREPRINT', 'JOURNAL']);

    expect(await prisma.publication.count()).toBe(7);
    const pairs = (await prisma.duplicateCandidate.findMany()).map((x) => [x.publicationAId, x.publicationBId].sort().join());
    expect(pairs.sort()).toEqual([[c.id, cScopus.id], [a.id, d.id], [ePre.id, ePub.id]].map((p) => p.sort().join()).sort());

    // One relationship per publication for the professor; the manual entry stays APPROVED.
    const links = await prisma.professorPublication.findMany({ where: { professorId: professor.id } });
    expect(links).toHaveLength(7);
    expect(links.find((l) => l.publicationId === a.id)).toMatchObject({ status: 'APPROVED', origin: 'MANUAL' });
    expect(links.filter((l) => l.publicationId !== a.id).every((l) => l.status === 'PENDING' && l.origin === 'DISCOVERED')).toBe(true);
  });

  it('a later synchronization keeps every decision, adds nothing new, and appends citation observations per provider', async () => {
    const { professor } = await professorWithFiveIdentities();
    await syncRun(papers(), T1);
    const a = await publicationOf('OPENALEX', ext.OPENALEX(1));
    const b = await publicationOf('OPENALEX', ext.OPENALEX(2));
    const decidedAt = new Date('2026-11-15T00:00:00.000Z');
    await prisma.professorPublication.updateMany({ where: { professorId: professor.id, publicationId: a.id }, data: { status: 'APPROVED', decidedAt } });
    await prisma.professorPublication.updateMany({ where: { professorId: professor.id, publicationId: b.id }, data: { status: 'REJECTED', decidedAt } });
    const before = await outcome();

    const { run } = await syncRun(papers({ scopusA: 9, wosA: 6 }), T2);
    expect(run.status).toBe('SUCCESS');
    expect(run.tasks.reduce((sum, t) => sum + t.recordsNew + t.linksCreated + t.candidatesCreated, 0)).toBe(0);
    expect(await outcome()).toEqual(before); // same publications, canonical metadata and candidates

    const links = await prisma.professorPublication.findMany({ where: { professorId: professor.id } });
    expect(links.find((l) => l.publicationId === a.id)).toMatchObject({ status: 'APPROVED', decidedAt });
    expect(links.find((l) => l.publicationId === b.id)).toMatchObject({ status: 'REJECTED', decidedAt });

    const history = await prisma.citationObservation.findMany({
      where: { sourceRecord: { publicationId: a.id } },
      include: { sourceRecord: { select: { source: true } } },
      orderBy: [{ provider: 'asc' }, { observedAt: 'asc' }],
    });
    expect(history.map((o) => [o.provider, o.sourceRecord.source, o.count, o.observedAt.toISOString()])).toEqual([
      ['SCOPUS', 'SCOPUS', 7, T1],
      ['SCOPUS', 'SCOPUS', 9, T2],
      ['WOS', 'WOS', 5, T1],
      ['WOS', 'WOS', 6, T2],
    ]);
    // Four Scopus and four WoS records, two runs: no other observations exist.
    expect(await prisma.citationObservation.groupBy({ by: ['provider'], _count: true, orderBy: { provider: 'asc' } })).toEqual([
      { provider: 'SCOPUS', _count: 8 },
      { provider: 'WOS', _count: 8 },
    ]);
  });
});

/* ── 2. Discovery order ──────────────────────────────────────────────────── */

type Step = 'OPENALEX' | 'DBLP' | 'ORCID' | 'SCOPUS' | 'WOS' | 'MANUAL';
const STEPS: Step[] = ['OPENALEX', 'DBLP', 'ORCID', 'SCOPUS', 'WOS', 'MANUAL'];

/** Runs each provider's real discovery service (and the manual entry) in the given order. */
async function discoverInOrder(world: ProviderWorld, order: Step[]) {
  await resetDatabase();
  const { professor, identities, user } = await professorWithFiveIdentities();
  const clients = fiveProviderClients(world);
  const now = () => new Date(T1);
  for (const step of order) {
    if (step === 'OPENALEX') await discoverOpenAlexIdentity(identities.OPENALEX.id, { openAlex: clients.openAlex, now });
    if (step === 'DBLP') await discoverDblpIdentity(identities.DBLP.id, { dblp: clients.dblp, now });
    if (step === 'ORCID') await discoverOrcidIdentity(identities.ORCID.id, { orcid: clients.orcid, now });
    if (step === 'SCOPUS') await discoverScopusIdentity(identities.SCOPUS.id, { scopus: clients.scopus!, now });
    if (step === 'WOS') await discoverWosIdentity(identities.WOS.id, { wos: clients.wos!, now });
    if (step === 'MANUAL') await addManualPublication(professor.id, user.id, { title: A, typeFamily: 'JOURNAL', doi: DOI.A, year: 2021 }, new Date(T1));
  }
  return outcome();
}

function orders(): Step[][] {
  const rotations = STEPS.map((_, i) => [...STEPS.slice(i), ...STEPS.slice(0, i)]);
  return [...rotations, ...rotations.map((order) => [...order].reverse())];
}

describe('discovery order', () => {
  it('gives the same publications, canonical metadata and candidates in every tested order (12 orders)', async () => {
    // Papers A, B, C and E (the wrong-DOI ORCID work D is examined separately below).
    const world = papers();
    world.ORCID = world.ORCID!.filter((r) => r.n !== 4);
    const reference = await discoverInOrder(world, STEPS);
    expect(reference.publications).toHaveLength(6);
    expect(reference.candidates).toHaveLength(2);
    for (const order of orders().slice(1)) {
      expect(await discoverInOrder(world, order), order.join(' → ')).toEqual(reference);
    }
  });

  it('a wrong-DOI record discovered first no longer splits the genuine paper (decision #27 exception, #136), in any of 12 orders', async () => {
    // Paper A from four providers and the manual entry, and ORCID's unrelated work D carrying A's DOI.
    const world: ProviderWorld = {
      OPENALEX: [papers().OPENALEX![0]],
      DBLP: [papers().DBLP![0]],
      ORCID: [papers().ORCID![3]],
      SCOPUS: [papers().SCOPUS![0]],
      WOS: [papers().WOS![0]],
    };
    const paperA = `DBLP:${ext.DBLP('journal', 1)} + MANUAL:manual + OPENALEX:${ext.OPENALEX(1)} + SCOPUS:${ext.SCOPUS(1)} + WOS:${ext.WOS(1)}`;
    const recordD = `ORCID:${ext.ORCID(4)}`;
    let wrongFirstOrders = 0;
    for (const order of orders()) {
      const result = await discoverInOrder(world, order);
      const label = order.join(' → ');
      // One publication for the genuine paper and one for D, never merged (#22), one candidate between them.
      expect(result.publications.map((p) => p.records), label).toEqual([paperA, recordD]);
      expect(result.candidates, label).toEqual([`${paperA}  <>  ${recordD}`]);
      expect(result.publications[0], label).toMatchObject({ title: A, year: 2021, typeFamily: 'JOURNAL' });
      // Canonical DOIs stay unique (§9): the DOI stays with whichever publication claimed it first.
      const dFirst = order.indexOf('ORCID') < Math.min(...(['OPENALEX', 'DBLP', 'SCOPUS', 'WOS', 'MANUAL'] as Step[]).map((s) => order.indexOf(s)));
      if (dFirst) wrongFirstOrders++;
      expect([result.publications[0].doi, result.publications[1].doi], label).toEqual(dFirst ? [null, DOI.A] : [DOI.A, null]);
      // The professor sees the paper once (the manual entry's APPROVED link) and D once, PENDING.
      const links = await prisma.professorPublication.findMany({ select: { status: true, origin: true } });
      expect(links.map((l) => `${l.status}/${l.origin}`).sort(), label).toEqual(['APPROVED/MANUAL', 'PENDING/DISCOVERED']);
    }
    expect(wrongFirstOrders).toBeGreaterThanOrEqual(2); // the case that used to split the paper is exercised
  });

  it('documented order dependence: title + year is compared with the canonical year, which can move as sources arrive', async () => {
    const title = 'Year Drift Across Synthetic Providers';
    const world: ProviderWorld = {
      OPENALEX: [rec(7, { title, year: 2021, doi: '10.5555/xp.year', venue: 'J', kind: 'journal' })],
      DBLP: [rec(7, { title, year: 2023, doi: null, venue: 'J', kind: 'journal' })], // no DOI, two years after OpenAlex
      WOS: [rec(7, { title, year: 2022, doi: '10.5555/xp.year', venue: 'J', kind: 'journal' })],
    };
    // DBLP first: WoS (2022) matches it by title + year, OpenAlex then joins by DOI — one publication.
    const dblpFirst = await discoverInOrder(world, ['DBLP', 'WOS', 'OPENALEX']);
    expect(dblpFirst.publications).toHaveLength(1);
    expect(dblpFirst.publications[0].year).toBe(2021); // OpenAlex's year by §9 priority
    // DBLP last: the canonical year is already OpenAlex's 2021, two years from DBLP's 2023 — not merged, a candidate.
    const dblpLast = await discoverInOrder(world, ['OPENALEX', 'WOS', 'DBLP']);
    expect(dblpLast.publications).toHaveLength(2);
    expect(dblpLast.candidates).toHaveLength(1);
  });
});

/* ── 3. Citation observations ────────────────────────────────────────────── */

describe('citation observations', () => {
  it('a failed or incomplete Scopus/WoS fetch adds no observation; earlier observations and the other providers are unaffected', async () => {
    await professorWithFiveIdentities();
    await syncRun(papers(), T1);
    const before = await prisma.citationObservation.findMany({ orderBy: { id: 'asc' } });

    // Scopus reports five documents but its second page is empty (incomplete); WoS fails with a server error.
    const world = papers({ scopusA: 50, wosA: 50 });
    const scopusEntries = world.SCOPUS!.map((r) => scopusFixtures.scopusEntry(r.n, { 'dc:title': r.title, 'citedby-count': '50' }));
    const page = (start: number, entries: Record<string, unknown>[]) => () =>
      new Response(JSON.stringify(scopusFixtures.searchPage(IDS.SCOPUS, start, 200, 5, entries).body), { status: 200, headers: { 'content-type': 'application/json' } });
    const overrides = {
      [scopusFixtures.searchUrl(IDS.SCOPUS, 0, 200)]: page(0, scopusEntries),
      [scopusFixtures.searchUrl(IDS.SCOPUS, 4, 200)]: page(4, []),
      [wosFixtures.searchUrl(IDS.WOS, 1, 50)]: wosFixtures.status(500),
    };
    const { run } = await syncRun(world, T2, overrides);
    expect(Object.fromEntries(run.tasks.map((t) => [t.source, t.status]))).toEqual({ OPENALEX: 'SUCCESS', DBLP: 'SUCCESS', ORCID: 'SUCCESS', SCOPUS: 'FAILED', WOS: 'FAILED' });
    expect(run.tasks.find((t) => t.source === 'SCOPUS')!.errorMessage).toMatch(/^INCOMPLETE: /);
    expect(run.status).toBe('PARTIAL_SUCCESS');
    expect(await prisma.citationObservation.findMany({ orderBy: { id: 'asc' } })).toEqual(before);
    expect(await prisma.citationObservation.count({ where: { count: 50 } })).toBe(0);
  });

  it('counts never become canonical metadata and are not returned by the publication API', async () => {
    await professorWithFiveIdentities();
    await syncRun(papers(), T1);
    const a = await publicationOf('OPENALEX', ext.OPENALEX(1));
    const canonicalBefore = await prisma.publication.findUniqueOrThrow({ where: { id: a.id } });
    await syncRun(papers({ scopusA: 1234, wosA: 4321 }), T2);
    const canonicalAfter = await prisma.publication.findUniqueOrThrow({ where: { id: a.id } });

    const fields = (p: typeof canonicalBefore) => ({ title: p.title, year: p.year, venue: p.venue, typeFamily: p.typeFamily, doi: p.doi, authors: p.authorNamesDisplay, status: p.status });
    expect(fields(canonicalAfter)).toEqual(fields(canonicalBefore));
    expect(Object.keys(canonicalAfter).some((key) => /cit/i.test(key))).toBe(false);

    const server = createApp({ mailer: null });
    const detail = await request(server).get(`/api/admin/publications/${a.id}`).set('Cookie', await adminCookie(server));
    expect(detail.status).toBe(200);
    const body = JSON.stringify(detail.body);
    expect(body).not.toMatch(/citedby|citations|Times Cited|1234|4321/i);
    expect(detail.body.publication.sourceRecords.map((r: { source: string }) => r.source).sort()).toEqual(['DBLP', 'OPENALEX', 'ORCID', 'SCOPUS', 'WOS']);
  });

  it('observations follow their source record through an administrator merge and detach, and are removed only with it', async () => {
    const { user } = await professorWithFiveIdentities();
    await syncRun(papers(), T1);
    const sync = new SyncService({ clients: fiveProviderClients({}), now: testClock(T2).now, providers: allProvidersPresent() });

    // Merge: Scopus's OTHER record of paper C (a candidate) into the main publication of C.
    const c = await publicationOf('OPENALEX', ext.OPENALEX(3));
    const scopusC = await prisma.publicationSourceRecord.findFirstOrThrow({ where: { source: 'SCOPUS', externalId: ext.SCOPUS(3) } });
    const scopusCObservations = await prisma.citationObservation.findMany({ where: { sourceRecordId: scopusC.id } });
    const candidate = await prisma.duplicateCandidate.findFirstOrThrow({ where: { OR: [{ publicationAId: scopusC.publicationId }, { publicationBId: scopusC.publicationId }] } });
    await mergeCandidate(candidate.id, c.id, user.id, { sync, now: () => new Date(T2) });
    expect(await prisma.publicationSourceRecord.findUniqueOrThrow({ where: { id: scopusC.id } })).toMatchObject({ publicationId: c.id });
    expect(await prisma.citationObservation.findMany({ where: { sourceRecordId: scopusC.id } })).toEqual(scopusCObservations);
    expect(await prisma.citationObservation.count({ where: { sourceRecord: { publicationId: c.id } } })).toBe(2); // Scopus 1 + WoS 1, kept apart
    expect(await prisma.citationObservation.findMany({ where: { sourceRecord: { publicationId: c.id } }, select: { provider: true, count: true }, orderBy: { provider: 'asc' } })).toEqual([
      { provider: 'SCOPUS', count: 1 },
      { provider: 'WOS', count: 3 },
    ]);

    // Detach: WoS's record of paper A moves to its own publication with its observations.
    const wosA = await prisma.publicationSourceRecord.findFirstOrThrow({ where: { source: 'WOS', externalId: ext.WOS(1) } });
    const wosAObservations = await prisma.citationObservation.findMany({ where: { sourceRecordId: wosA.id } });
    await detachSourceRecord(wosA.id, { sync });
    const moved = await prisma.publicationSourceRecord.findUniqueOrThrow({ where: { id: wosA.id } });
    expect(moved.publicationId).not.toBe(wosA.publicationId);
    expect(await prisma.citationObservation.findMany({ where: { sourceRecordId: wosA.id } })).toEqual(wosAObservations);

    // Deleting a source record (as the stage 15.8 removal tool will) removes its observations only.
    const scopusA = await prisma.publicationSourceRecord.findFirstOrThrow({ where: { source: 'SCOPUS', externalId: ext.SCOPUS(1) } });
    const total = await prisma.citationObservation.count();
    await prisma.publicationSourceRecord.delete({ where: { id: scopusA.id } });
    expect(await prisma.citationObservation.count({ where: { sourceRecordId: scopusA.id } })).toBe(0);
    expect(await prisma.citationObservation.count()).toBe(total - 1);
    expect(await prisma.citationObservation.count({ where: { sourceRecordId: wosA.id } })).toBe(1);

    // Deleting a synchronization run keeps its observations (the task reference becomes NULL).
    const runs = await prisma.syncRun.findMany();
    await prisma.syncRun.deleteMany({ where: { id: { in: runs.map((r) => r.id) } } });
    expect(await prisma.citationObservation.count()).toBe(total - 1);
    expect(await prisma.citationObservation.count({ where: { syncTaskId: { not: null } } })).toBe(0);
  });
});
