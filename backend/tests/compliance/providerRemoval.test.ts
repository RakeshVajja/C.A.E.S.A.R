import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '../../src/config/database';
import {
  executeProviderRemoval,
  planProviderRemoval,
  RemovableProvider,
  RemovalExclusions,
} from '../../src/services/compliance/providerRemoval';
import { addManualPublication } from '../../src/services/manual/manualPublications';
import { CuratedField } from '../../src/services/publications/curation';
import { ingestPublication } from '../../src/services/matching/engine';
import { buildNormalizedPublication, PublicationInput } from '../../src/services/normalization/normalizedPublication';
import { createUser } from '../auth/helpers';
import { resetDatabase } from '../helpers/database';

/*
 * Provider-data removal (stage 15.8; Project_plan.md §13.10, §22.4, §22.8; decisions #124, #125).
 * Synthetic records only, in the isolated test database; no provider request is made.
 */

const NOW = '2026-11-03T10:00:00.000Z';
const T0 = new Date('2026-10-01T00:00:00.000Z');
const options = { client: prisma, now: () => new Date(NOW) };
const NONE: RemovalExclusions = { curation: [], manualRecords: [] };
/** Text that only provider records carry: a report must never contain it. */
const PROVIDER_TEXT = 'SYNTHETIC-PROVIDER-CONTENT';

beforeEach(async () => {
  await resetDatabase();
});

afterAll(async () => {
  await resetDatabase();
  await prisma.$disconnect();
});

const ingest = (input: Omit<PublicationInput, 'typeFamily'> & { typeFamily?: PublicationInput['typeFamily'] }) =>
  ingestPublication(buildNormalizedPublication({ typeFamily: 'JOURNAL', ...input }), { seenAt: T0 });

/** A provider record whose metadata (title, venue, raw payload) is provider content. */
const providerRecord = (source: 'SCOPUS' | 'WOS', externalId: string, title: string, extra: Partial<PublicationInput> = {}) =>
  ingest({ source, externalId, title, rawMetadata: { note: `${PROVIDER_TEXT} ${source}` }, ...extra });

const curate = (id: string, curation: object) => prisma.publication.update({ where: { id }, data: { curation, isCurated: true } });
const publication = (id: string) => prisma.publication.findUnique({ where: { id } });

/** Every row of every table, for "nothing changed" checks. */
async function state() {
  const order = { orderBy: { id: 'asc' as const } };
  return {
    publications: await prisma.publication.findMany(order),
    records: await prisma.publicationSourceRecord.findMany(order),
    relationships: await prisma.professorPublication.findMany(order),
    candidates: await prisma.duplicateCandidate.findMany(order),
    observations: await prisma.citationObservation.findMany(order),
    journals: await prisma.journal.findMany(order),
    issns: await prisma.journalIssn.findMany(order),
    snapshots: await prisma.journalMetricSnapshot.findMany(order),
    metrics: await prisma.journalCategoryMetric.findMany(order),
    tasks: await prisma.syncTask.findMany(order),
    identities: await prisma.externalIdentity.findMany(order),
  };
}

async function approveAndExecute(provider: RemovableProvider, exclusions: RemovalExclusions = NONE) {
  const plan = await planProviderRemoval(provider, exclusions, options);
  return { plan, executed: await executeProviderRemoval(provider, exclusions, plan.fingerprint, options) };
}

/**
 * A world with Web of Science data:
 *   S  supported by OpenAlex, DBLP, ORCID, Scopus, an independent manual entry and WoS; curated venue
 *      derived from WoS, curated year INDEPENDENT with evidence, curated type PRE_PHASE15;
 *      APPROVED (professor A) and REJECTED (professor B) relationships
 *   U  WoS only (DOI 10.5555/u); APPROVED and PENDING relationships; candidate with S
 *   Y  OpenAlex record carrying U's DOI under an unrelated title (refused by #22): separate, no DOI
 *   C  WoS only, title curated INDEPENDENT with evidence
 *   M  WoS, then a manual re-entry by professor A (INDEPENDENT, DOI evidence)
 *   D  WoS and a manual entry declared as derived from WoS
 *   E  OpenAlex and WoS, title curated INDEPENDENT (to be excluded by the administrator)
 *   X  OpenAlex only, unaffected (its curated value has no evidence and stays untouched)
 */
