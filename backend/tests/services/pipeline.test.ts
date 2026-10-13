import { Prisma } from '@prisma/client';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { prisma } from '../../src/config/database';
import { DblpClient } from '../../src/integrations/dblp/client';
import { OPENALEX_BASE_URL, OPENALEX_WORK_FIELDS, OpenAlexClient } from '../../src/integrations/openalex/client';
import { OrcidClient } from '../../src/integrations/orcid/client';
import { discoverDblpIdentity } from '../../src/services/discovery/dblpDiscovery';
import { ingestDiscoveredRecords } from '../../src/services/discovery/ingestDiscoveredRecords';
import { discoverOpenAlexIdentity } from '../../src/services/discovery/openAlexDiscovery';
import { discoverOrcidIdentity } from '../../src/services/discovery/orcidDiscovery';
import { ingestPublication } from '../../src/services/matching/engine';
import { buildNormalizedPublication, PublicationInput } from '../../src/services/normalization/normalizedPublication';
import { resetDatabase } from '../helpers/database';
import { loadFixture, noSleep, RecordedResponse, replayFetch } from '../helpers/fixtures';

/*
 * Phase 7: the complete multi-source pipeline (Project_plan.md §14, §18, §19) and its failure
 * behaviour against the real test database.
 */

// The three-source test ingests 830 DBLP records three times.
vi.setConfig({ testTimeout: 120_000 });

beforeEach(async () => {
  await resetDatabase();
});

afterAll(async () => {
  await resetDatabase();
  await prisma.$disconnect();
});

const counts = async () => ({
  publications: await prisma.publication.count(),
  sourceRecords: await prisma.publicationSourceRecord.count(),
  links: await prisma.professorPublication.count(),
  candidates: await prisma.duplicateCandidate.count(),
});
const at = (iso: string) => () => new Date(iso);

// ---------------------------------------------------------------------------------------------
// C1 — three sources, one professor, reruns
// ---------------------------------------------------------------------------------------------

const VARDI_OPENALEX = 'A5000059818';
const VARDI_DBLP = 'v/MosheYVardi';
const VARDI_ORCID = '0000-0002-0661-5773';

/*
 * OpenAlex: the recorded Vardi works (works-cases, real work bodies fetched by ID) served as his
 * author-works response. Only the envelope is synthetic: the author record and a single page whose
 * meta.count equals the number of recorded works.
 */
function vardiOpenAlex(): OpenAlexClient {
  const works = loadFixture('openalex', 'works-cases').body as { results: unknown[] };
  const json = (request: string, body: unknown): RecordedResponse => ({ request, status: 200, contentType: 'application/json', body });
  const replay = replayFetch([
    json(`${OPENALEX_BASE_URL}/authors/${VARDI_OPENALEX}?select=id,display_name,orcid,works_count`, {
      id: `https://openalex.org/${VARDI_OPENALEX}`,
      display_name: 'Moshe Y. Vardi',
      orcid: `https://orcid.org/${VARDI_ORCID}`,
    }),
    json(
      `${OPENALEX_BASE_URL}/works?filter=author.id:${VARDI_OPENALEX}&per-page=100&cursor=*&select=${OPENALEX_WORK_FIELDS.join(',')}`,
      { meta: { count: works.results.length, next_cursor: null }, results: works.results },
    ),
  ]);
  return new OpenAlexClient({ deps: { fetchImpl: replay.fetchImpl, sleep: noSleep } });
}

function vardiDblp(): DblpClient {
  const replay = replayFetch(['identity-person', 'records-person', 'authors-person'].map((n) => loadFixture('dblp', n)));
  return new DblpClient({ deps: { fetchImpl: replay.fetchImpl, sleep: noSleep } });
}

function vardiOrcid(): OrcidClient {
  const replay = replayFetch([loadFixture('orcid', 'works-vardi')]);
  return new OrcidClient({ deps: { fetchImpl: replay.fetchImpl, sleep: noSleep } });
}

