import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { PublicationSource, TypeFamily } from '@prisma/client';
import { prisma } from '../../src/config/database';
import { ingestDiscoveredRecords } from '../../src/services/discovery/ingestDiscoveredRecords';
import { ingestPublication } from '../../src/services/matching/engine';
import { buildNormalizedPublication, PublicationInput } from '../../src/services/normalization/normalizedPublication';
import { resetDatabase } from '../helpers/database';

/*
 * Decision #27 exception (#136): when the publication that owns a DOI canonically is refused by the
 * #22 contradiction checks, publications carrying the DOI only on a source record are evaluated with
 * the same checks — exactly one qualifying → attach; several → no merge, candidates (#24); none →
 * unchanged behaviour. Synthetic records only.
 */

const DOI = '10.5555/owner.exception';
const TITLE = 'Owner Exception Study of Synthetic Records';

function input(source: PublicationSource, externalId: string, fields: { title: string; doi?: string | null; year?: number; typeFamily?: TypeFamily }): PublicationInput {
  return {
    source,
    externalId,
    title: fields.title,
    dois: fields.doi ? [fields.doi] : [],
    year: fields.year ?? 2021,
    venue: null,
    typeFamily: fields.typeFamily ?? 'JOURNAL',
    authorNamesDisplay: null,
    rawMetadata: { synthetic: true },
  };
}
const ingest = (i: PublicationInput) => ingestPublication(buildNormalizedPublication(i));
/** The wrong-DOI record: the genuine paper's DOI under an unrelated title. */
const wrong = (externalId = 'orcid:1') => ingest(input('ORCID', externalId, { title: 'An unrelated self-reported work about compilers', doi: DOI }));

async function candidatePairs() {
  return (await prisma.duplicateCandidate.findMany()).map((c) => [c.publicationAId, c.publicationBId].sort().join()).sort();
}
const pair = (x: string, y: string) => [x, y].sort().join();

beforeEach(async () => {
  await resetDatabase();
});

afterAll(async () => {
  await resetDatabase();
  await prisma.$disconnect();
});

