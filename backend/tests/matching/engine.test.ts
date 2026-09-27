import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '../../src/config/database';
import { ingestPublication, IngestOptions, RAW_METADATA_DOIS_KEY } from '../../src/services/matching/engine';
import { buildNormalizedPublication, PublicationInput } from '../../src/services/normalization/normalizedPublication';
import { resetDatabase } from '../helpers/database';

/*
 * Synthetic records modelled on real cross-source cases observed during the Prompt 3 API
 * validation (e.g. Kupferman & Vardi's "Module Checking" conference vs journal versions, the
 * CP 2013 paper and its CoRR preprint, duplicate OpenAlex works sharing an AAAI DOI).
 */

function ingest(input: PublicationInput, options: IngestOptions = {}) {
  return ingestPublication(buildNormalizedPublication(input), options);
}

const counts = async () => ({
  publications: await prisma.publication.count(),
  sourceRecords: await prisma.publicationSourceRecord.count(),
  candidates: await prisma.duplicateCandidate.count(),
});

async function candidateBetween(x: string, y: string) {
  const [publicationAId, publicationBId] = x < y ? [x, y] : [y, x];
  return prisma.duplicateCandidate.findUnique({
    where: { publicationAId_publicationBId: { publicationAId, publicationBId } },
  });
}

beforeEach(async () => {
  await resetDatabase();
});

afterAll(async () => {
  await resetDatabase();
  await prisma.$disconnect();
});

const CP13_DOI = '10.1007/978-3-642-40627-0_18';

const cp13OpenAlex: PublicationInput = {
  source: 'OPENALEX',
  externalId: 'W1758913682',
  title: 'A Scalable Approximate Model Counter',
  dois: [`https://doi.org/${CP13_DOI}`],
  year: 2013,
  venue: 'Lecture Notes in Computer Science',
  typeFamily: 'CONFERENCE',
  authorNamesDisplay: 'Supratik Chakraborty, Kuldeep S. Meel, Moshe Y. Vardi',
  rawMetadata: { id: 'W1758913682', abstract_inverted_index: { a: [0] } },
};

const cp13Dblp: PublicationInput = {
  source: 'DBLP',
  externalId: 'conf/cp/ChakrabortyMV13',
  title: 'A Scalable Approximate Model Counter.',
  dois: [`https://doi.org/${CP13_DOI.toUpperCase()}`],
  year: 2013,
  venue: 'CP',
  typeFamily: 'CONFERENCE',
  authorNamesDisplay: 'Supratik Chakraborty; Kuldeep S. Meel; Moshe Y. Vardi',
};

describe('new records', () => {
  it('creates a canonical publication and source record with provenance', async () => {
    const seenAt = new Date('2026-09-01T00:00:00Z');
    const result = await ingest(cp13OpenAlex, { seenAt });

    expect(result).toMatchObject({ outcome: 'NEW_PUBLICATION', candidatesCreated: 0 });
    const publication = await prisma.publication.findUniqueOrThrow({ where: { id: result.publicationId } });
    expect(publication).toMatchObject({
      title: 'A Scalable Approximate Model Counter',
      normalizedTitle: 'a scalable approximate model counter',
      year: 2013,
      typeFamily: 'CONFERENCE',
      doi: CP13_DOI,
      authorNamesDisplay: 'Supratik Chakraborty, Kuldeep S. Meel, Moshe Y. Vardi',
      status: 'ACTIVE',
      isCurated: false,
    });

    const record = await prisma.publicationSourceRecord.findUniqueOrThrow({ where: { id: result.sourceRecordId } });
    expect(record).toMatchObject({
      source: 'OPENALEX',
      externalId: 'W1758913682',
      doi: CP13_DOI,
      matchMethod: 'NEW_PUBLICATION',
      matchDetail: 'No matching publication',
      authorNamesDisplay: 'Supratik Chakraborty, Kuldeep S. Meel, Moshe Y. Vardi',
      lastSeenAt: seenAt,
    });
    // Abstract stripped; the payload is kept and every normalized DOI is recorded (§6.5).
    expect(record.rawMetadata).toEqual({ id: 'W1758913682', [RAW_METADATA_DOIS_KEY]: [CP13_DOI] });
  });

  it('does not create professor relationships (later phases do)', async () => {
    await ingest(cp13OpenAlex);
    expect(await prisma.professorPublication.count()).toBe(0);
  });
});

