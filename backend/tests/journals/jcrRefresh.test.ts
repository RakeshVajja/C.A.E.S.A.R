import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '../../src/config/database';
import { FetchError } from '../../src/integrations/http/httpClient';
import { backfillSourceRecordIssns, identifyJournals, linkPublications, refreshJournal } from '../../src/services/journals/jcrRefresh';
import { resetDatabase } from '../helpers/database';
import * as jcr from '../fixtures/jcr/synthetic';
import { ISSN, jcrClient, jcrResponses, journalOf, journalTask, publication, publications } from './jcrWorld';

/* Journal identification, linking and snapshots (stage 15.6) — synthetic JCR responses, isolated test database. */

const RETRIEVED = new Date('2026-11-15T03:00:00.000Z');
const DATA_DATE = new Date('2026-06-18T00:00:00.000Z');

beforeEach(async () => {
  await resetDatabase();
});

afterAll(async () => {
  await resetDatabase();
  await prisma.$disconnect();
});

async function identifiedWorld() {
  const pubs = await publications();
  const { client } = jcrClient();
  await identifyJournals(prisma, client);
  await linkPublications(prisma);
  const a = await prisma.journal.findUniqueOrThrow({ where: { jcrId: 'SYNTH_A' } });
  return { ...pubs, a };
}

describe('source-record ISSNs', () => {
  it('new records store their normalized ISSNs; records stored before stage 15.6 are filled from raw_metadata, once', async () => {
    const fresh = await publication('SCOPUS', '2-s2.0-9', { title: 'Synthetic fresh record', issns: ['99990016', 'bad'] });
    expect((await prisma.publicationSourceRecord.findUniqueOrThrow({ where: { id: fresh.sourceRecordId } })).issns).toEqual([ISSN.A_PRINT]);

    // Older records: ISSNs only inside raw_metadata (issns empty), in each provider's own shape.
    const old = [
      await publication('OPENALEX', 'W90', { title: 'Old OpenAlex record', rawMetadata: { primary_location: { source: { issn: [ISSN.A_ONLINE], issn_l: ISSN.A_ONLINE } } } }),
      await publication('ORCID', 'x:91', { title: 'Old ORCID record', rawMetadata: { 'external-ids': { 'external-id': [{ 'external-id-type': 'issn', 'external-id-value': ISSN.B_PRINT, 'external-id-relationship': 'part-of' }] } } }),
      await publication('WOS', 'WOS:000000000000092', { title: 'Old WoS record', rawMetadata: { identifiers: { issn: ISSN.C_PRINT, eissn: '1234-5678' } } }),
      await publication('DBLP', 'journals/x/Old', { title: 'Old DBLP record', rawMetadata: { issn: ISSN.D_PRINT } }), // DBLP has no ISSN field
      await publication('OPENALEX', 'W93', { title: 'Old record without ISSN', rawMetadata: { primary_location: null } }),
    ];
    expect(await backfillSourceRecordIssns(prisma, 2)).toBe(3);
    const issnsOf = async (id: string) => (await prisma.publicationSourceRecord.findUniqueOrThrow({ where: { id } })).issns;
    expect(await Promise.all(old.map((r) => issnsOf(r.sourceRecordId)))).toEqual([[ISSN.A_ONLINE], [ISSN.B_PRINT], [ISSN.C_PRINT], [], []]);
    expect(await issnsOf(fresh.sourceRecordId)).toEqual([ISSN.A_PRINT]); // untouched
    expect(await backfillSourceRecordIssns(prisma)).toBe(0); // idempotent
  });
});

