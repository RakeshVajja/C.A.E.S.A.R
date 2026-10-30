import { describe, expect, it } from 'vitest';
import { mapScopusDocument, scopusCitationCount } from '../../src/integrations/scopus/mapper';
import { scopusTypeFamily } from '../../src/integrations/scopus/typeFamily';
import { ScopusSearchEntrySchema } from '../../src/integrations/scopus/types';
import { buildNormalizedPublication, NormalizationError } from '../../src/services/normalization/normalizedPublication';
import { scopusEntry } from '../fixtures/scopus/synthetic';

/* Scopus mapping (stage 15.3) — synthetic entries only. */

const entry = (n: number, overrides: Record<string, unknown> = {}) => ScopusSearchEntrySchema.parse(scopusEntry(n, overrides));

describe('mapScopusDocument', () => {
  it('maps the STANDARD-view fields into a normalized publication', () => {
    const normalized = buildNormalizedPublication(mapScopusDocument(entry(1, { 'prism:doi': 'https://doi.org/10.5555/SYNTHETIC.1' })));
    expect(normalized).toMatchObject({
      source: 'SCOPUS',
      externalId: '2-s2.0-85000000001',
      title: 'Synthetic Scopus study number 1 on deterministic matching',
      normalizedTitle: 'synthetic scopus study number 1 on deterministic matching',
      dois: ['10.5555/synthetic.1'],
      year: 2021,
      venue: 'Journal of Synthetic Results',
      typeFamily: 'JOURNAL',
      isPreprint: false,
    });
  });

  it('does not build an author list from the first author alone (STANDARD view)', () => {
    const normalized = buildNormalizedPublication(mapScopusDocument(entry(1)));
    expect(normalized.authorNamesDisplay).toBeNull();
    expect((normalized.rawMetadata as Record<string, unknown>)['dc:creator']).toBe('Verma A.'); // kept as provenance
  });

  it('uses a complete author array when one is present (COMPLETE view)', () => {
    const complete = entry(1, { author: [{ authid: '57000000001', authname: 'Verma A.' }, { authid: '57000000009', authname: 'Rao S.' }] });
    expect(mapScopusDocument(complete).authorNamesDisplay).toBe('Verma A., Rao S.');
  });

  it('keeps ISSN, eISSN, cited-by count and source details in raw metadata, without abstracts', () => {
    const raw = buildNormalizedPublication(mapScopusDocument(entry(2, { 'dc:description': 'synthetic abstract text' }))).rawMetadata as Record<string, unknown>;
    expect(raw).toMatchObject({ 'prism:issn': '12345678', 'prism:eIssn': '87654321', 'citedby-count': '6', 'source-id': '21100000000' });
    expect(raw).not.toHaveProperty('dc:description');
  });

  it('handles missing optional values without inventing them', () => {
    const sparse = buildNormalizedPublication(
      mapScopusDocument(entry(3, { 'prism:doi': undefined, 'prism:coverDate': null, 'prism:publicationName': undefined, subtype: undefined })),
    );
    expect(sparse).toMatchObject({ dois: [], year: null, venue: null, typeFamily: 'OTHER' });
  });

  it('a document without a title cannot be normalized and is skipped by ingestion', () => {
    expect(() => buildNormalizedPublication(mapScopusDocument(entry(4, { 'dc:title': undefined })))).toThrow(NormalizationError);
  });

  it('reads the year only from a well-formed cover date', () => {
    expect(mapScopusDocument(entry(1, { 'prism:coverDate': '2019-12-31' })).year).toBe(2019);
    expect(mapScopusDocument(entry(1, { 'prism:coverDate': '2019' })).year).toBe(2019);
    expect(mapScopusDocument(entry(1, { 'prism:coverDate': 'Dec 2019' })).year).toBeNull();
  });
});

describe('scopusTypeFamily', () => {
  it('combines the document subtype with the source aggregation type', () => {
    const cases: [string | null, string | null, string][] = [
      ['ar', 'Journal', 'JOURNAL'],
      ['re', 'Journal', 'JOURNAL'],
      ['ar', 'Conference Proceeding', 'CONFERENCE'],
      ['cp', 'Conference Proceeding', 'CONFERENCE'],
      ['cp', 'Journal', 'CONFERENCE'],
      ['ar', 'Book Series', 'OTHER'],
      ['ar', 'Trade Journal', 'OTHER'],
      ['ch', 'Book', 'BOOK_CHAPTER'],
      ['bk', 'Book', 'BOOK'],
      ['ed', 'Journal', 'OTHER'],
      ['le', 'Journal', 'OTHER'],
      ['er', 'Journal', 'OTHER'],
      ['cr', 'Conference Proceeding', 'OTHER'],
      [null, 'Journal', 'OTHER'],
    ];
    for (const [subtype, aggregationType, family] of cases) {
      expect(scopusTypeFamily({ subtype, aggregationType, dois: [] }), `${subtype}/${aggregationType}`).toBe(family);
    }
  });

  it('an arXiv DOI is a preprint, as for every source', () => {
    expect(scopusTypeFamily({ subtype: 'ar', aggregationType: 'Journal', dois: ['10.48550/arxiv.2101.00001'] })).toBe('PREPRINT');
  });
});

describe('scopusCitationCount', () => {
  it('parses non-negative integer counts only', () => {
    expect(scopusCitationCount(entry(1, { 'citedby-count': '7' }))).toBe(7);
    expect(scopusCitationCount(entry(1, { 'citedby-count': '0' }))).toBe(0);
    expect(scopusCitationCount(entry(1, { 'citedby-count': undefined }))).toBeNull();
    expect(scopusCitationCount(entry(1, { 'citedby-count': '-1' }))).toBeNull();
    expect(scopusCitationCount(entry(1, { 'citedby-count': 'n/a' }))).toBeNull();
  });
});