describe('rule 1 — same source + external ID (idempotent reruns)', () => {
  it('updates the existing source record instead of creating another', async () => {
    const first = await ingest(cp13OpenAlex, { seenAt: new Date('2026-08-01') });
    const before = await counts();
    const later = new Date('2026-09-01');
    const second = await ingest({ ...cp13OpenAlex, venue: 'LNCS vol. 8124' }, { seenAt: later });

    expect(second).toMatchObject({
      outcome: 'UPDATED_EXISTING',
      publicationId: first.publicationId,
      sourceRecordId: first.sourceRecordId,
      candidatesCreated: 0,
    });
    expect(await counts()).toEqual(before);

    const record = await prisma.publicationSourceRecord.findUniqueOrThrow({ where: { id: first.sourceRecordId } });
    expect(record.venue).toBe('LNCS vol. 8124');
    expect(record.lastSeenAt).toEqual(later);
    expect(record.matchMethod).toBe('NEW_PUBLICATION'); // how it was originally attached
    expect((await prisma.publication.findUniqueOrThrow({ where: { id: first.publicationId } })).venue).toBe(
      'LNCS vol. 8124',
    );
  });

  it('produces an identical state when a whole batch is ingested twice', async () => {
    const batch = [cp13OpenAlex, cp13Dblp];
    for (const input of batch) await ingest(input);
    const once = await counts();
    for (const input of batch) await ingest(input);
    expect(await counts()).toEqual(once);
  });

  it('keeps last_seen_at unchanged when no observation time is given', async () => {
    const seenAt = new Date('2026-08-01');
    const { sourceRecordId } = await ingest(cp13OpenAlex, { seenAt });
    await ingest(cp13OpenAlex);
    expect((await prisma.publicationSourceRecord.findUniqueOrThrow({ where: { id: sourceRecordId } })).lastSeenAt).toEqual(
      seenAt,
    );
  });
});