describe('journal identification', () => {
  it('finds each journal by ISSN, keeps only hits whose own ISSNs include the searched one, and stores ISSN kinds and years', async () => {
    await publications();
    const { client, calls } = jcrClient();
    const result = await identifyJournals(prisma, client);

    expect(result).toEqual({ issnsSearched: 5, issnsWithoutJournal: 2, journalsAdded: 3, journalsUpdated: 0, failures: 0 });
    // A's electronic ISSN and the shared ISSN were covered by profiles found earlier: not searched.
    expect(calls.filter((c) => c.url.includes('/journals?q=')).map((c) => new URL(c.url).searchParams.get('q'))).toEqual([
      ISSN.A_PRINT, ISSN.B_PRINT, ISSN.C_PRINT, ISSN.NOT_IN_JCR, ISSN.D_PRINT,
    ]);
    // SYNTH_A's profile is fetched once, although its ISSN search and the false hit both return it.
    expect(calls.filter((c) => c.url.endsWith('/journals/SYNTH_A'))).toHaveLength(1);

    const journals = await prisma.journal.findMany({ include: { issns: { orderBy: { issn: 'asc' } } }, orderBy: { jcrId: 'asc' } });
    expect(journals.map((j) => [j.jcrId, j.name, j.publisherName])).toEqual([
      ['SYNTH_A', 'Synthetic Journal A', 'SYNTHETIC PUBLISHER LTD'],
      ['SYNTH_B', 'Synthetic Journal B', 'SYNTHETIC PUBLISHER LTD'],
      ['SYNTH_C', 'Synthetic Journal C', 'SYNTHETIC PUBLISHER LTD'],
    ]);
    expect(journals[0].issns.map((i) => [i.issn, i.kind, i.validFromYear, i.validToYear])).toEqual([
      [ISSN.A_PRINT, 'PRINT', 2005, 2022],
      [ISSN.A_ONLINE, 'ELECTRONIC', null, null],
      [ISSN.A_PREVIOUS, 'PREVIOUS', 2001, 2004],
    ]);
    expect(journals.flatMap((j) => j.issns.filter((i) => i.issn === ISSN.SHARED).map(() => j.jcrId))).toEqual(['SYNTH_B', 'SYNTH_C']);
  });

  it('a later identification searches only ISSNs no journal has (unknown ones are retried)', async () => {
    await publications();
    await identifyJournals(prisma, jcrClient().client);
    const { client, calls } = jcrClient();
    expect(await identifyJournals(prisma, client)).toMatchObject({ issnsSearched: 2, journalsAdded: 0, issnsWithoutJournal: 2 });
    expect(calls.filter((c) => c.url.includes('/journals?q=')).map((c) => new URL(c.url).searchParams.get('q'))).toEqual([ISSN.NOT_IN_JCR, ISSN.D_PRINT]);
  });

  it('a failing ISSN is counted and the others continue; an access failure stops the step', async () => {
    await publications();
    const { client } = jcrClient(jcrResponses(), { [jcr.searchUrl(ISSN.B_PRINT)]: jcr.status(500) });
    // B's own search fails, but B is still found through the shared ISSN (which C also carries).
    expect(await identifyJournals(prisma, client)).toMatchObject({ failures: 1, journalsAdded: 3 });
    await resetDatabase();
    await publications();
    const denied = jcrClient([], { [jcr.searchUrl(ISSN.A_PRINT)]: jcr.status(401) });
    await expect(identifyJournals(prisma, denied.client)).rejects.toMatchObject({ kind: 'AUTH_FAILED' });
    expect(denied.calls).toHaveLength(1);
    expect(await prisma.journal.count()).toBe(0);
  });
});

describe('publication ↔ journal links (D10)', () => {
  it('links a publication only when its ISSNs identify exactly one journal', async () => {
    const { p1, p2, p3, p4, p5, p6, p7 } = await publications();
    await identifyJournals(prisma, jcrClient().client);
    expect(await linkPublications(prisma)).toEqual({ changed: 2, linked: 2, ambiguous: 2 });
    expect((await journalOf(p1.publicationId))?.jcrId).toBe('SYNTH_A'); // print ISSN
    expect((await journalOf(p2.publicationId))?.jcrId).toBe('SYNTH_A'); // electronic ISSN
    for (const p of [p3, p4, p5, p6, p7]) expect(await journalOf(p.publicationId)).toBeNull(); // ambiguous, unknown or no ISSN
    expect(await linkPublications(prisma)).toEqual({ changed: 0, linked: 2, ambiguous: 2 }); // idempotent
  });

  it('links follow the journals’ ISSNs: an ambiguity resolved by a profile refresh links, a new ambiguity unlinks', async () => {
    const { p3, p1, a } = await identifiedWorld();
    // C no longer lists the shared ISSN: p3 now identifies only B.
    const c = await prisma.journal.findUniqueOrThrow({ where: { jcrId: 'SYNTH_C' } });
    await prisma.journalIssn.deleteMany({ where: { journalId: c.id, issn: ISSN.SHARED } });
    // B claims A's print ISSN as a previous one: p1 becomes ambiguous.
    const b = await prisma.journal.findUniqueOrThrow({ where: { jcrId: 'SYNTH_B' } });
    await prisma.journalIssn.create({ data: { journalId: b.id, issn: ISSN.A_PRINT, kind: 'PREVIOUS' } });
    expect(await linkPublications(prisma)).toMatchObject({ changed: 2 });
    expect((await journalOf(p3.publicationId))?.jcrId).toBe('SYNTH_B');
    expect(await journalOf(p1.publicationId)).toBeNull();
    expect(a.jcrId).toBe('SYNTH_A');
  });
});