async function wosWorld() {
  const userA = await createUser({ email: 'a@example.org', professor: 'active' });
  const userB = await createUser({ email: 'b@example.org', professor: 'active' });
  const profA = await prisma.professor.findUniqueOrThrow({ where: { userId: userA.id } });
  const profB = await prisma.professor.findUniqueOrThrow({ where: { userId: userB.id } });
  const wosIdentity = await prisma.externalIdentity.create({ data: { professorId: profA.id, source: 'WOS', externalId: 'ZZZ-0001-2020' } });

  const doiS = '10.5555/s';
  const s = (await ingest({ source: 'OPENALEX', externalId: 'W100', title: 'Shared paper', year: 2021, dois: [doiS] })).publicationId;
  await ingest({ source: 'DBLP', externalId: 'journals/x/S', title: 'Shared paper', year: 2021, venue: 'DBLP Venue', dois: [doiS] });
  await ingest({ source: 'ORCID', externalId: '0000-0001:1', title: 'Shared paper', year: 2021, dois: [doiS] });
  const scopusS = await providerRecord('SCOPUS', '2-s2.0-100', 'Shared paper', { year: 2021, dois: [doiS], authorNamesDisplay: null });
  const wosS = await providerRecord('WOS', 'WOS:000000000000001', 'Shared paper', { year: 2021, dois: [doiS], venue: 'WOS VENUE', authorNamesDisplay: 'Verma, A' });
  await addManualPublication(profA.id, userA.id, { title: 'Shared paper', typeFamily: 'JOURNAL', doi: doiS, year: 2021, authorNames: 'A. Verma', basis: 'INDEPENDENT', evidence: 'https://publisher.example.org/s' }, T0);
  await prisma.professorPublication.create({ data: { professorId: profB.id, publicationId: s, status: 'REJECTED', origin: 'DISCOVERED', decidedAt: T0, decidedByUserId: userB.id } });
  await prisma.publication.update({ where: { id: s }, data: { venue: 'WOS VENUE', year: 2020, typeFamily: 'CONFERENCE' } });
  await curate(s, {
    venue: { basis: 'WOS' },
    year: { basis: 'INDEPENDENT', evidence: 'https://publisher.example.org/s' },
    type_family: { basis: 'PRE_PHASE15' },
  });
  await prisma.citationObservation.create({ data: { sourceRecordId: wosS.sourceRecordId, provider: 'WOS', database: 'WOS', count: 7, observedAt: T0 } });
  const scopusObservation = await prisma.citationObservation.create({ data: { sourceRecordId: scopusS.sourceRecordId, provider: 'SCOPUS', count: 9, observedAt: T0 } });

  const u = (await providerRecord('WOS', 'WOS:000000000000002', 'Only in web of science', { year: 2019, dois: ['10.5555/u'] })).publicationId;
  const relUA = await prisma.professorPublication.create({ data: { professorId: profA.id, publicationId: u, status: 'APPROVED', origin: 'DISCOVERED', discoveredViaIdentityId: wosIdentity.id, decidedAt: T0, decidedByUserId: userA.id } });
  const relUB = await prisma.professorPublication.create({ data: { professorId: profB.id, publicationId: u, status: 'PENDING', origin: 'DISCOVERED' } });
  const candidateUS = await prisma.duplicateCandidate.create({ data: { publicationAId: u < s ? u : s, publicationBId: u < s ? s : u, reason: 'Source record WOS:WOS:000000000000002 reports a DOI that belongs to another publication' } });

  const y = (await ingest({ source: 'OPENALEX', externalId: 'W200', title: 'An entirely unrelated study of graphs', year: 2019, dois: ['10.5555/u'] })).publicationId;

  const c = (await providerRecord('WOS', 'WOS:000000000000003', 'Curated only paper', { year: 2018, venue: 'WOS VENUE C', dois: ['10.5555/c'] })).publicationId;
  await prisma.publication.update({ where: { id: c }, data: { title: 'Curated only paper (independent)', normalizedTitle: 'curated only paper independent' } });
  await curate(c, { title: { basis: 'INDEPENDENT', evidence: 'https://repository.example.org/c' } });

  const m = (await providerRecord('WOS', 'WOS:000000000000004', 'Manual re-entry paper', { year: 2017, dois: ['10.5555/m'] })).publicationId;
  const reentry = await addManualPublication(profA.id, userA.id, { title: 'Manual re-entry paper', typeFamily: 'JOURNAL', doi: '10.5555/M', year: 2017, basis: 'INDEPENDENT', evidence: '10.5555/m' }, T0);

  const d = (await providerRecord('WOS', 'WOS:000000000000005', 'Derived manual paper', { year: 2016, dois: ['10.5555/d'] })).publicationId;
  await addManualPublication(profB.id, userB.id, { title: 'Derived manual paper', typeFamily: 'JOURNAL', doi: '10.5555/d', year: 2016, basis: 'WOS', evidence: 'https://www.webofscience.com/wos/woscc/full-record/WOS:000000000000005' }, T0);

  const e = (await ingest({ source: 'OPENALEX', externalId: 'W300', title: 'Excluded curation paper', year: 2015, dois: ['10.5555/e'] })).publicationId;
  await providerRecord('WOS', 'WOS:000000000000006', 'Excluded curation paper', { year: 2015, dois: ['10.5555/e'] });
  await prisma.publication.update({ where: { id: e }, data: { title: 'Typed by the administrator', normalizedTitle: 'typed by the administrator' } });
  await curate(e, { title: { basis: 'INDEPENDENT', evidence: 'https://publisher.example.org/e' } });

  const x = (await ingest({ source: 'OPENALEX', externalId: 'W400', title: 'Unaffected paper', year: 2014 })).publicationId;
  await curate(x, { venue: { basis: 'INDEPENDENT' } });

  const run = await prisma.syncRun.create({ data: { kind: 'PUBLICATION_DISCOVERY', trigger: 'MANUAL', status: 'PARTIAL_SUCCESS', finishedAt: T0 } });
  const wosTask = await prisma.syncTask.create({ data: { syncRunId: run.id, identityId: wosIdentity.id, source: 'WOS', status: 'FAILED', errorMessage: `Mapping failed near "${PROVIDER_TEXT}"` } });
  const orcidTask = await prisma.syncTask.create({ data: { syncRunId: run.id, source: 'ORCID', status: 'FAILED', errorMessage: 'ORCID: HTTP 500' } });

  // S's type was edited before basis recording: its retention needs an explicit decision (#145).
  const keep: RemovalExclusions = { curation: [], manualRecords: [], legacy: [{ publicationId: s, field: 'type_family', decision: 'KEEP' }] };
  return { profA, profB, userA, wosIdentity, s, u, y, c, m, d, e, x, relUA, relUB, candidateUS, reentry, scopusObservation, wosTask, orcidTask, keep };
}