describe('rule 2 — DOI', () => {
  it('merges the same DOI across OpenAlex, DBLP (uppercase DOI) and ORCID', async () => {
    const a = await ingest(cp13OpenAlex);
    const b = await ingest(cp13Dblp);
    const c = await ingest({
      source: 'ORCID',
      externalId: '0000-0002-0661-5773:123',
      title: 'A scalable approximate model counter',
      dois: [`doi:${CP13_DOI}`],
      year: 2013,
      typeFamily: 'CONFERENCE',
    });

    expect(b).toMatchObject({ outcome: 'MATCHED_DOI', publicationId: a.publicationId });
    expect(c).toMatchObject({ outcome: 'MATCHED_DOI', publicationId: a.publicationId });
    expect(await counts()).toEqual({ publications: 1, sourceRecords: 3, candidates: 0 });

    const dblpRecord = await prisma.publicationSourceRecord.findUniqueOrThrow({ where: { id: b.sourceRecordId } });
    expect(dblpRecord).toMatchObject({ matchMethod: 'DOI', matchDetail: `Matched on DOI ${CP13_DOI}` });
  });

  it('merges on DOI even when type labels and years disagree (decision #22)', async () => {
    const a = await ingest(cp13Dblp);
    const b = await ingest({ ...cp13OpenAlex, typeFamily: 'OTHER', year: 2015 });
    expect(b).toMatchObject({ outcome: 'MATCHED_DOI', publicationId: a.publicationId });
  });

  it('attaches in-source duplicates (two OpenAlex works with one DOI) to one publication', async () => {
    const doi = '10.1609/aaai.v33i01.33014731';
    const title = 'Learning to Solve NP-Complete Problems: A Graph Neural Network for Decision TSP';
    const first = await ingest({ source: 'OPENALEX', externalId: 'W2889619879', title, dois: [doi], year: 2019, typeFamily: 'CONFERENCE' });
    const second = await ingest({ source: 'OPENALEX', externalId: 'W2963382544', title, dois: [doi], year: 2019, typeFamily: 'OTHER' });

    expect(second).toMatchObject({ outcome: 'MATCHED_DOI', publicationId: first.publicationId });
    expect(await prisma.publicationSourceRecord.count({ where: { source: 'OPENALEX', publicationId: first.publicationId } })).toBe(2);
  });

  it('matches a DOI that only exists on a source record', async () => {
    // A publication whose canonical DOI slot is empty but whose source record carries the DOI.
    const publication = await prisma.publication.create({
      data: { title: 'Module Checking', normalizedTitle: 'module checking', year: 1996, typeFamily: 'CONFERENCE' },
    });
    await prisma.publicationSourceRecord.create({
      data: {
        publicationId: publication.id,
        source: 'OPENALEX',
        externalId: 'W2913425508',
        title: 'Module checking',
        normalizedTitle: 'module checking',
        doi: '10.1007/3-540-61474-5_59',
        year: 1996,
        typeFamily: 'CONFERENCE',
        matchMethod: 'NEW_PUBLICATION',
      },
    });

    const result = await ingest({
      source: 'DBLP',
      externalId: 'conf/cav/KupfermanV96',
      title: 'Module Checking.',
      dois: ['10.1007/3-540-61474-5_59'],
      year: 1996,
      typeFamily: 'CONFERENCE',
    });
    expect(result).toMatchObject({ outcome: 'MATCHED_DOI', publicationId: publication.id });
  });

  describe('secondary DOIs (§6.5)', () => {
    // A DBLP record reporting two DOIs (seen for ~0.5% of DBLP records): the first is primary.
    const PRIMARY = '10.1109/lics.1997.614950';
    const SECONDARY = '10.7146/brics.v4i5.18784';
    const dblpTwoDois: PublicationInput = {
      source: 'DBLP',
      externalId: 'conf/lics/EtessamiVW97',
      title: 'First-Order Logic with Two Variables and Unary Temporal Logic.',
      dois: [`https://doi.org/${PRIMARY.toUpperCase()}`, `https://doi.org/${SECONDARY}`],
      year: 1997,
      typeFamily: 'CONFERENCE',
      rawMetadata: { key: 'conf/lics/EtessamiVW97', ee: ['e1', 'e2'] },
    };

    it('keeps the first DOI in the doi column and every DOI in raw_metadata', async () => {
      const result = await ingest(dblpTwoDois);
      const record = await prisma.publicationSourceRecord.findUniqueOrThrow({ where: { id: result.sourceRecordId } });
      expect(record.doi).toBe(PRIMARY);
      expect(record.rawMetadata).toEqual({
        key: 'conf/lics/EtessamiVW97',
        ee: ['e1', 'e2'],
        [RAW_METADATA_DOIS_KEY]: [PRIMARY, SECONDARY],
      });
      expect((await prisma.publication.findUniqueOrThrow({ where: { id: result.publicationId } })).doi).toBe(PRIMARY);
    });

    it('matches an incoming DOI against a secondary DOI preserved in an existing source record', async () => {
      const existing = await ingest(dblpTwoDois);
      const incoming = await ingest({
        source: 'OPENALEX',
        externalId: 'W2616686541',
        title: 'First-order logic with two variables and unary temporal logic',
        dois: [SECONDARY],
        year: 1997,
        typeFamily: 'CONFERENCE',
      });

      expect(incoming).toMatchObject({ outcome: 'MATCHED_DOI', publicationId: existing.publicationId, candidatesCreated: 0 });
      const record = await prisma.publicationSourceRecord.findUniqueOrThrow({ where: { id: incoming.sourceRecordId } });
      expect(record.matchDetail).toBe(`Matched on DOI ${SECONDARY}`);
      expect(await prisma.publication.count()).toBe(1);
    });

    it('applies the contradiction checks to a secondary-DOI match', async () => {
      const existing = await ingest(dblpTwoDois);
      const wrong = await ingest({
        source: 'ORCID',
        externalId: '0000-0001-6554-8622:7',
        title: 'Diagnostic capabilities of a chatbot in ophthalmology',
        dois: [SECONDARY],
        year: 2024,
        typeFamily: 'JOURNAL',
      });
      expect(wrong).toMatchObject({ outcome: 'NEW_PUBLICATION', candidatesCreated: 1 });
      expect((await candidateBetween(existing.publicationId, wrong.publicationId))?.reason).toContain('unrelated titles');
    });

    it('lets a canonical DOI owner take precedence over a secondary-DOI carrier (decision #27)', async () => {
      const title = 'First-Order Logic with Two Variables and Unary Temporal Logic';
      const normalizedTitle = 'first order logic with two variables and unary temporal logic';
      // Carrier: SECONDARY appears only in a source record's raw_metadata.
      const carrier = await prisma.publication.create({
        data: { title, normalizedTitle, year: 1997, typeFamily: 'CONFERENCE', doi: PRIMARY },
      });
      await prisma.publicationSourceRecord.create({
        data: {
          publicationId: carrier.id,
          source: 'DBLP',
          externalId: 'conf/lics/EtessamiVW97',
          title,
          normalizedTitle,
          doi: PRIMARY,
          year: 1997,
          typeFamily: 'CONFERENCE',
          matchMethod: 'NEW_PUBLICATION',
          rawMetadata: { [RAW_METADATA_DOIS_KEY]: [PRIMARY, SECONDARY] },
        },
      });
      // Canonical owner: SECONDARY is its canonical DOI.
      const owner = await prisma.publication.create({
        data: { title, normalizedTitle, year: 2002, typeFamily: 'JOURNAL', doi: SECONDARY },
      });

      const incoming = await ingest({
        source: 'OPENALEX',
        externalId: 'W2492759008',
        title,
        dois: [SECONDARY],
        year: 1997,
        typeFamily: 'JOURNAL',
      });
      expect(incoming).toMatchObject({ outcome: 'MATCHED_DOI', publicationId: owner.id });
    });

    it('detects a DOI change on an existing record through secondary DOIs', async () => {
      const other = await ingest({
        source: 'DBLP',
        externalId: 'journals/x/Other',
        title: 'Another Paper Entirely Different',
        dois: ['10.1000/first', '10.1000/second'],
        year: 2000,
        typeFamily: 'JOURNAL',
      });
      const mine = await ingest(cp13OpenAlex);
      const updated = await ingest({ ...cp13OpenAlex, dois: ['10.1000/second'] });

      expect(updated).toMatchObject({ outcome: 'UPDATED_EXISTING', publicationId: mine.publicationId, candidatesCreated: 1 });
      expect(await candidateBetween(mine.publicationId, other.publicationId)).not.toBeNull();
    });

    it('does not add a DOI list when a record has no DOI', async () => {
      const result = await ingest({ ...cp13Dblp, dois: [], rawMetadata: { key: 'x' } });
      const record = await prisma.publicationSourceRecord.findUniqueOrThrow({ where: { id: result.sourceRecordId } });
      expect(record.rawMetadata).toEqual({ key: 'x' });
    });

    it('keeps a non-object payload intact under "payload"', async () => {
      const result = await ingest({ ...cp13Dblp, rawMetadata: ['a', 'b'] });
      const record = await prisma.publicationSourceRecord.findUniqueOrThrow({ where: { id: result.sourceRecordId } });
      expect(record.rawMetadata).toEqual({ payload: ['a', 'b'], [RAW_METADATA_DOIS_KEY]: [CP13_DOI] });
    });
  });

  describe('contradictions (decision #22)', () => {
    it('splits a record whose DOI matches but whose title is unrelated (incorrect DOI), keeping the canonical DOI with its owner', async () => {
      const owner = await ingest(cp13OpenAlex);
      const wrong = await ingest({
        source: 'ORCID',
        externalId: '0000-0001-6554-8622:999',
        title: 'Between-eye correlation of ocular parameters',
        dois: [CP13_DOI],
        year: 2024,
        typeFamily: 'JOURNAL',
      });

      expect(wrong).toMatchObject({ outcome: 'NEW_PUBLICATION', candidatesCreated: 1 });
      expect(wrong.publicationId).not.toBe(owner.publicationId);

      const split = await prisma.publication.findUniqueOrThrow({ where: { id: wrong.publicationId } });
      expect(split.doi).toBeNull(); // canonical DOI stays unique to its owner
      const splitRecord = await prisma.publicationSourceRecord.findUniqueOrThrow({ where: { id: wrong.sourceRecordId } });
      expect(splitRecord.doi).toBe(CP13_DOI); // provenance keeps the reported DOI
      expect(splitRecord.matchDetail).toContain('unrelated titles');

      const candidate = await candidateBetween(owner.publicationId, wrong.publicationId);
      expect(candidate).toMatchObject({ status: 'OPEN', reason: expect.stringContaining('DOI match blocked') });
    });

    it('prefers the canonical DOI owner over a split-off record carrying the same DOI (decision #27)', async () => {
      const owner = await ingest(cp13OpenAlex);
      await ingest({
        source: 'ORCID',
        externalId: '0000-0001-6554-8622:999',
        title: 'Between-eye correlation of ocular parameters',
        dois: [CP13_DOI],
        year: 2024,
        typeFamily: 'JOURNAL',
      });
      const third = await ingest(cp13Dblp);

      expect(third).toMatchObject({ outcome: 'MATCHED_DOI', publicationId: owner.publicationId, candidatesCreated: 0 });
    });

    it('splits preprint vs published sharing a DOI', async () => {
      const published = await ingest(cp13Dblp);
      const preprint = await ingest({ ...cp13OpenAlex, typeFamily: 'PREPRINT' });

      expect(preprint).toMatchObject({ outcome: 'NEW_PUBLICATION', candidatesCreated: 1 });
      const candidate = await candidateBetween(published.publicationId, preprint.publicationId);
      expect(candidate?.reason).toContain('preprint vs published');
    });

    it('does not guess when DOIs point to several publications', async () => {
      const x = await ingest({ ...cp13OpenAlex, externalId: 'W1', dois: ['10.1000/a'], title: 'Paper A about things' });
      const y = await ingest({ ...cp13OpenAlex, externalId: 'W2', dois: ['10.1000/b'], title: 'Paper B about things' });
      const both = await ingest({
        source: 'DBLP',
        externalId: 'journals/x/Both',
        title: 'Paper A about things',
        dois: ['10.1000/a', '10.1000/b'],
        year: 2013,
        typeFamily: 'CONFERENCE',
      });

      expect(both).toMatchObject({ outcome: 'NEW_PUBLICATION', candidatesCreated: 2 });
      expect(await candidateBetween(both.publicationId, x.publicationId)).not.toBeNull();
      expect(await candidateBetween(both.publicationId, y.publicationId)).not.toBeNull();
    });
  });
});