/** Everything a rerun must leave unchanged (timestamps excluded; last_seen_at is checked separately). */
async function pipelineState() {
  return {
    publications: await prisma.publication.findMany({
      select: { id: true, title: true, normalizedTitle: true, year: true, venue: true, typeFamily: true, doi: true, authorNamesDisplay: true, status: true, isCurated: true },
      orderBy: { id: 'asc' },
    }),
    sourceRecords: await prisma.publicationSourceRecord.findMany({
      select: { id: true, publicationId: true, source: true, externalId: true, title: true, doi: true, year: true, typeFamily: true, matchMethod: true, matchDetail: true, rawMetadata: true, firstSeenAt: true },
      orderBy: { id: 'asc' },
    }),
    links: await prisma.professorPublication.findMany({
      select: { id: true, professorId: true, publicationId: true, status: true, origin: true, discoveredViaIdentityId: true, decidedAt: true },
      orderBy: { id: 'asc' },
    }),
    candidates: await prisma.duplicateCandidate.findMany({
      select: { id: true, publicationAId: true, publicationBId: true, reason: true, status: true },
      orderBy: { id: 'asc' },
    }),
  };
}

describe('three-source discovery for one professor (OpenAlex + DBLP + ORCID)', () => {
  it('merges across all three sources, links once per publication, and reruns change nothing', async () => {
    const professor = await prisma.professor.create({ data: { name: 'Moshe Y. Vardi' } });
    const identity = (source: 'OPENALEX' | 'DBLP' | 'ORCID', externalId: string) =>
      prisma.externalIdentity.create({ data: { professorId: professor.id, source, externalId } });
    const openAlexId = await identity('OPENALEX', VARDI_OPENALEX);
    const dblpId = await identity('DBLP', VARDI_DBLP);
    const orcidId = await identity('ORCID', VARDI_ORCID);

    const runAll = async (order: Array<'OPENALEX' | 'DBLP' | 'ORCID'>, now: () => Date) => {
      const summaries: Record<string, { recordsFetched: number; recordsNew: number; recordsUpdated: number; recordsSkipped: number; linksCreated: number; candidatesCreated: number }> = {};
      for (const source of order) {
        if (source === 'OPENALEX') summaries[source] = await discoverOpenAlexIdentity(openAlexId.id, { openAlex: vardiOpenAlex(), now });
        if (source === 'DBLP') summaries[source] = await discoverDblpIdentity(dblpId.id, { dblp: vardiDblp(), now });
        if (source === 'ORCID') summaries[source] = await discoverOrcidIdentity(orcidId.id, { orcid: vardiOrcid(), now });
      }
      return summaries;
    };

    // 1. First discovery: OpenAlex, then DBLP, then ORCID.
    const first = await runAll(['OPENALEX', 'DBLP', 'ORCID'], at('2026-09-01T00:00:00Z'));
    expect(first.OPENALEX).toMatchObject({ recordsFetched: 9, recordsNew: 8, recordsSkipped: 1 }); // W4229843017 has an empty title
    expect(first.DBLP).toMatchObject({ recordsFetched: 830, recordsNew: 830, recordsSkipped: 0 });
    expect(first.ORCID.recordsNew + first.ORCID.recordsSkipped).toBe(first.ORCID.recordsFetched);

    const recordOf = (source: 'OPENALEX' | 'DBLP' | 'ORCID', externalId: string) =>
      prisma.publicationSourceRecord.findUniqueOrThrow({ where: { source_externalId: { source, externalId } } });

    // OpenAlex ↔ DBLP (DOI and exact title + year) and DBLP ↔ ORCID (title + year, no DOI) merges.
    for (const [workId, key] of [
      ['W1632042597', 'conf/aaai/ChakrabortyFMSV14'],
      ['W2889619879', 'conf/aaai/PratesALLV19'],
      ['W2033071128', 'journals/jcss/VardiW86'],
      ['W42364276', 'conf/lics/VardiW86'],
      ['W3037471945', 'journals/corr/abs-2003-00330'],
    ]) {
      expect((await recordOf('OPENALEX', workId)).publicationId, `${workId} ↔ ${key}`).toBe((await recordOf('DBLP', key)).publicationId);
    }
    const moduleChecking = await recordOf('ORCID', `${VARDI_ORCID}:5160614`);
    expect(moduleChecking.publicationId).toBe((await recordOf('DBLP', 'journals/iandc/KupfermanVW01')).publicationId);

    // Every publication has provenance; every publication has exactly one PENDING link for the
    // professor, recorded against the identity that discovered it first.
    const publications = await prisma.publication.findMany({ include: { sourceRecords: true, professors: true } });
    expect(publications.every((p) => p.sourceRecords.length > 0)).toBe(true);
    expect(publications.every((p) => p.professors.length === 1)).toBe(true);
    const links = await prisma.professorPublication.findMany();
    expect(links.every((l) => l.professorId === professor.id && l.status === 'PENDING' && l.origin === 'DISCOVERED')).toBe(true);
    const firstFinder = new Map(
      publications.map((p) => {
        const earliest = [...p.sourceRecords].sort((a, b) => a.firstSeenAt.getTime() - b.firstSeenAt.getTime() || a.source.localeCompare(b.source))[0];
        return [p.id, earliest.source];
      }),
    );
    const identityBySource: Record<string, string> = { OPENALEX: openAlexId.id, DBLP: dblpId.id, ORCID: orcidId.id };
    for (const link of links) {
      expect(link.discoveredViaIdentityId).toBe(identityBySource[firstFinder.get(link.publicationId)!]);
    }
    expect(first.OPENALEX.linksCreated + first.DBLP.linksCreated + first.ORCID.linksCreated).toBe(publications.length);

    // The professor decides on two relationships before the next sync.
    const [toReject, toApprove] = links;
    await prisma.professorPublication.update({ where: { id: toReject.id }, data: { status: 'REJECTED', decidedAt: new Date('2026-09-15T00:00:00Z') } });
    await prisma.professorPublication.update({ where: { id: toApprove.id }, data: { status: 'APPROVED', decidedAt: new Date('2026-09-15T00:00:00Z') } });

    const before = await pipelineState();
    const ingested = before.sourceRecords.length;

    // 2. Rerun in the same order, then 3. in reverse order: nothing changes except last_seen_at.
    for (const [order, iso] of [
      [['OPENALEX', 'DBLP', 'ORCID'], '2026-10-01T00:00:00Z'],
      [['ORCID', 'DBLP', 'OPENALEX'], '2026-11-01T00:00:00Z'],
    ] as const) {
      const rerun = await runAll([...order], at(iso));
      for (const summary of Object.values(rerun)) {
        expect(summary).toMatchObject({ recordsNew: 0, linksCreated: 0, candidatesCreated: 0 });
        expect(summary.recordsUpdated + summary.recordsSkipped).toBe(summary.recordsFetched);
      }
      expect(await pipelineState(), `rerun ${order.join(' → ')}`).toEqual(before);
      expect(await prisma.publicationSourceRecord.count({ where: { lastSeenAt: new Date(iso) } })).toBe(ingested);
    }

    expect((await prisma.professorPublication.findUniqueOrThrow({ where: { id: toReject.id } })).status).toBe('REJECTED');
    expect((await prisma.professorPublication.findUniqueOrThrow({ where: { id: toApprove.id } })).status).toBe('APPROVED');
  });
});