describe('snapshots (D16)', () => {
  it('adds revision 1 for the JCR years of its publications plus the latest available year, with category metrics', async () => {
    const { a } = await identifiedWorld();
    const taskId = await journalTask(a.id);
    const { client, calls } = jcrClient();
    const result = await refreshJournal(prisma, client, a.id, { syncTaskId: taskId, retrievedAt: RETRIEVED, jcrDataUpdate: DATA_DATE });

    // Publications of 2020 and 2021, plus 2022 (latest); 2019 is available but irrelevant.
    expect(result).toEqual({ reportsFetched: 3, snapshotsAdded: 3, warnings: [] });
    expect(calls.filter((c) => c.url.includes('/reports/')).map((c) => c.url.split('/').pop())).toEqual(['2020', '2021', '2022']);
    const snapshots = await prisma.journalMetricSnapshot.findMany({ where: { journalId: a.id }, include: { categoryMetrics: { orderBy: [{ metric: 'asc' }, { categoryName: 'asc' }] } }, orderBy: { jcrYear: 'asc' } });
    expect(snapshots.map((s) => [s.jcrYear, s.revision])).toEqual([[2020, 1], [2021, 1], [2022, 1]]);
    expect(snapshots[1]).toMatchObject({
      jcrDataUpdate: DATA_DATE,
      retrievedAt: RETRIEVED,
      syncTaskId: taskId,
      totalCites: 3221,
      jifText: '2.345',
      jifValue: 2.345,
      jifWithoutSelfText: '2.100',
      jifWithoutSelfValue: 2.1,
      jif5Years: 2.9,
      immediacyIndex: 0.4,
      jci: 1.1,
      averageJifPercentile: 71.5,
      suppressed: false,
      onHold: false,
      delisted: false,
    });
    expect(snapshots[1].payloadHash).toMatch(/^[0-9a-f]{64}$/);
    // (PostgreSQL orders the jcr_rank_metric enum by declaration: JIF, then JCI.)
    expect(snapshots[1].categoryMetrics.map((m) => [m.metric, m.categoryName, m.categoryCode, m.edition, m.rank, m.rankTotal, m.quartile, m.percentile])).toEqual([
      ['JIF', 'SYNTHETIC SCIENCE, APPLIED', 'ZZ_SCIE', 'SCIE', 12, 120, 'Q1', 90.4],
      ['JIF', 'SYNTHETIC SOCIAL STUDIES', 'ZY_SSCI', 'SSCI', 40, 80, 'Q2', 50.6],
      ['JCI', 'SYNTHETIC SCIENCE, APPLIED', null, '', 15, 130, 'Q1', 88.8],
    ]);
    // Metrics are stored on the snapshots only; publications are untouched by metrics.
    expect(Object.keys(await prisma.publication.findFirstOrThrow()).some((key) => /jif|jci|quartile/i.test(key))).toBe(false);
  });

  it('D9: year P only when listed (never a substitute year), plus the latest listed year, each requested once', async () => {
    // Journal A lists 2019–2022. Publications of 2018 (not listed), 2022 (= latest) and 2021 join p1/p2 (2021, 2020).
    await publications();
    await publication('WOS', 'WOS:000000000000018', { title: 'Synthetic 2018 paper in journal A', year: 2018, issns: [ISSN.A_PRINT] });
    await publication('WOS', 'WOS:000000000000022', { title: 'Synthetic 2022 paper in journal A', year: 2022, issns: [ISSN.A_PRINT] });
    await publication('WOS', 'WOS:000000000000021', { title: 'Another synthetic 2021 paper in journal A', year: 2021, issns: [ISSN.A_ONLINE] });
    await identifyJournals(prisma, jcrClient().client);
    await linkPublications(prisma);
    const a = await prisma.journal.findUniqueOrThrow({ where: { jcrId: 'SYNTH_A' } });

    const { client, calls } = jcrClient();
    await refreshJournal(prisma, client, a.id, { syncTaskId: await journalTask(a.id), retrievedAt: RETRIEVED, jcrDataUpdate: null });
    // 2018 is not listed and is not replaced by 2017 or 2019; 2022 is both a publication year and the latest.
    expect(calls.filter((c) => c.url.includes('/reports/')).map((c) => Number(c.url.split('/').pop()))).toEqual([2020, 2021, 2022]);
  });

  it('an unchanged report adds nothing; a corrected one adds the next revision and keeps the earlier one', async () => {
    const { a } = await identifiedWorld();
    await refreshJournal(prisma, jcrClient().client, a.id, { syncTaskId: await journalTask(a.id), retrievedAt: RETRIEVED, jcrDataUpdate: DATA_DATE });
    const first = await prisma.journalMetricSnapshot.findMany({ orderBy: [{ jcrYear: 'asc' }] });

    expect((await refreshJournal(prisma, jcrClient().client, a.id, { syncTaskId: await journalTask(a.id), retrievedAt: new Date('2026-12-15T03:00:00.000Z'), jcrDataUpdate: DATA_DATE })).snapshotsAdded).toBe(0);
    const corrected = jcrClient(jcrResponses({ a2021Jif: '2.400' })).client;
    const later = new Date('2027-01-15T03:00:00.000Z');
    expect((await refreshJournal(prisma, corrected, a.id, { syncTaskId: await journalTask(a.id), retrievedAt: later, jcrDataUpdate: new Date('2026-12-20T00:00:00.000Z') })).snapshotsAdded).toBe(1);

    const y2021 = await prisma.journalMetricSnapshot.findMany({ where: { jcrYear: 2021 }, orderBy: { revision: 'asc' } });
    expect(y2021.map((s) => [s.revision, s.jifText, s.retrievedAt.toISOString()])).toEqual([
      [1, '2.345', RETRIEVED.toISOString()],
      [2, '2.400', later.toISOString()],
    ]);
    expect(y2021[1].payloadHash).not.toBe(y2021[0].payloadHash);
    // Revision 1 is exactly as it was.
    expect(await prisma.journalMetricSnapshot.findUniqueOrThrow({ where: { id: first[1].id } })).toEqual(first[1]);
  });

  it('an unavailable report (404: not found or suppressed) is a warning; a failure on a later year writes nothing at all', async () => {
    const { a } = await identifiedWorld();
    const missing = jcrClient(jcrResponses(), { [jcr.reportUrl('SYNTH_A', 2020)]: jcr.status(404, { error: { status: 404, title: 'Suppressed Title' } }) });
    const result = await refreshJournal(prisma, missing.client, a.id, { syncTaskId: await journalTask(a.id), retrievedAt: RETRIEVED, jcrDataUpdate: null });
    expect(result).toEqual({
      reportsFetched: 2,
      snapshotsAdded: 2,
      warnings: ['JCR 2020 report for journal SYNTH_A unavailable (HTTP 404: not found or suppressed, not distinguishable); earlier snapshots unchanged'],
    });
    expect(await prisma.journalMetricSnapshot.count({ where: { jcrDataUpdate: null } })).toBe(2);

    await resetDatabase();
    const world = await identifiedWorld();
    const before = await prisma.journal.findUniqueOrThrow({ where: { id: world.a.id }, include: { issns: true } });
    const broken = jcrClient(jcrResponses(), {
      [jcr.journalUrl('SYNTH_A')]: jcr.status(200, jcr.journalRecord({ id: 'SYNTH_A', name: 'Renamed Journal A', issn: ISSN.A_PRINT, reportYears: [2020, 2021, 2022] }).body),
      [jcr.reportUrl('SYNTH_A', 2022)]: jcr.status(500),
    });
    await expect(refreshJournal(prisma, broken.client, world.a.id, { syncTaskId: await journalTask(world.a.id), retrievedAt: RETRIEVED, jcrDataUpdate: null })).rejects.toBeInstanceOf(FetchError);
    expect(await prisma.journalMetricSnapshot.count()).toBe(0); // 2020 and 2021 were fetched but not written
    expect(await prisma.journal.findUniqueOrThrow({ where: { id: world.a.id }, include: { issns: true } })).toEqual(before); // profile unchanged
  });

  it('a year that later answers 404 keeps its stored snapshots exactly: unavailability is never treated as absence', async () => {
    const { a } = await identifiedWorld();
    await refreshJournal(prisma, jcrClient().client, a.id, { syncTaskId: await journalTask(a.id), retrievedAt: RETRIEVED, jcrDataUpdate: DATA_DATE });
    const stored = await prisma.journalMetricSnapshot.findMany({ include: { categoryMetrics: true }, orderBy: { jcrYear: 'asc' } });

    // Every year now answers 404 (e.g. the title became suppressed): nothing is added, removed or changed.
    const unavailable = Object.fromEntries([2020, 2021, 2022].map((year) => [jcr.reportUrl('SYNTH_A', year), jcr.status(404, { error: { status: 404, title: 'Suppressed Title' } })]));
    const result = await refreshJournal(prisma, jcrClient(jcrResponses(), unavailable).client, a.id, { syncTaskId: await journalTask(a.id), retrievedAt: new Date('2027-01-15T03:00:00.000Z'), jcrDataUpdate: null });
    expect(result).toMatchObject({ reportsFetched: 0, snapshotsAdded: 0 });
    expect(result.warnings).toHaveLength(3);
    expect(await prisma.journalMetricSnapshot.findMany({ include: { categoryMetrics: true }, orderBy: { jcrYear: 'asc' } })).toEqual(stored);
    // The journal and its links stay too.
    expect(await prisma.journal.count({ where: { id: a.id } })).toBe(1);
    expect(await prisma.publication.count({ where: { journalId: a.id } })).toBe(2);
  });

  it('unfamiliar editions are stored as returned and counted as warnings; an invalid report fails without writing', async () => {
    const { a } = await identifiedWorld();
    const ranks = { jif: [{ category: 'SYNTHETIC SCIENCE', edition: 'NEWEDITION', rank: '1/10', quartile: 'Q1' }], jci: [] };
    const overrides = { [jcr.reportUrl('SYNTH_A', 2021)]: jcr.status(200, jcr.report('SYNTH_A', 2021, { ranks }).body) };
    const result = await refreshJournal(prisma, jcrClient(jcrResponses(), overrides).client, a.id, { syncTaskId: await journalTask(a.id), retrievedAt: RETRIEVED, jcrDataUpdate: null });
    expect(result.warnings).toEqual(['Unfamiliar JCR edition "NEWEDITION" for JIF category SYNTHETIC SCIENCE; stored as returned']);
    expect(await prisma.journalCategoryMetric.findMany({ where: { snapshot: { jcrYear: 2021 } }, select: { edition: true } })).toEqual([{ edition: 'NEWEDITION' }]);

    await resetDatabase();
    const world = await identifiedWorld();
    const conflicting = { jif: [{ category: 'X SCIENCE', edition: 'SCIE', rank: '1/10' }, { category: 'X SCIENCE', edition: 'SCIE', rank: '2/10' }] };
    const invalid = { [jcr.reportUrl('SYNTH_A', 2022)]: jcr.status(200, jcr.report('SYNTH_A', 2022, { ranks: conflicting }).body) };
    await expect(refreshJournal(prisma, jcrClient(jcrResponses(), invalid).client, world.a.id, { syncTaskId: await journalTask(world.a.id), retrievedAt: RETRIEVED, jcrDataUpdate: null })).rejects.toMatchObject({ kind: 'INVALID_RESPONSE' });
    expect(await prisma.journalMetricSnapshot.count()).toBe(0);
  });
});