describe('rule 3 — exact normalized title + year ±1', () => {
  const moduleChecking = (overrides: Partial<PublicationInput> = {}): PublicationInput => ({
    source: 'DBLP',
    externalId: 'conf/cav/KupfermanV96',
    title: 'Module Checking.',
    year: 1996,
    typeFamily: 'CONFERENCE',
    ...overrides,
  });

  it('merges title variations (punctuation, case) with the same known type and year', async () => {
    const a = await ingest(moduleChecking());
    const b = await ingest(moduleChecking({ source: 'OPENALEX', externalId: 'W2913425508', title: 'Module checking' }));

    expect(b).toMatchObject({ outcome: 'MATCHED_TITLE_YEAR', publicationId: a.publicationId });
    const record = await prisma.publicationSourceRecord.findUniqueOrThrow({ where: { id: b.sourceRecordId } });
    expect(record.matchMethod).toBe('TITLE_YEAR');
  });

  it('merges when years differ by exactly 1', async () => {
    const a = await ingest(moduleChecking());
    const b = await ingest(moduleChecking({ source: 'OPENALEX', externalId: 'W1', year: 1997 }));
    expect(b.publicationId).toBe(a.publicationId);
  });

  it('creates a candidate instead of merging when years differ by 2', async () => {
    const a = await ingest(moduleChecking());
    const b = await ingest(moduleChecking({ source: 'OPENALEX', externalId: 'W1', year: 1998 }));
    expect(b).toMatchObject({ outcome: 'NEW_PUBLICATION', candidatesCreated: 1 });
    expect((await candidateBetween(a.publicationId, b.publicationId))?.reason).toContain('years differ');
  });

  it('creates a candidate when a year is missing', async () => {
    const a = await ingest(moduleChecking());
    const b = await ingest(moduleChecking({ source: 'ORCID', externalId: 'o:1', year: null }));
    expect(b.publicationId).not.toBe(a.publicationId);
    expect((await candidateBetween(a.publicationId, b.publicationId))?.reason).toContain('year unknown');
  });

  it('keeps conference and journal versions apart (different DOIs, years, types)', async () => {
    const conference = await ingest(moduleChecking({ dois: ['10.1007/3-540-61474-5_59'] }));
    const journal = await ingest({
      source: 'DBLP',
      externalId: 'journals/iandc/KupfermanVW01',
      title: 'Module Checking.',
      dois: ['10.1006/INCO.2000.2893'],
      year: 2001,
      typeFamily: 'JOURNAL',
    });

    expect(journal.publicationId).not.toBe(conference.publicationId);
    const reason = (await candidateBetween(conference.publicationId, journal.publicationId))?.reason ?? '';
    expect(reason).toContain('incompatible type families');
    expect(reason).toContain('different DOIs');
  });

  it('keeps a DBLP CoRR preprint (no DOI) apart from the published paper with the same title and year', async () => {
    const published = await ingest(cp13Dblp);
    const corr = await ingest({
      source: 'DBLP',
      externalId: 'journals/corr/ChakrabortyMV13',
      title: 'A Scalable Approximate Model Counter.',
      year: 2013,
      venue: 'CoRR',
      typeFamily: 'PREPRINT',
    });

    expect(corr).toMatchObject({ outcome: 'NEW_PUBLICATION', candidatesCreated: 1 });
    expect((await candidateBetween(published.publicationId, corr.publicationId))?.reason).toContain('preprint vs published');
  });

  it('merges two preprints of the same work (OpenAlex arXiv + DBLP CoRR)', async () => {
    const arxiv = await ingest({
      source: 'OPENALEX',
      externalId: 'W2951782995',
      title: 'A Scalable Approximate Model Counter',
      dois: ['10.48550/arxiv.1306.5726'],
      year: 2013,
      typeFamily: 'PREPRINT',
    });
    const corr = await ingest({
      source: 'DBLP',
      externalId: 'journals/corr/ChakrabortyMV13',
      title: 'A Scalable Approximate Model Counter.',
      year: 2013,
      typeFamily: 'PREPRINT',
    });
    expect(corr).toMatchObject({ outcome: 'MATCHED_TITLE_YEAR', publicationId: arxiv.publicationId });
  });

  it('never auto-merges on title when a type family is OTHER', async () => {
    const a = await ingest(moduleChecking());
    const b = await ingest(moduleChecking({ source: 'OPENALEX', externalId: 'W1', typeFamily: 'OTHER' }));
    expect(b.publicationId).not.toBe(a.publicationId);
    expect((await candidateBetween(a.publicationId, b.publicationId))?.reason).toContain('type family unknown');
  });

  it('never auto-merges generic titles, but records them as candidates (decision #24)', async () => {
    const editorial = { title: 'Editorial', year: 2020, typeFamily: 'JOURNAL' as const };
    const a = await ingest({ source: 'OPENALEX', externalId: 'W10', ...editorial });
    const b = await ingest({ source: 'DBLP', externalId: 'journals/x/Ed20', ...editorial });
    expect(b.publicationId).not.toBe(a.publicationId);
    expect((await candidateBetween(a.publicationId, b.publicationId))?.reason).toContain('generic or too-short title');
  });

  it('does not guess when several publications qualify', async () => {
    // Two existing conference papers with this exact title (distinct DOIs, same year).
    const x = await ingest({ ...cp13OpenAlex, externalId: 'W1', dois: ['10.1000/x'] });
    const y = await ingest({ ...cp13OpenAlex, externalId: 'W2', dois: ['10.1000/y'] });
    const noDoi = await ingest({ ...cp13Dblp, dois: [] });

    expect(noDoi).toMatchObject({ outcome: 'NEW_PUBLICATION', candidatesCreated: 2 });
    expect((await candidateBetween(noDoi.publicationId, x.publicationId))?.reason).toContain('ambiguous');
    expect(await candidateBetween(noDoi.publicationId, y.publicationId)).not.toBeNull();
  });

  it('creates a new publication without candidates when nothing matches', async () => {
    await ingest(cp13OpenAlex);
    const other = await ingest(moduleChecking());
    expect(other).toMatchObject({ outcome: 'NEW_PUBLICATION', candidatesCreated: 0 });
  });
});