// ---------------------------------------------------------------------------------------------
// C2 — a database failure part-way through a discovery run
// ---------------------------------------------------------------------------------------------

async function discoveryIdentity() {
  const professor = await prisma.professor.create({ data: { name: 'Prof' } });
  const identity = await prisma.externalIdentity.create({ data: { professorId: professor.id, source: 'DBLP', externalId: 'x/Prof' } });
  return { id: identity.id, professorId: professor.id };
}

const record = (key: string, title: string, rawMetadata: unknown = { key }): PublicationInput => ({
  source: 'DBLP',
  externalId: key,
  title,
  year: 2020,
  typeFamily: 'CONFERENCE',
  rawMetadata,
});

/*
 * A genuine PostgreSQL error inside one record's transaction: a temporary trigger that rejects
 * inserting one specific source record. It is created only in the isolated *_test database and is
 * always dropped again, also when an assertion fails.
 */
const FAILING_KEY = 'conf/x/B';
const TRIGGER_FN = 'phase7_test_fail_source_record';
async function dropFailingInsertTrigger() {
  await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS ${TRIGGER_FN} ON publication_source_records`);
  await prisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS ${TRIGGER_FN}()`);
}
async function withFailingInsertTrigger(run: () => Promise<void>) {
  const [{ current_database: name }] = await prisma.$queryRaw<{ current_database: string }[]>`SELECT current_database()`;
  if (!name.endsWith('_test')) throw new Error(`Refusing to create a test trigger in non-test database "${name}"`);
  await dropFailingInsertTrigger(); // leftovers from an interrupted earlier run
  try {
    await prisma.$executeRawUnsafe(`CREATE FUNCTION ${TRIGGER_FN}() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.external_id = '${FAILING_KEY}' THEN RAISE EXCEPTION 'phase7 test: insert rejected'; END IF;
        RETURN NEW;
      END $$`);
    await prisma.$executeRawUnsafe(
      `CREATE TRIGGER ${TRIGGER_FN} BEFORE INSERT ON publication_source_records FOR EACH ROW EXECUTE FUNCTION ${TRIGGER_FN}()`,
    );
    await run();
  } finally {
    await dropFailingInsertTrigger();
  }
}

