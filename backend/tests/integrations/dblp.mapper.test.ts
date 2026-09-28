import { beforeAll, describe, expect, it } from 'vitest';
import { DblpClient } from '../../src/integrations/dblp/client';
import { dblpRecordType, mapDblpPublication } from '../../src/integrations/dblp/mapper';
import type { DblpPublication } from '../../src/integrations/dblp/types';
import { buildNormalizedPublication } from '../../src/services/normalization/normalizedPublication';
import { loadFixture, noSleep, replayFetch } from '../helpers/fixtures';

let publications: DblpPublication[];
const byKey = (key: string) => publications.find((p) => p.publication === `https://dblp.org/rec/${key}`)!;
const map = (key: string) => mapDblpPublication(byKey(key));

beforeAll(async () => {
  const replay = replayFetch(['identity-person', 'records-person', 'authors-person'].map((n) => loadFixture('dblp', n)));
  const client = new DblpClient({ deps: { fetchImpl: replay.fetchImpl, sleep: noSleep } });
  ({ publications } = await client.fetchPersonPublications('v/MosheYVardi'));
});

describe('dblpRecordType', () => {
  it('uses the dblp class, not bibtexType (CoRR preprints have bibtexType Article)', () => {
    const corr = byKey('journals/corr/ChakrabortyMV13');
    expect(corr.bibtexType).toBe('http://purl.org/net/nknouf/ns/bibtex#Article');
    expect(dblpRecordType(corr)).toBe('Informal');
  });

  it('falls back to bibtexType when no specific class is present', () => {
    expect(dblpRecordType({ types: ['https://dblp.org/rdf/schema#Publication'], bibtexType: 'http://purl.org/net/nknouf/ns/bibtex#Inproceedings' })).toBe(
      'http://purl.org/net/nknouf/ns/bibtex#Inproceedings',
    );
  });
});

describe('mapDblpPublication — recorded records', () => {
  it('maps a conference paper: key, title, year, DOI, venue, ordered authors', () => {
    expect(map('conf/cp/ChakrabortyMV13')).toMatchObject({
      source: 'DBLP',
      externalId: 'conf/cp/ChakrabortyMV13',
      title: 'A Scalable Approximate Model Counter.',
      year: 2013,
      dois: ['https://doi.org/10.1007/978-3-642-40627-0_18'],
      venue: 'CP',
      typeFamily: 'CONFERENCE',
      authorNamesDisplay: 'Supratik Chakraborty, Kuldeep S. Meel, Moshe Y. Vardi',
    });
  });

  it('maps a CoRR record (Informal under journals/corr/) to PREPRINT', () => {
    expect(map('journals/corr/ChakrabortyMV13')).toMatchObject({ typeFamily: 'PREPRINT', dois: [], venue: 'CoRR' });
    expect(map('journals/corr/abs-2003-00330').typeFamily).toBe('PREPRINT');
  });

  it('maps published EPTCS/LMCS papers filed under journals/corr/ by their class (decision #40)', () => {
    const eptcs = ['abs-1106-1228', 'abs-2005-09125', 'abs-2008-06790', 'abs-2009-10875', 'abs-2009-10883', 'FogartyKVW13'];
    const lmcs = ['abs-1110-6183', 'abs-1302-2675', 'MogaveroMPV16', 'NainLV14', 'TsaiFVT14'];
    for (const key of eptcs) expect(map(`journals/corr/${key}`).typeFamily, key).toBe('CONFERENCE');
    for (const key of lmcs) expect(map(`journals/corr/${key}`).typeFamily, key).toBe('JOURNAL');
  });

  it('maps Informal records outside CoRR (Dagstuhl seminar items) to OTHER (decision #40)', () => {
    const dagstuhl = [
      'conf/dagstuhl/DowneyKKLV07',
      'conf/dagstuhl/DowneyKKLV07a',
      'conf/dagstuhl/KautzTV05',
      'conf/dagstuhl/KautzTV05a',
      'journals/dagstuhl-reports/MehlhornVH12',
      'journals/dagstuhl-reports/RehofV14',
    ];
    for (const key of dagstuhl) {
      expect(dblpRecordType(byKey(key)), key).toBe('Informal');
      expect(map(key).typeFamily, key).toBe('OTHER');
    }
  });

  it('classifies every real CoRR preprint as PREPRINT and nothing else', () => {
    const preprints = publications.filter((p) => mapDblpPublication(p).typeFamily === 'PREPRINT');
    expect(preprints).toHaveLength(97);
    for (const p of preprints) {
      expect(p.publication).toContain('/journals/corr/');
      expect(dblpRecordType(p)).toBe('Informal');
    }
  });

  it('maps journal articles, chapters, books and data', () => {
    expect(map('journals/jcss/VardiW86').typeFamily).toBe('JOURNAL');
    const families = new Map(publications.map((p) => [dblpRecordType(p), mapDblpPublication(p).typeFamily]));
    expect(families.get('Incollection')).toBe('BOOK_CHAPTER');
    expect(families.get('Book')).toBe('BOOK');
    expect(families.get('Data')).toBe('OTHER');
  });

  it('keeps every DOI of a multi-DOI record; the first (sorted) becomes primary', () => {
    const record = buildNormalizedPublication(map('conf/popl/CookGPRV07'));
    expect(record.dois).toEqual(['10.1145/1190215.1190257', '10.1145/1190216.1190257']);
  });

  it('lowercases DBLP uppercase DOIs through the shared normalizer', () => {
    const record = buildNormalizedPublication(map('conf/aaai/ChakrabortyFMSV14'));
    expect(record.dois).toEqual(['10.1609/aaai.v28i1.8990']);
  });

  it('normalizes the DBLP trailing period away while keeping the display title', () => {
    const record = buildNormalizedPublication(map('conf/cp/ChakrabortyMV13'));
    expect(record.title).toBe('A Scalable Approximate Model Counter.');
    expect(record.normalizedTitle).toBe('a scalable approximate model counter');
  });

  it('stores the dblp record fields as raw metadata', () => {
    expect(map('conf/cp/ChakrabortyMV13').rawMetadata).toMatchObject({
      key: 'conf/cp/ChakrabortyMV13',
      uri: 'https://dblp.org/rec/conf/cp/ChakrabortyMV13',
      bibtexType: 'http://purl.org/net/nknouf/ns/bibtex#Inproceedings',
      authors: ['Supratik Chakraborty', 'Kuldeep S. Meel', 'Moshe Y. Vardi'],
    });
  });

  it('maps and normalizes all 830 recorded records', () => {
    const families: Record<string, number> = {};
    for (const publication of publications) {
      const record = buildNormalizedPublication(mapDblpPublication(publication));
      expect(record.externalId).toMatch(/^[a-z]+\/[^/]+\/.+/);
      families[record.typeFamily] = (families[record.typeFamily] ?? 0) + 1;
    }
    expect(families).toEqual({ CONFERENCE: 437, JOURNAL: 277, PREPRINT: 97, BOOK_CHAPTER: 8, BOOK: 3, OTHER: 8 });
  });
});