describe('DOI changes on an existing source record (§8.3)', () => {
  it('never moves the record; creates a candidate instead', async () => {
    const x = await ingest(cp13OpenAlex);
    const y = await ingest({
      source: 'ORCID',
      externalId: '0000-0002-0661-5773:5',
      title: 'Module Checking',
      dois: ['10.1006/inco.2000.2893'],
      year: 2001,
      typeFamily: 'JOURNAL',
    });

    // OpenAlex now reports the journal DOI for its CP work.
    const updated = await ingest({ ...cp13OpenAlex, dois: ['10.1006/inco.2000.2893'] });

    expect(updated).toMatchObject({ outcome: 'UPDATED_EXISTING', publicationId: x.publicationId, candidatesCreated: 1 });
    expect((await candidateBetween(x.publicationId, y.publicationId))?.reason).toContain('belongs to another publication');
    // The canonical DOI of x cannot take y's DOI.
    expect((await prisma.publication.findUniqueOrThrow({ where: { id: x.publicationId } })).doi).toBeNull();
  });

  it('never reopens or duplicates a dismissed candidate', async () => {
    const owner = await ingest(cp13OpenAlex);
    const wrongInput: PublicationInput = {
      source: 'ORCID',
      externalId: '0000-0001-6554-8622:999',
      title: 'Between-eye correlation of ocular parameters',
      dois: [CP13_DOI],
      year: 2024,
      typeFamily: 'JOURNAL',
    };
    const wrong = await ingest(wrongInput);
    const candidate = (await candidateBetween(owner.publicationId, wrong.publicationId))!;
    await prisma.duplicateCandidate.update({ where: { id: candidate.id }, data: { status: 'DISMISSED' } });

    const rerun = await ingest(wrongInput);
    expect(rerun.candidatesCreated).toBe(0);
    expect(await prisma.duplicateCandidate.count()).toBe(1);
    expect((await prisma.duplicateCandidate.findUniqueOrThrow({ where: { id: candidate.id } })).status).toBe('DISMISSED');
  });
});