describe('database failure part-way through a discovery run (§14; real test database)', () => {
  it('keeps the records written before the failure, rolls the failing record back completely, and a rerun completes', async () => {
    const identity = await discoveryIdentity();
    const batch = [
      record('conf/x/A', 'First paper about model checking'),
      record(FAILING_KEY, 'Second paper about model checking'),
      record('conf/x/C', 'Third paper about model checking'),
    ];

    await withFailingInsertTrigger(async () => {
      const error = await ingestDiscoveredRecords(identity, batch, { seenAt: new Date('2026-09-01T00:00:00Z') }).catch((e: unknown) => e);

      // Raised to the caller (never reported as success); it is the database rejecting the insert,
      // which happens after B's new Publication row was inserted in the same transaction.
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain('phase7 test: insert rejected');
      // A was committed in its own transaction, with its link; B's Publication insert was rolled back
      // with its failed source record; C was never processed.
      expect(await counts()).toEqual({ publications: 1, sourceRecords: 1, links: 1, candidates: 0 });
      expect(await prisma.publication.findMany({ select: { title: true } })).toEqual([{ title: 'First paper about model checking' }]);
    });
    const kept = await prisma.publicationSourceRecord.findUniqueOrThrow({ where: { source_externalId: { source: 'DBLP', externalId: 'conf/x/A' } } });

    // The next run (the database accepts B again) completes; A is updated in place, not duplicated.
    const rerun = await ingestDiscoveredRecords(identity, batch, { seenAt: new Date('2026-10-01T00:00:00Z') });
    expect(rerun).toMatchObject({ recordsNew: 2, recordsUpdated: 1, linksCreated: 2 });
    expect(await counts()).toEqual({ publications: 3, sourceRecords: 3, links: 3, candidates: 0 });
    expect(await prisma.publicationSourceRecord.findUniqueOrThrow({ where: { id: kept.id } })).toMatchObject({
      publicationId: kept.publicationId,
      lastSeenAt: new Date('2026-10-01T00:00:00Z'),
    });
  });

  it('drops the temporary trigger even when the code run under it fails', async () => {
    await expect(withFailingInsertTrigger(async () => { throw new Error('assertion failed inside'); })).rejects.toThrow('assertion failed inside');
    const triggers = await prisma.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM pg_trigger WHERE tgname = ${TRIGGER_FN}`;
    const functions = await prisma.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM pg_proc WHERE proname = ${TRIGGER_FN}`;
    expect([Number(triggers[0].n), Number(functions[0].n)]).toEqual([0, 0]);
  });

  it('recovers on rerun when the link insert after a committed record fails (stubbed link insert)', async () => {
    const identity = await discoveryIdentity();
    const a = record('conf/x/A', 'First paper about model checking');
    const b = record('conf/x/B', 'Second paper about model checking');

    // The relationship is inserted after the record's transaction has committed
    // (ingestDiscoveredRecords); simulate that insert failing once.
    let failures = 1;
    const failingLinks = new Proxy(prisma.professorPublication, {
      get(target, prop) {
        if (prop === 'createMany' && failures > 0) {
          return async () => {
            failures--;
            throw new Error('simulated link insert failure');
          };
        }
        const value = Reflect.get(target, prop);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const client = withOverride(prisma, 'professorPublication', failingLinks);

    await expect(ingestDiscoveredRecords(identity, [a, b], { seenAt: new Date('2026-09-01T00:00:00Z'), client })).rejects.toThrow(
      'simulated link insert failure',
    );
    // A's record is committed but unlinked; B was never processed.
    expect(await counts()).toEqual({ publications: 1, sourceRecords: 1, links: 0, candidates: 0 });

    const rerun = await ingestDiscoveredRecords(identity, [a, b], { seenAt: new Date('2026-10-01T00:00:00Z') });
    expect(rerun).toMatchObject({ recordsNew: 1, recordsUpdated: 1, linksCreated: 2 });
    expect(await counts()).toEqual({ publications: 2, sourceRecords: 2, links: 2, candidates: 0 });
    const links = await prisma.professorPublication.findMany();
    expect(links.every((l) => l.status === 'PENDING' && l.discoveredViaIdentityId === identity.id)).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------
// C3 — concurrent unique-key conflict
// ---------------------------------------------------------------------------------------------

describe('concurrent ingest of the same record (unique-key conflict retry)', () => {
  it('rolls back the losing attempt and retries it as an update of the committed record', async () => {
    // OTHER and no year: no title merge is possible, so the losing attempt takes the new-publication
    // path and inserts a Publication before its source-record insert hits the unique key.
    const input: PublicationInput = { source: 'ORCID', externalId: '0000-0002-0661-5773:42', title: 'A concurrently ingested paper', typeFamily: 'OTHER' };
    const normalized = buildNormalizedPublication(input);

    // During the first attempt only: right after the attempt has looked for the record (and found
    // none), a concurrent ingest of the same record commits on another connection.
    let attempts = 0;
    let competitor: Awaited<ReturnType<typeof ingestPublication>> | undefined;
    const client = withOverride(prisma, '$transaction', (fn: (tx: Prisma.TransactionClient) => Promise<unknown>) =>
      prisma.$transaction((tx) => {
        attempts++;
        if (attempts > 1) return fn(tx);
        const records = new Proxy(tx.publicationSourceRecord, {
          get(target, prop) {
            const value = Reflect.get(target, prop);
            if (prop !== 'findUnique') return typeof value === 'function' ? value.bind(target) : value;
            return async (args: Prisma.PublicationSourceRecordFindUniqueArgs) => {
              const found = await target.findUnique(args);
              competitor ??= await ingestPublication(normalized, { client: prisma });
              return found;
            };
          },
        });
        return fn(withOverride(tx, 'publicationSourceRecord', records));
      }),
    );

    const result = await ingestPublication(normalized, { client });

    expect(attempts).toBe(2);
    expect(competitor).toMatchObject({ outcome: 'NEW_PUBLICATION' });
    expect(result).toMatchObject({ outcome: 'UPDATED_EXISTING', publicationId: competitor!.publicationId, sourceRecordId: competitor!.sourceRecordId });
    // The losing attempt's Publication insert was rolled back by the database.
    expect(await counts()).toEqual({ publications: 1, sourceRecords: 1, links: 0, candidates: 0 });
  });
});

// ---------------------------------------------------------------------------------------------
// U+0000 in source data (decision #52)
// ---------------------------------------------------------------------------------------------

describe('U+0000 in source data never blocks discovery (decision #52; real test database)', () => {
  const recordState = () =>
    prisma.publicationSourceRecord.findMany({
      select: { id: true, publicationId: true, externalId: true, title: true, doi: true, rawMetadata: true, matchMethod: true },
      orderBy: { externalId: 'asc' },
    });

  it('stores a record with U+0000 (title, DOI, nested raw values and keys), processes later records, and reruns cleanly', async () => {
    const identity = await discoveryIdentity();
    const batch: PublicationInput[] = [
      record('conf/x/A', 'First paper about model checking'),
      {
        ...record('conf/x/B', 'Second\u0000paper about model checking'),
        dois: ['10.1234/b\u0000', '10.1234/b-valid'],
        venue: 'CAV\u0000',
        rawMetadata: { key: 'conf/x/B', 'note\u0000': { list: ['x\u0000y'] }, 'note\uFFFD': 'kept' },
      },
      record('conf/x/C', 'Third paper about model checking'),
    ];

    const first = await ingestDiscoveredRecords(identity, batch, { seenAt: new Date('2026-09-01T00:00:00Z') });
    expect(first).toMatchObject({ recordsNew: 3, recordsSkipped: 0, linksCreated: 3, warnings: [] });
    expect(await counts()).toEqual({ publications: 3, sourceRecords: 3, links: 3, candidates: 0 });

    const b = await prisma.publicationSourceRecord.findUniqueOrThrow({ where: { source_externalId: { source: 'DBLP', externalId: 'conf/x/B' } } });
    expect(b).toMatchObject({ title: 'Second\uFFFDpaper about model checking', normalizedTitle: 'second paper about model checking', venue: 'CAV\uFFFD', doi: '10.1234/b-valid' });
    expect(b.rawMetadata).toEqual({
      key: 'conf/x/B',
      'note\uFFFD': 'kept',
      'note\uFFFD#2': { list: ['x\uFFFDy'] },
      _normalizedDois: ['10.1234/b-valid'],
    });
    const publication = await prisma.publication.findUniqueOrThrow({ where: { id: b.publicationId } });
    expect(publication).toMatchObject({ title: 'Second\uFFFDpaper about model checking', doi: '10.1234/b-valid' });

    // Rerun: nothing new, the same stored values (the replacement is deterministic).
    const before = await recordState();
    const rerun = await ingestDiscoveredRecords(identity, batch, { seenAt: new Date('2026-10-01T00:00:00Z') });
    expect(rerun).toMatchObject({ recordsNew: 0, recordsUpdated: 3, linksCreated: 0, candidatesCreated: 0 });
    expect(await recordState()).toEqual(before);
  });

  it('matches by title exactly as the title without U+0000 would', async () => {
    const existing = await ingestPublication(buildNormalizedPublication(record('conf/x/A', 'Model Checking Software Product Lines')));
    const withNul = await ingestPublication(
      buildNormalizedPublication({ ...record('W123', 'Model\u0000Checking Software Product Lines'), source: 'OPENALEX' }),
    );
    expect(withNul).toMatchObject({ outcome: 'MATCHED_TITLE_YEAR', publicationId: existing.publicationId });
  });

  it('skips a record whose external ID contains U+0000 (never altered), with a safe warning; later records are processed', async () => {
    const identity = await discoveryIdentity();
    const batch = [
      record('conf/x/A', 'First paper about model checking'),
      record('conf/x/\u0000B', 'Second paper about model checking'),
      record('conf/x/C', 'Third paper about model checking'),
    ];

    for (const seenAt of ['2026-09-01T00:00:00Z', '2026-10-01T00:00:00Z']) {
      const summary = await ingestDiscoveredRecords(identity, batch, { seenAt: new Date(seenAt) });
      expect(summary.recordsSkipped).toBe(1);
      expect(summary.warnings).toEqual([
        'Skipped DBLP:conf/x/\uFFFDB: Record DBLP:conf/x/\uFFFDB has an external ID containing U+0000',
      ]);
      expect(JSON.stringify(summary.warnings)).not.toContain('\\u0000');
      expect(await counts()).toEqual({ publications: 2, sourceRecords: 2, links: 2, candidates: 0 });
    }
    expect((await prisma.publicationSourceRecord.findMany({ select: { externalId: true }, orderBy: { externalId: 'asc' } })).map((r) => r.externalId)).toEqual([
      'conf/x/A',
      'conf/x/C',
    ]);
  });

  it('handles U+0000 in a recorded ORCID response through the discovery service, and reruns cleanly', async () => {
    const professor = await prisma.professor.create({ data: { name: 'Moshe Y. Vardi' } });
    const orcid = await prisma.externalIdentity.create({ data: { professorId: professor.id, source: 'ORCID', externalId: VARDI_ORCID } });

    const clean = loadFixture('orcid', 'works-vardi');
    const dirty = structuredClone(clean);
    type Summary = { 'put-code': number; title: { title: { value: string } } | null } & Record<string, unknown>;
    const summaries = (dirty.body as { group: Array<{ 'work-summary': Summary[] }> }).group.flatMap((g) => g['work-summary']);
    const target = summaries.find((s) => s.title?.title?.value)!;
    const originalTitle = target.title!.title.value;
    target.title!.title.value = originalTitle.replace(' ', '\u0000');
    target['note\u0000'] = 'injected \u0000';
    const client = () => new OrcidClient({ deps: { fetchImpl: replayFetch([dirty]).fetchImpl, sleep: noSleep } });

    const first = await discoverOrcidIdentity(orcid.id, { orcid: client(), now: at('2026-09-01T00:00:00Z') });
    // Same outcome as the recorded clean response: only the titleless summaries are skipped.
    expect(first).toMatchObject({ recordsFetched: summaries.length, recordsSkipped: 3, recordsNew: summaries.length - 3 });
    const stored = await prisma.publicationSourceRecord.findUniqueOrThrow({
      where: { source_externalId: { source: 'ORCID', externalId: `${VARDI_ORCID}:${target['put-code']}` } },
    });
    expect(stored.title).toBe(originalTitle.replace(' ', '\uFFFD'));
    expect(stored.rawMetadata).toMatchObject({ 'note\uFFFD': 'injected \uFFFD' });

    const before = await recordState();
    const rerun = await discoverOrcidIdentity(orcid.id, { orcid: client(), now: at('2026-10-01T00:00:00Z') });
    expect(rerun).toMatchObject({ recordsNew: 0, linksCreated: 0, candidatesCreated: 0, recordsUpdated: summaries.length - 3 });
    expect(await recordState()).toEqual(before);
  });
});

/** A view of a Prisma client (or transaction client) with one property replaced. */
function withOverride<T extends object>(target: T, key: PropertyKey, replacement: unknown): T {
  return new Proxy(target, {
    get(t, prop) {
      if (prop === key) return replacement;
      const value = Reflect.get(t, prop);
      return typeof value === 'function' ? value.bind(t) : value;
    },
  }) as T;
}