describe('dry run (plan)', () => {
  it('is read-only, classifies every affected publication and reports no provider content', async () => {
    const w = await wosWorld();
    const before = await state();
    const plan = await planProviderRemoval('WOS', NONE, options);
    expect(await state()).toEqual(before);

    expect(plan).toMatchObject({ kind: 'PROVIDER_REMOVAL_PLAN', provider: 'WOS', generatedAt: NOW });
    expect(plan.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    const cls = Object.fromEntries(plan.plan.publications.map((p) => [p.id, p.class]));
    expect(cls).toEqual({ [w.s]: 'SUPPORTED', [w.u]: 'UNSUPPORTED', [w.c]: 'CURATED_ONLY', [w.m]: 'SUPPORTED', [w.d]: 'UNSUPPORTED', [w.e]: 'SUPPORTED' });
    expect(plan.plan.publications.find((p) => p.id === w.s)).toMatchObject({ remainingSources: ['OPENALEX', 'DBLP', 'ORCID', 'SCOPUS', 'MANUAL'], retainedCuration: ['year'], relationships: [] });
    expect(plan.plan.publications.find((p) => p.id === w.u)!.relationships).toEqual([
      { id: w.relUA.id, professorId: w.profA.id, status: 'APPROVED', origin: 'DISCOVERED' },
      { id: w.relUB.id, professorId: w.profB.id, status: 'PENDING', origin: 'DISCOVERED' },
    ].sort((a, b) => a.id.localeCompare(b.id)));
    expect(plan.plan.curationRemoved).toEqual([{ publicationId: w.s, field: 'venue', basis: 'WOS', reason: 'PROVIDER_DERIVED' }]);
    expect(plan.plan.legacyReview).toEqual([{ publicationId: w.s, field: 'type_family', decision: null }]);
    // Independent values (curated and manual) are listed with their evidence for review.
    expect(plan.plan.curationReview).toEqual(
      expect.arrayContaining([
        { publicationId: w.s, field: 'year', evidence: 'https://publisher.example.org/s' },
        { publicationId: w.c, field: 'title', evidence: 'https://repository.example.org/c' },
        { publicationId: w.e, field: 'title', evidence: 'https://publisher.example.org/e' },
      ]),
    );
    expect(plan.plan.manualReview.map((r) => [r.publicationId, r.basis, r.evidence])).toEqual(
      expect.arrayContaining([
        [w.s, 'INDEPENDENT', 'https://publisher.example.org/s'],
        [w.m, 'INDEPENDENT', '10.5555/m'],
      ]),
    );
    expect(plan.summary).toMatchObject({
      providerRecords: 6,
      manualEntriesDerived: 1,
      citationObservations: 1,
      affectedPublications: 6,
      publicationsSupported: 3,
      publicationsCuratedOnly: 1,
      publicationsDeleted: 2,
      relationshipsDeleted: 3, // U: A and B; D: B's manual entry
      candidatesNulled: 2, // U–S and U–Y
      candidatesReworded: 1,
      syncTaskMessagesCleared: 1,
      identitiesRetained: 1,
      journals: 0,
      legacyFieldsForDecision: 1,
      legacyFieldsUnresolved: 1,
    });

    const text = JSON.stringify(plan);
    for (const content of [PROVIDER_TEXT, 'Only in web of science', 'Shared paper', 'WOS VENUE', 'Verma', '10.5555/u', 'WOS:0000']) expect(text).not.toContain(content);
    expect(plan.notes.join(' ')).toMatch(/VACUUM/);
    expect(plan.notes.join(' ')).toMatch(/backups and WAL/);
  });

  it('gives the same fingerprint for the same data and exclusions, and a different one otherwise', async () => {
    const w = await wosWorld();
    const first = await planProviderRemoval('WOS', NONE, options);
    expect((await planProviderRemoval('WOS', NONE, { ...options, now: () => new Date('2027-01-01T00:00:00Z') })).fingerprint).toBe(first.fingerprint);
    expect((await planProviderRemoval('WOS', { curation: [{ publicationId: w.e, field: 'title' }], manualRecords: [] }, options)).fingerprint).not.toBe(first.fingerprint);
    await prisma.publication.update({ where: { id: w.c }, data: { curation: { title: { basis: 'INDEPENDENT', evidence: 'https://repository.example.org/c2' } } } });
    expect((await planProviderRemoval('WOS', NONE, options)).fingerprint).not.toBe(first.fingerprint);
  });

  it('refuses exclusions that name nothing reviewable', async () => {
    const w = await wosWorld();
    const sRecord = await prisma.publicationSourceRecord.findFirstOrThrow({ where: { publicationId: w.s, source: 'OPENALEX' } });
    const derived = await prisma.publicationSourceRecord.findFirstOrThrow({ where: { publicationId: w.d, source: 'MANUAL' } });
    for (const exclusions of [
      { curation: [{ publicationId: w.s, field: 'type_family' as const }], manualRecords: [] }, // PRE_PHASE15, not INDEPENDENT
      { curation: [{ publicationId: w.x, field: 'venue' as const }], manualRecords: [] }, // not affected
      { curation: [], manualRecords: [sRecord.id] }, // not a manual entry
      { curation: [], manualRecords: [derived.id] }, // removed anyway
    ]) {
      await expect(planProviderRemoval('WOS', exclusions, options)).rejects.toMatchObject({ code: 'INVALID_EXCLUSION' });
    }
  });
});

describe('approved removal (one transaction)', () => {
  it('removes the provider data and keeps everything independently supported (§22.8)', async () => {
    const w = await wosWorld();
    const before = await state();
    const { plan, executed } = await approveAndExecute('WOS', w.keep);
    expect(executed).toMatchObject({ kind: 'PROVIDER_REMOVAL_EXECUTED', fingerprint: plan.fingerprint, summary: plan.summary });

    // No WoS record, no manual entry derived from WoS, no WoS observation remains.
    expect(await prisma.publicationSourceRecord.count({ where: { OR: [{ source: 'WOS' }, { entryBasis: 'WOS' }] } })).toBe(0);
    expect(await prisma.citationObservation.findMany()).toEqual([w.scopusObservation]);

    // Canonical recomputation: S keeps its other records; the WoS-derived curated venue is removed
    // and recomputed (DBLP); independent and PRE_PHASE15 curated values survive; authors fall back
    // from WoS to the manual entry (§9 priority).
    expect((await prisma.publicationSourceRecord.findMany({ where: { publicationId: w.s } })).map((r) => r.source).sort()).toEqual(['DBLP', 'MANUAL', 'OPENALEX', 'ORCID', 'SCOPUS']);
    expect(await publication(w.s)).toMatchObject({
      title: 'Shared paper',
      venue: 'DBLP Venue',
      year: 2020,
      typeFamily: 'CONFERENCE',
      authorNamesDisplay: 'A. Verma',
      doi: '10.5555/s',
      isCurated: true,
      curation: { year: { basis: 'INDEPENDENT', evidence: 'https://publisher.example.org/s' }, type_family: { basis: 'PRE_PHASE15' } },
    });

    // Approvals preserved: APPROVED (manual) and REJECTED relationships on S are untouched.
    const survivingRelationships = before.relationships.filter((r) => [w.s, w.m, w.e, w.c].includes(r.publicationId));
    expect(await prisma.professorPublication.findMany({ where: { publicationId: { in: [w.s, w.m, w.e, w.c] } }, orderBy: { id: 'asc' } })).toEqual(survivingRelationships);
    expect(survivingRelationships.filter((r) => r.publicationId === w.s).map((r) => r.status).sort()).toEqual(['APPROVED', 'REJECTED']);

    // Unsupported publications are deleted with their relationships; candidates keep their status with NULL references.
    expect(await publication(w.u)).toBeNull();
    expect(await publication(w.d)).toBeNull();
    expect(await prisma.professorPublication.count({ where: { id: { in: [w.relUA.id, w.relUB.id] } } })).toBe(0);
    expect(await prisma.duplicateCandidate.findUniqueOrThrow({ where: { id: w.candidateUS.id } })).toMatchObject({
      status: 'OPEN',
      reason: 'Source record [removed WOS record] reports a DOI that belongs to another publication',
    });
    const nulled = await prisma.duplicateCandidate.findUniqueOrThrow({ where: { id: w.candidateUS.id } });
    expect([nulled.publicationAId, nulled.publicationBId]).toContain(null);

    // The DOI U held is released and taken by the publication that carries it.
    expect(await publication(w.y)).toMatchObject({ doi: '10.5555/u', title: 'An entirely unrelated study of graphs' });
    expect(executed.recomputedForReleasedDoi).toEqual([w.y]);

    // Curated only: kept with the retained independent title, every other field emptied.
    expect(await publication(w.c)).toMatchObject({ title: 'Curated only paper (independent)', year: null, venue: null, typeFamily: 'OTHER', authorNamesDisplay: null, doi: null, isCurated: true });
    expect(await prisma.publicationSourceRecord.count({ where: { publicationId: w.c } })).toBe(0);

    // Manual re-entry: the independent entry attached to the same publication, which survives with it.
    expect(w.reentry.item.publication.id).toBe(w.m);
    expect(await publication(w.m)).toMatchObject({ title: 'Manual re-entry paper', year: 2017, doi: '10.5555/m', isCurated: false });
    expect(await prisma.professorPublication.findFirstOrThrow({ where: { publicationId: w.m } })).toMatchObject({ status: 'APPROVED', origin: 'MANUAL' });

    // Retained by default: E's independent title.
    expect(await publication(w.e)).toMatchObject({ title: 'Typed by the administrator', isCurated: true });

    // Unaffected publications are untouched.
    expect(await publication(w.x)).toEqual(before.publications.find((p) => p.id === w.x));

    // Run messages of the provider are cleared; others and identities are kept.
    expect(await prisma.syncTask.findUniqueOrThrow({ where: { id: w.wosTask.id } })).toMatchObject({ errorMessage: null, status: 'FAILED' });
    expect(await prisma.syncTask.findUniqueOrThrow({ where: { id: w.orcidTask.id } })).toMatchObject({ errorMessage: 'ORCID: HTTP 500' });
    expect(await prisma.externalIdentity.findUniqueOrThrow({ where: { id: w.wosIdentity.id } })).toEqual(before.identities.find((i) => i.id === w.wosIdentity.id));

    // Idempotent: a new plan finds nothing left to remove.
    const again = await planProviderRemoval('WOS', NONE, options);
    expect(again.summary).toMatchObject({ sourceRecords: 0, affectedPublications: 0, citationObservations: 0, syncTaskMessagesCleared: 0 });
    const after = await state();
    await executeProviderRemoval('WOS', NONE, again.fingerprint, options);
    expect(await state()).toEqual(after);
  });

  it('removes excluded independent values: a curated title is recomputed and an excluded manual entry stops supporting', async () => {
    const w = await wosWorld();
    const manual = await prisma.publicationSourceRecord.findFirstOrThrow({ where: { publicationId: w.m, source: 'MANUAL' } });
    const exclusions = { ...w.keep, curation: [{ publicationId: w.e, field: 'title' as const }, { publicationId: w.s, field: 'year' as const }], manualRecords: [manual.id] };
    const { plan } = await approveAndExecute('WOS', exclusions);
    expect(plan.plan.curationRemoved).toEqual(
      expect.arrayContaining([
        { publicationId: w.e, field: 'title', basis: 'INDEPENDENT', reason: 'EXCLUDED' },
        { publicationId: w.s, field: 'year', basis: 'INDEPENDENT', reason: 'EXCLUDED' },
      ]),
    );
    expect(await publication(w.e)).toMatchObject({ title: 'Excluded curation paper', normalizedTitle: 'excluded curation paper', isCurated: false, curation: {} });
    expect(await publication(w.s)).toMatchObject({ year: 2021, typeFamily: 'CONFERENCE', curation: { type_family: { basis: 'PRE_PHASE15' } } });
    // M had only WoS and the excluded entry: deleted with the professor's APPROVED relationship.
    expect(await publication(w.m)).toBeNull();
    expect(await prisma.professorPublication.count({ where: { publicationId: w.m } })).toBe(0);
  });

  it('removes an INDEPENDENT curated value without evidence from an affected publication', async () => {
    const w = await wosWorld();
    await curate(w.m, { venue: { basis: 'INDEPENDENT' } });
    const { plan } = await approveAndExecute('WOS', w.keep);
    expect(plan.plan.curationRemoved).toContainEqual({ publicationId: w.m, field: 'venue', basis: 'INDEPENDENT', reason: 'NO_EVIDENCE' });
    expect(await publication(w.m)).toMatchObject({ curation: {}, isCurated: false });
  });

  it('aborts without any change when the data changed after approval', async () => {
    const w = await wosWorld();
    const plan = await planProviderRemoval('WOS', w.keep, options);
    await providerRecord('WOS', 'WOS:000000000000099', 'Arrived after the plan', { year: 2020 });
    const before = await state();
    await expect(executeProviderRemoval('WOS', w.keep, plan.fingerprint, options)).rejects.toMatchObject({ code: 'PLAN_CHANGED' });
    expect(await state()).toEqual(before);
  });

  it('aborts when the exclusions differ from the approved plan', async () => {
    const w = await wosWorld();
    const plan = await planProviderRemoval('WOS', w.keep, options);
    const before = await state();
    await expect(executeProviderRemoval('WOS', { ...w.keep, curation: [{ publicationId: w.e, field: 'title' }] }, plan.fingerprint, options)).rejects.toMatchObject({ code: 'PLAN_CHANGED' });
    expect(await state()).toEqual(before);
  });

  it('is refused while a synchronization run is in progress', async () => {
    const w = await wosWorld();
    const plan = await planProviderRemoval('WOS', w.keep, options);
    await prisma.syncRun.create({ data: { kind: 'PUBLICATION_DISCOVERY', trigger: 'SCHEDULED', status: 'RUNNING' } });
    const before = await state();
    await expect(executeProviderRemoval('WOS', w.keep, plan.fingerprint, options)).rejects.toMatchObject({ code: 'SYNC_RUNNING' });
    expect(await state()).toEqual(before);
  });

  it('makes concurrent writers wait and refuses when it cannot get the tables in time', async () => {
    const w = await wosWorld();
    const plan = await planProviderRemoval('WOS', w.keep, options);
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    let locked!: () => void;
    const isLocked = new Promise<void>((resolve) => (locked = resolve));
    const holder = prisma.$transaction(
      async (tx) => {
        await tx.$executeRaw`LOCK TABLE publications IN ROW EXCLUSIVE MODE`;
        locked();
        await held;
      },
      { timeout: 20_000 },
    );
    await isLocked;
    const before = await state();
    await expect(executeProviderRemoval('WOS', w.keep, plan.fingerprint, { ...options, lockTimeoutMs: 200 })).rejects.toMatchObject({ code: 'LOCK_TIMEOUT' });
    release();
    await holder;
    expect(await state()).toEqual(before);
  });

  it('removing Scopus leaves Web of Science data, and the reverse', async () => {
    const w = await wosWorld();
    await approveAndExecute('SCOPUS', w.keep);
    expect(await prisma.publicationSourceRecord.count({ where: { source: 'SCOPUS' } })).toBe(0);
    expect(await prisma.publicationSourceRecord.count({ where: { source: 'WOS' } })).toBe(6);
    expect(await prisma.citationObservation.findMany({ select: { provider: true } })).toEqual([{ provider: 'WOS' }]);
    expect(await prisma.syncTask.findUniqueOrThrow({ where: { id: w.wosTask.id } })).toMatchObject({ errorMessage: expect.stringContaining(PROVIDER_TEXT) });
    expect(await publication(w.s)).toMatchObject({ curation: { venue: { basis: 'WOS' } }, venue: 'WOS VENUE' });
  });
});

describe('Journal Citation Reports removal', () => {
  async function jcrWorld() {
    const linked = (await ingest({ source: 'OPENALEX', externalId: 'W500', title: 'A journal paper', year: 2022, venue: 'OpenAlex Venue', issns: ['1234-5679'] })).publicationId;
    const journal = await prisma.journal.create({
      data: {
        jcrId: 'SYNTH-J1',
        name: `${PROVIDER_TEXT} JOURNAL`,
        issns: { create: [{ issn: '1234-5679', kind: 'PRINT' }] },
        snapshots: {
          create: [
            {
              jcrYear: 2023,
              revision: 1,
              payloadHash: 'a'.repeat(64),
              retrievedAt: T0,
              categoryMetrics: { create: [{ metric: 'JIF', categoryName: 'COMPUTER SCIENCE, THEORY & METHODS', quartile: 'Q1' }] },
            },
          ],
        },
      },
    });
    await prisma.publication.update({ where: { id: linked }, data: { journalId: journal.id, venue: `${PROVIDER_TEXT} JOURNAL` } });
    await curate(linked, { venue: { basis: 'JCR' } });
    const run = await prisma.syncRun.create({ data: { kind: 'JOURNAL_METRICS', trigger: 'MANUAL', status: 'FAILED', finishedAt: T0 } });
    const task = await prisma.syncTask.create({ data: { syncRunId: run.id, kind: 'JOURNAL_METRICS', journalId: journal.id, status: 'FAILED', errorMessage: `JCR: ${PROVIDER_TEXT}` } });
    return { linked, journal, task };
  }

  it('deletes journals with ISSNs, snapshots and category metrics, clears links and JCR-derived values', async () => {
    const j = await jcrWorld();
    const { plan } = await approveAndExecute('JCR');
    expect(plan.plan.journals).toEqual([{ id: j.journal.id, issns: 1, snapshots: 1, categoryMetrics: 1, linkedPublications: 1 }]);
    expect(JSON.stringify(plan)).not.toContain(PROVIDER_TEXT);
    expect(await prisma.journal.count()).toBe(0);
    expect(await prisma.journalIssn.count()).toBe(0);
    expect(await prisma.journalMetricSnapshot.count()).toBe(0);
    expect(await prisma.journalCategoryMetric.count()).toBe(0);
    expect(await publication(j.linked)).toMatchObject({ journalId: null, venue: 'OpenAlex Venue', isCurated: false, curation: {} });
    expect(await prisma.syncTask.findUniqueOrThrow({ where: { id: j.task.id } })).toMatchObject({ journalId: null, errorMessage: null });
    // The OpenAlex record (with its ISSNs) is not JCR data and stays.
    expect(await prisma.publicationSourceRecord.count({ where: { publicationId: j.linked } })).toBe(1);
  });
});

describe('fields edited before basis recording (unknown provenance, #145)', () => {
  /**
   * L: OpenAlex and WoS, curated as a whole record before basis recording (is_curated, no entries):
   *    all six fields read as PRE_PHASE15. T: WoS only, title PRE_PHASE15 (explicit entry).
   */
  async function legacyWorld() {
    const l = (await ingest({ source: 'OPENALEX', externalId: 'W700', title: 'Legacy paper', year: 2012, venue: 'OpenAlex Venue', authorNamesDisplay: 'O. Author' })).publicationId;
    await providerRecord('WOS', 'WOS:000000000000070', 'Legacy paper', { year: 2012 });
    await prisma.publication.update({
      where: { id: l },
      data: { isCurated: true, title: 'Legacy curated title', normalizedTitle: 'legacy curated title', venue: 'Legacy venue', year: 2011, authorNamesDisplay: 'Legacy authors' },
    });
    const t = (await providerRecord('WOS', 'WOS:000000000000071', 'Title only legacy paper', { year: 2013 })).publicationId;
    await prisma.publication.update({ where: { id: t }, data: { title: 'Legacy typed title', normalizedTitle: 'legacy typed title' } });
    await curate(t, { title: { basis: 'PRE_PHASE15' } });
    const rel = await prisma.professorPublication.create({ data: { professorId: (await prisma.professor.create({ data: { name: 'Prof L' } })).id, publicationId: t, status: 'APPROVED', origin: 'DISCOVERED' } });
    return { l, t, rel };
  }
  const decide = (decisions: [string, CuratedField, 'KEEP' | 'REMOVE'][]): RemovalExclusions => ({
    curation: [],
    manualRecords: [],
    legacy: decisions.map(([publicationId, field, decision]) => ({ publicationId, field, decision })),
  });
  const ALL: readonly CuratedField[] = ['title', 'year', 'venue', 'type_family', 'author_names_display', 'doi'];

  it('lists every affected legacy field individually, retains none by default, and refuses execution while any is unresolved', async () => {
    const w = await legacyWorld();
    const plan = await planProviderRemoval('WOS', NONE, options);
    expect(plan.plan.legacyReview).toEqual([
      ...ALL.map((field) => ({ publicationId: w.l, field, decision: null })),
      { publicationId: w.t, field: 'title', decision: null },
    ].sort((a, b) => a.publicationId.localeCompare(b.publicationId) || 0));
    expect(plan.summary).toMatchObject({ legacyFieldsForDecision: 7, legacyFieldsUnresolved: 7 });
    expect(plan.plan.publications.find((p) => p.id === w.l)!.retainedCuration).toEqual([]);
    expect(plan.plan.publications.find((p) => p.id === w.t)!.class).toBe('UNSUPPORTED');

    const before = await state();
    await expect(executeProviderRemoval('WOS', NONE, plan.fingerprint, options)).rejects.toMatchObject({ code: 'LEGACY_UNRESOLVED' });
    // Partly resolved is still unresolved.
    const partial = decide([[w.t, 'title', 'KEEP'], [w.l, 'title', 'KEEP']]);
    const partialPlan = await planProviderRemoval('WOS', partial, options);
    expect(partialPlan.summary).toMatchObject({ legacyFieldsUnresolved: 5 });
    await expect(executeProviderRemoval('WOS', partial, partialPlan.fingerprint, options)).rejects.toMatchObject({ code: 'LEGACY_UNRESOLVED', message: expect.stringContaining('5 curated field(s)') });
    expect(await state()).toEqual(before);
  });

  it('KEEP retains a value and REMOVE recomputes it from the remaining sources', async () => {
    const w = await legacyWorld();
    const decisions = decide([
      [w.l, 'title', 'KEEP'],
      [w.l, 'year', 'REMOVE'],
      [w.l, 'venue', 'REMOVE'],
      [w.l, 'type_family', 'KEEP'],
      [w.l, 'author_names_display', 'REMOVE'],
      [w.l, 'doi', 'REMOVE'],
      [w.t, 'title', 'KEEP'],
    ]);
    const { plan } = await approveAndExecute('WOS', decisions);
    expect(plan.plan.legacyReview.every((l) => l.decision !== null)).toBe(true);
    expect(plan.plan.curationRemoved.filter((c) => c.reason === 'LEGACY_REMOVE').map((c) => c.field).sort()).toEqual(['author_names_display', 'doi', 'venue', 'year']);
    expect(await publication(w.l)).toMatchObject({
      title: 'Legacy curated title',
      year: 2012,
      venue: 'OpenAlex Venue',
      authorNamesDisplay: 'O. Author',
      isCurated: true,
      curation: { title: { basis: 'PRE_PHASE15' }, type_family: { basis: 'PRE_PHASE15' } },
    });
    // A kept legacy title keeps a publication without source records (CURATED_ONLY), with its decisions.
    expect(plan.plan.publications.find((p) => p.id === w.t)!.class).toBe('CURATED_ONLY');
    expect(await publication(w.t)).toMatchObject({ title: 'Legacy typed title', year: null });
    expect(await prisma.professorPublication.findUniqueOrThrow({ where: { id: w.rel.id } })).toEqual(w.rel);
  });

  it('REMOVE of a legacy title leaves a publication without independent support, which is deleted', async () => {
    const w = await legacyWorld();
    await approveAndExecute('WOS', decide([...ALL.map((f) => [w.l, f, 'REMOVE'] as [string, CuratedField, 'REMOVE']), [w.t, 'title', 'REMOVE']]));
    expect(await publication(w.t)).toBeNull();
    expect(await prisma.professorPublication.count({ where: { id: w.rel.id } })).toBe(0);
    expect(await publication(w.l)).toMatchObject({ title: 'Legacy paper', year: 2012, venue: 'OpenAlex Venue', isCurated: false, curation: {} });
  });

  it('decisions are part of the fingerprint: executing other decisions than the approved ones is refused', async () => {
    const w = await legacyWorld();
    const keep = decide([...ALL.map((f) => [w.l, f, 'KEEP'] as [string, CuratedField, 'KEEP']), [w.t, 'title', 'KEEP']]);
    const remove = decide([...ALL.map((f) => [w.l, f, 'KEEP'] as [string, CuratedField, 'KEEP']), [w.t, 'title', 'REMOVE']]);
    const kept = await planProviderRemoval('WOS', keep, options);
    expect((await planProviderRemoval('WOS', remove, options)).fingerprint).not.toBe(kept.fingerprint);
    // Order and repetition of the same decisions do not matter.
    expect((await planProviderRemoval('WOS', { ...keep, legacy: [...keep.legacy!].reverse().concat(keep.legacy![0]) }, options)).fingerprint).toBe(kept.fingerprint);

    const before = await state();
    await expect(executeProviderRemoval('WOS', remove, kept.fingerprint, options)).rejects.toMatchObject({ code: 'PLAN_CHANGED' });
    expect(await state()).toEqual(before);
    await executeProviderRemoval('WOS', keep, kept.fingerprint, options);
    expect(await publication(w.t)).toMatchObject({ title: 'Legacy typed title' });
  });

  it('refuses decisions that name no legacy field of an affected publication, and conflicting decisions', async () => {
    const w = await legacyWorld();
    const x = (await ingest({ source: 'OPENALEX', externalId: 'W800', title: 'Unaffected legacy paper' })).publicationId;
    await curate(x, { title: { basis: 'PRE_PHASE15' } });
    await curate(w.t, { title: { basis: 'PRE_PHASE15' }, venue: { basis: 'INDEPENDENT', evidence: 'https://repository.example.org/t' } });
    for (const decisions of [
      decide([[x, 'title', 'KEEP']]), // not affected
      decide([[w.t, 'venue', 'KEEP']]), // INDEPENDENT, not legacy
      decide([[w.t, 'year', 'REMOVE']]), // not curated
      decide([[w.t, 'title', 'KEEP'], [w.t, 'title', 'REMOVE']]),
    ]) {
      await expect(planProviderRemoval('WOS', decisions, options)).rejects.toMatchObject({ code: 'INVALID_DECISION' });
    }
  });
});

describe('manual entries without basis or evidence (unknown provenance, #146)', () => {
  let n = 0;
  /** A MANUAL record as left before basis recording (no API path creates one without basis and evidence). */
  const manualRecord = (publicationId: string, entryBasis: string | null, entryEvidence: string | null) =>
    prisma.publicationSourceRecord.create({
      data: {
        publicationId,
        source: 'MANUAL',
        externalId: `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`,
        title: 'Manual copy',
        normalizedTitle: 'manual copy',
        typeFamily: 'JOURNAL',
        matchMethod: 'TITLE_YEAR',
        entryBasis,
        entryEvidence,
      },
    });

  /**
   * P1 WoS + manual without basis or evidence (APPROVED/MANUAL relationship); P2 WoS + manual
   * PRE_PHASE15 without evidence (the migration backfill); P3 WoS + documented INDEPENDENT manual;
   * P4 OpenAlex + WoS + manual INDEPENDENT with blank evidence; P5 WoS + manual derived from WoS
   * without evidence; Q OpenAlex + manual without basis (not affected).
   */
  async function unknownWorld() {
    const p1 = (await providerRecord('WOS', 'WOS:000000000000081', 'Unknown manual one', { year: 2010 })).publicationId;
    const m1 = await manualRecord(p1, null, null);
    const rel1 = await prisma.professorPublication.create({ data: { professorId: (await prisma.professor.create({ data: { name: 'Prof M' } })).id, publicationId: p1, status: 'APPROVED', origin: 'MANUAL', decidedAt: T0 } });
    const p2 = (await providerRecord('WOS', 'WOS:000000000000082', 'Unknown manual two', { year: 2010 })).publicationId;
    const m2 = await manualRecord(p2, 'PRE_PHASE15', null);
    const p3 = (await providerRecord('WOS', 'WOS:000000000000083', 'Documented manual', { year: 2010 })).publicationId;
    const m3 = await manualRecord(p3, 'INDEPENDENT', 'https://repository.example.org/p3');
    const p4 = (await ingest({ source: 'OPENALEX', externalId: 'W900', title: 'Blank evidence paper', year: 2010 })).publicationId;
    await providerRecord('WOS', 'WOS:000000000000084', 'Blank evidence paper', { year: 2010 });
    const m4 = await manualRecord(p4, 'INDEPENDENT', '   ');
    const p5 = (await providerRecord('WOS', 'WOS:000000000000085', 'Derived manual', { year: 2010 })).publicationId;
    const m5 = await manualRecord(p5, 'WOS', null);
    const q = (await ingest({ source: 'OPENALEX', externalId: 'W901', title: 'Unaffected manual paper' })).publicationId;
    const mq = await manualRecord(q, null, null);
    return { p1, p2, p3, p4, p5, q, m1, m2, m3, m4, m5, mq, rel1 };
  }
  const with_ = (keepManual: string[], manualRecords: string[] = []): RemovalExclusions => ({ curation: [], manualRecords, keepManual });

  it('lists each one individually, never counts it as support by default, and refuses execution while any is unresolved', async () => {
    const w = await unknownWorld();
    const plan = await planProviderRemoval('WOS', NONE, options);
    expect(plan.plan.unknownManualReview.map((m) => [m.recordId, m.publicationId, m.basis, m.evidence, m.decision])).toEqual(
      [
        [w.m1.id, w.p1, null, null, null],
        [w.m2.id, w.p2, 'PRE_PHASE15', null, null],
        [w.m4.id, w.p4, 'INDEPENDENT', '   ', null],
      ].sort((a, b) => String(a[1]).localeCompare(String(b[1]))),
    );
    expect(plan.summary).toMatchObject({ unknownManualEntriesForDecision: 3, unknownManualEntriesUnresolved: 3 });
    // Documented entries are listed for review as before; derived ones are removed as the provider's data.
    expect(plan.plan.manualReview.map((m) => m.recordId)).toEqual([w.m3.id]);
    expect(plan.plan.sourceRecords).toContainEqual({ id: w.m5.id, publicationId: w.p5, source: 'MANUAL', reason: 'MANUAL_DERIVED' });
    const cls = Object.fromEntries(plan.plan.publications.map((p) => [p.id, p.class]));
    expect(cls).toMatchObject({ [w.p1]: 'UNSUPPORTED', [w.p2]: 'UNSUPPORTED', [w.p3]: 'SUPPORTED', [w.p4]: 'SUPPORTED' });
    expect(cls[w.q]).toBeUndefined();

    const before = await state();
    await expect(executeProviderRemoval('WOS', NONE, plan.fingerprint, options)).rejects.toMatchObject({
      code: 'LEGACY_UNRESOLVED',
      message: expect.stringContaining('3 manual entries without basis or evidence'),
    });
    const partial = with_([w.m1.id]);
    const partialPlan = await planProviderRemoval('WOS', partial, options);
    await expect(executeProviderRemoval('WOS', partial, partialPlan.fingerprint, options)).rejects.toMatchObject({ code: 'LEGACY_UNRESOLVED', message: expect.stringContaining('2 manual entries') });
    expect(await state()).toEqual(before);
  });

  it('KEEP retains the entry as support; REMOVE (exclusion) deletes it', async () => {
    const w = await unknownWorld();
    const { plan } = await approveAndExecute('WOS', with_([w.m1.id], [w.m2.id, w.m4.id]));
    expect(plan.plan.unknownManualReview.map((m) => [m.recordId, m.decision])).toEqual(
      expect.arrayContaining([
        [w.m1.id, 'KEEP'],
        [w.m2.id, 'REMOVE'],
        [w.m4.id, 'REMOVE'],
      ]),
    );
    // Kept: P1 survives on the manual entry with its relationship unchanged.
    expect(await prisma.publicationSourceRecord.findMany({ where: { publicationId: w.p1 }, select: { id: true } })).toEqual([{ id: w.m1.id }]);
    expect(await prisma.professorPublication.findUniqueOrThrow({ where: { id: w.rel1.id } })).toEqual(w.rel1);
    // Removed: P2 had nothing else and is deleted; P4 keeps its OpenAlex record.
    expect(await publication(w.p2)).toBeNull();
    expect(await prisma.publicationSourceRecord.count({ where: { id: { in: [w.m2.id, w.m4.id] } } })).toBe(0);
    expect(await prisma.publicationSourceRecord.findMany({ where: { publicationId: w.p4 }, select: { source: true } })).toEqual([{ source: 'OPENALEX' }]);
    // Unaffected publications and documented entries are untouched.
    expect(await prisma.publicationSourceRecord.count({ where: { id: { in: [w.m3.id, w.mq.id] } } })).toBe(2);
  });

  it('decisions are part of the fingerprint: executing other decisions than the approved ones is refused', async () => {
    const w = await unknownWorld();
    const keep = with_([w.m1.id, w.m2.id, w.m4.id]);
    const remove = with_([w.m2.id, w.m4.id], [w.m1.id]);
    const kept = await planProviderRemoval('WOS', keep, options);
    expect((await planProviderRemoval('WOS', remove, options)).fingerprint).not.toBe(kept.fingerprint);
    expect((await planProviderRemoval('WOS', with_([w.m4.id, w.m2.id, w.m1.id, w.m1.id]), options)).fingerprint).toBe(kept.fingerprint);

    const before = await state();
    await expect(executeProviderRemoval('WOS', remove, kept.fingerprint, options)).rejects.toMatchObject({ code: 'PLAN_CHANGED' });
    expect(await state()).toEqual(before);
    await executeProviderRemoval('WOS', keep, kept.fingerprint, options);
    expect(await publication(w.p1)).not.toBeNull();
  });

  it('refuses keep decisions for documented, derived or unaffected entries, and conflicting decisions', async () => {
    const w = await unknownWorld();
    for (const exclusions of [with_([w.m3.id]), with_([w.m5.id]), with_([w.mq.id]), with_([w.m1.id], [w.m1.id])]) {
      await expect(planProviderRemoval('WOS', exclusions, options)).rejects.toMatchObject({ code: 'INVALID_DECISION' });
    }
  });
});