describe('canonical metadata (§9)', () => {
  it('lets OpenAlex metadata replace DBLP metadata when OpenAlex arrives later', async () => {
    const a = await ingest(cp13Dblp);
    expect((await prisma.publication.findUniqueOrThrow({ where: { id: a.publicationId } })).title).toBe(
      'A Scalable Approximate Model Counter.',
    );

    await ingest(cp13OpenAlex);
    const publication = await prisma.publication.findUniqueOrThrow({ where: { id: a.publicationId } });
    expect(publication.title).toBe('A Scalable Approximate Model Counter');
    expect(publication.venue).toBe('Lecture Notes in Computer Science');
    expect(publication.authorNamesDisplay).toBe('Supratik Chakraborty, Kuldeep S. Meel, Moshe Y. Vardi');
  });

  it('never recomputes a curated publication', async () => {
    const a = await ingest(cp13Dblp);
    await prisma.publication.update({
      where: { id: a.publicationId },
      data: { isCurated: true, title: 'Curated Title', venue: 'Curated Venue' },
    });

    await ingest(cp13OpenAlex);
    const publication = await prisma.publication.findUniqueOrThrow({ where: { id: a.publicationId } });
    expect(publication).toMatchObject({ title: 'Curated Title', venue: 'Curated Venue' });
    expect(await prisma.publicationSourceRecord.count({ where: { publicationId: a.publicationId } })).toBe(2);
  });

  it('reports ACTIVE for ordinary publications', async () => {
    expect((await ingest(cp13OpenAlex)).publicationStatus).toBe('ACTIVE');
  });
});