describe('decision #27 exception', () => {
  it('exactly one qualifying source-record owner: later records of the genuine paper attach to it by DOI', async () => {
    const x = await wrong();
    const first = await ingest(input('OPENALEX', 'W1', { title: TITLE, doi: DOI }));
    expect(first.outcome).toBe('NEW_PUBLICATION'); // refused against the canonical owner (#22), as before
    expect((await prisma.publication.findUniqueOrThrow({ where: { id: first.publicationId } })).doi).toBeNull(); // DOI already canonical elsewhere

    for (const [source, externalId, title] of [['DBLP', 'journals/x/Y21', `${TITLE}.`], ['SCOPUS', '2-s2.0-1', TITLE.toUpperCase()], ['WOS', 'WOS:000000000000001', TITLE]] as const) {
      const result = await ingest(input(source, externalId, { title, doi: DOI }));
      expect(result, source).toMatchObject({ outcome: 'MATCHED_DOI', publicationId: first.publicationId, candidatesCreated: 0 });
      const record = await prisma.publicationSourceRecord.findUniqueOrThrow({ where: { id: result.sourceRecordId } });
      expect(record.matchMethod).toBe('DOI');
      expect(record.matchDetail).toBe(
        `Matched on DOI ${DOI} carried by a source record (the DOI's canonical publication was refused: same DOI but unrelated titles (possible incorrect DOI))`,
      );
    }
    expect(await prisma.publication.count()).toBe(2);
    expect(await candidatePairs()).toEqual([pair(x.publicationId, first.publicationId)]);
    // The wrong-DOI publication received nothing (#22 not weakened).
    expect(await prisma.publicationSourceRecord.count({ where: { publicationId: x.publicationId } })).toBe(1);
  });

  it('a DOI match with the canonical owner still takes precedence (the exception applies only after a refusal)', async () => {
    const canonical = await ingest(input('OPENALEX', 'W1', { title: TITLE, doi: DOI }));
    // A publication of a related title that carries the DOI only on a source record (via a later DOI change, §8.3).
    const other = await ingest(input('DBLP', 'conf/x/Y21', { title: `${TITLE} extended`, year: 2021, typeFamily: 'CONFERENCE' }));
    await ingest(input('DBLP', 'conf/x/Y21', { title: `${TITLE} extended`, doi: DOI, year: 2021, typeFamily: 'CONFERENCE' }));
    const result = await ingest(input('SCOPUS', '2-s2.0-1', { title: TITLE, doi: DOI }));
    expect(result).toMatchObject({ outcome: 'MATCHED_DOI', publicationId: canonical.publicationId });
    expect(result.publicationId).not.toBe(other.publicationId);
  });

  it('several qualifying source-record owners: nothing is merged; every possible match becomes a candidate (#24)', async () => {
    // Two publications of the genuine title, kept apart by type (a title match never merges across
    // known families), each of whose source records later reports the DOI (rule 1 keeps them in place).
    const p = await ingest(input('OPENALEX', 'W1', { title: TITLE, year: 2021, typeFamily: 'JOURNAL' }));
    const q = await ingest(input('SCOPUS', '2-s2.0-1', { title: TITLE, year: 2021, typeFamily: 'BOOK_CHAPTER' }));
    const x = await wrong();
    await ingest(input('OPENALEX', 'W1', { title: TITLE, doi: DOI, year: 2021, typeFamily: 'JOURNAL' }));
    await ingest(input('SCOPUS', '2-s2.0-1', { title: TITLE, doi: DOI, year: 2021, typeFamily: 'BOOK_CHAPTER' }));
    expect((await prisma.publication.findUniqueOrThrow({ where: { id: x.publicationId } })).doi).toBe(DOI);

    const result = await ingest(input('WOS', 'WOS:000000000000001', { title: TITLE, doi: DOI }));
    expect(result.outcome).toBe('NEW_PUBLICATION');
    expect([p.publicationId, q.publicationId, x.publicationId]).not.toContain(result.publicationId);
    const pairs = await candidatePairs();
    for (const id of [p.publicationId, q.publicationId, x.publicationId]) expect(pairs).toContain(pair(result.publicationId, id));
    const record = await prisma.publicationSourceRecord.findUniqueOrThrow({ where: { id: result.sourceRecordId } });
    expect(record.matchDetail).toBe(
      `No automatic match: DOI match blocked (same DOI but unrelated titles (possible incorrect DOI)) and DOI(s) ${DOI} match 2 publications through their source records`,
    );
  });

  it('no qualifying source-record owner (unrelated title or preprint): unchanged behaviour', async () => {
    const x = await wrong();
    // Another unrelated title with the same DOI, and a preprint of the genuine title with the same DOI.
    const y = await ingest(input('DBLP', 'journals/x/Z', { title: 'A second unrelated paper on scheduling theory', doi: DOI }));
    const pre = await ingest(input('DBLP', 'journals/corr/abs-1', { title: TITLE, doi: DOI, typeFamily: 'PREPRINT' }));
    expect(new Set([x.publicationId, y.publicationId, pre.publicationId]).size).toBe(3);

    const result = await ingest(input('WOS', 'WOS:000000000000001', { title: TITLE, doi: DOI }));
    expect(result.outcome).toBe('NEW_PUBLICATION');
    expect([x.publicationId, y.publicationId, pre.publicationId]).not.toContain(result.publicationId);
    const record = await prisma.publicationSourceRecord.findUniqueOrThrow({ where: { id: result.sourceRecordId } });
    expect(record.matchDetail).toBe('No automatic match: DOI match blocked (same DOI but unrelated titles (possible incorrect DOI))');
    const pairs = await candidatePairs();
    expect(pairs).toContain(pair(result.publicationId, x.publicationId)); // the refused canonical owner, as before
    expect(pairs).toContain(pair(result.publicationId, pre.publicationId)); // the exact-title preprint, as before
    expect(pairs).not.toContain(pair(result.publicationId, y.publicationId));
  });

  it('a record with an unrelated title is never attached through the exception (#22)', async () => {
    await wrong();
    const genuine = await ingest(input('OPENALEX', 'W1', { title: TITLE, doi: DOI }));
    const unrelated = await ingest(input('SCOPUS', '2-s2.0-1', { title: 'Yet another unrelated title about databases', doi: DOI }));
    expect(unrelated.outcome).toBe('NEW_PUBLICATION');
    expect(unrelated.publicationId).not.toBe(genuine.publicationId);
  });

  it('keeps the professor’s decisions and every provider’s provenance', async () => {
    const professor = await prisma.professor.create({ data: { name: 'Prof Exception' } });
    const identity = await prisma.externalIdentity.create({ data: { professorId: professor.id, source: 'WOS', externalId: 'ZZZ-0001-2020' } });
    const x = await wrong();
    const genuine = await ingest(input('OPENALEX', 'W1', { title: TITLE, doi: DOI }));
    const decidedAt = new Date('2026-10-01T00:00:00.000Z');
    await prisma.professorPublication.createMany({
      data: [
        { professorId: professor.id, publicationId: genuine.publicationId, status: 'REJECTED', origin: 'DISCOVERED', decidedAt },
        { professorId: professor.id, publicationId: x.publicationId, status: 'APPROVED', origin: 'DISCOVERED', decidedAt },
      ],
    });

    const summary = await ingestDiscoveredRecords({ id: identity.id, professorId: professor.id }, [input('WOS', 'WOS:000000000000001', { title: TITLE, doi: DOI })], {
      seenAt: new Date('2026-11-01T00:00:00.000Z'),
    });
    expect(summary).toMatchObject({ recordsNew: 1, linksCreated: 0, candidatesCreated: 0 });
    const links = await prisma.professorPublication.findMany({ where: { professorId: professor.id } });
    expect(links.find((l) => l.publicationId === genuine.publicationId)).toMatchObject({ status: 'REJECTED', decidedAt });
    expect(links.find((l) => l.publicationId === x.publicationId)).toMatchObject({ status: 'APPROVED', decidedAt });
    const records = await prisma.publicationSourceRecord.findMany({ where: { publicationId: genuine.publicationId }, orderBy: { source: 'asc' } });
    expect(records.map((r) => [r.source, r.externalId, r.doi])).toEqual([
      ['OPENALEX', 'W1', DOI],
      ['WOS', 'WOS:000000000000001', DOI],
    ]);
  });
});