describe('SUPPRESSED publications (§6.4, §14; decision #30)', () => {
  async function suppressedPublication() {
    const a = await ingest(cp13OpenAlex);
    const professor = await prisma.professor.create({ data: { name: 'Prof' } });
    await prisma.professorPublication.create({
      data: { professorId: professor.id, publicationId: a.publicationId, origin: 'DISCOVERED', status: 'REJECTED' },
    });
    await prisma.publication.update({ where: { id: a.publicationId }, data: { status: 'SUPPRESSED' } });
    return a;
  }

  it('absorbs a matching record (DOI) as provenance only: stays hidden, no new publication, no new link', async () => {
    const a = await suppressedPublication();
    const b = await ingest(cp13Dblp);

    expect(b).toMatchObject({ outcome: 'MATCHED_DOI', publicationId: a.publicationId, publicationStatus: 'SUPPRESSED' });
    expect((await prisma.publication.findUniqueOrThrow({ where: { id: a.publicationId } })).status).toBe('SUPPRESSED');
    expect(await prisma.publication.count()).toBe(1); // the suppressed paper does not reappear as a new publication
    expect(await prisma.professorPublication.count()).toBe(1); // no professor link created
    expect(await prisma.publicationSourceRecord.count({ where: { publicationId: a.publicationId } })).toBe(2);
  });

  it('absorbs a matching record by title + year as well', async () => {
    const a = await suppressedPublication();
    const b = await ingest({ ...cp13Dblp, dois: [] });
    expect(b).toMatchObject({ outcome: 'MATCHED_TITLE_YEAR', publicationId: a.publicationId, publicationStatus: 'SUPPRESSED' });
    expect(await prisma.publication.count()).toBe(1);
  });

  it('reports SUPPRESSED on reruns of an absorbed record', async () => {
    const a = await suppressedPublication();
    await ingest(cp13Dblp);
    const rerun = await ingest(cp13Dblp);
    expect(rerun).toMatchObject({ outcome: 'UPDATED_EXISTING', publicationId: a.publicationId, publicationStatus: 'SUPPRESSED' });
  });
});

describe('manual records use the same pipeline (§12)', () => {
  const manual = (overrides: Partial<PublicationInput> = {}): PublicationInput => ({
    source: 'MANUAL',
    externalId: '6f1f5c3e-1b1e-4a8e-9c1d-000000000001',
    title: 'A scalable approximate model counter',
    year: 2013,
    typeFamily: 'CONFERENCE',
    ...overrides,
  });

  it('records the entering user on a MANUAL source record', async () => {
    const user = await prisma.user.create({ data: { email: 'prof@example.edu', passwordHash: 'x', role: 'PROFESSOR' } });
    const result = await ingest(manual(), { createdByUserId: user.id });
    const record = await prisma.publicationSourceRecord.findUniqueOrThrow({ where: { id: result.sourceRecordId } });
    expect(record).toMatchObject({ source: 'MANUAL', createdByUserId: user.id, lastSeenAt: null });
  });

  it('links a manual entry to an existing publication by DOI', async () => {
    const api = await ingest(cp13OpenAlex);
    const result = await ingest(manual({ dois: [CP13_DOI] }));
    expect(result).toMatchObject({ outcome: 'MATCHED_DOI', publicationId: api.publicationId });
  });

  it('flags (does not merge) an API record sharing a manual DOI when the manual title is unrelated', async () => {
    const m = await ingest(manual({ dois: [CP13_DOI], title: 'Scalable approx model counter (my typing)', venue: 'CP' }));
    const api = await ingest({ ...cp13OpenAlex, title: 'A Scalable Approximate Model Counter' });

    // Titles are unrelated ("approx" vs "approximate"), so the DOI match is blocked: a candidate, not a silent duplicate.
    expect(api.publicationId).not.toBe(m.publicationId);
    expect(await candidateBetween(m.publicationId, api.publicationId)).not.toBeNull();
  });

  it('merges a later API discovery into a manual publication (DOI, related title)', async () => {
    const m = await ingest(manual({ dois: [CP13_DOI] }));
    const api = await ingest(cp13OpenAlex);

    expect(api).toMatchObject({ outcome: 'MATCHED_DOI', publicationId: m.publicationId });
    const publication = await prisma.publication.findUniqueOrThrow({ where: { id: m.publicationId } });
    expect(publication.title).toBe('A Scalable Approximate Model Counter'); // MANUAL is the last fallback
    expect(await counts()).toEqual({ publications: 1, sourceRecords: 2, candidates: 0 });
  });

  it('merges a later API discovery into a manual publication without DOI (title + year + type)', async () => {
    const m = await ingest(manual());
    const api = await ingest(cp13Dblp);
    expect(api).toMatchObject({ outcome: 'MATCHED_TITLE_YEAR', publicationId: m.publicationId });
  });

  it('flags an uncertain manual entry as a candidate rather than silently duplicating it', async () => {
    const api = await ingest(cp13Dblp);
    const m = await ingest(manual({ year: null }));
    expect(m).toMatchObject({ outcome: 'NEW_PUBLICATION', candidatesCreated: 1 });
    expect(await candidateBetween(api.publicationId, m.publicationId)).not.toBeNull();
  });
});
