import { describe, expect, it } from 'vitest';
import { mapWosDocument, wosTimesCited } from '../../src/integrations/wos/mapper';
import { wosTypeFamily } from '../../src/integrations/wos/typeFamily';
import { WosDocumentSchema } from '../../src/integrations/wos/types';
import { buildNormalizedPublication, NormalizationError } from '../../src/services/normalization/normalizedPublication';
import { RID, wosDocument } from '../fixtures/wos/synthetic';

/* Web of Science mapping (stage 15.4) — synthetic documents only. */

const doc = (n: number, overrides: Record<string, unknown> = {}) => WosDocumentSchema.parse(wosDocument(n, overrides));

describe('mapWosDocument', () => {
  it('maps the Starter document fields into a normalized publication', () => {
    const normalized = buildNormalizedPublication(
      mapWosDocument(doc(1, { title: '  Synthetic   Web of Science study — number 1: on Deterministic Matching ', identifiers: { doi: 'https://doi.org/10.5555/SYNTHETIC.WOS.1', issn: '1234-5678' } })),
    );
    expect(normalized).toMatchObject({
      source: 'WOS',
      externalId: 'WOS:000900000000001',
      title: 'Synthetic Web of Science study — number 1: on Deterministic Matching',
      normalizedTitle: 'synthetic web of science study number 1 on deterministic matching',
      dois: ['10.5555/synthetic.wos.1'],
      year: 2021,
      venue: 'JOURNAL OF SYNTHETIC RESULTS',
      typeFamily: 'JOURNAL',
      isPreprint: false,
      authorNamesDisplay: 'Verma, A; Rao, S',
    });
  });

  it('keeps authors in order with their ResearcherIDs in raw metadata, and never invents an author list', () => {
    const raw = buildNormalizedPublication(mapWosDocument(doc(1))).rawMetadata as { names: { authors: { researcherId?: string }[] } };
    expect(raw.names.authors.map((a) => a.researcherId ?? null)).toEqual([RID, null]);
    for (const names of [null, {}, { authors: [] }, { authors: [{ researcherId: RID }, { displayName: '  ' }] }]) {
      expect(mapWosDocument(doc(1, { names })).authorNamesDisplay, JSON.stringify(names)).toBeNull();
    }
  });

  it('keeps identifiers, links and Times Cited in raw metadata', () => {
    const raw = buildNormalizedPublication(mapWosDocument(doc(2, { identifiers: { doi: '10.5555/x', issn: '1234-5678', eissn: '8765-4321', pmid: '123' } })))
      .rawMetadata as Record<string, Record<string, unknown>>;
    expect(raw.identifiers).toEqual({ doi: '10.5555/x', issn: '1234-5678', eissn: '8765-4321', pmid: '123' });
    expect(raw.citations).toEqual([{ db: 'WOS', count: 8 }]);
    expect(raw.links.record).toContain('KeyUT=WOS:000900000000002');
  });

  it('removes abstracts at every nesting level, whatever their key case', () => {
    const withAbstracts = doc(3, {
      abstract: 'top-level synthetic abstract',
      Abstracts: { abstract: { abstract_text: { p: ['nested synthetic abstract'] } } },
      source: { sourceTitle: 'JOURNAL OF SYNTHETIC RESULTS', publishYear: 2021, abstract: 'inside source' },
      keywords: { authorKeywords: ['kept'], extra: [{ ABSTRACT: 'inside an array' }, { abstract_text: 'also inside an array' }] },
    });
    const raw = buildNormalizedPublication(mapWosDocument(withAbstracts)).rawMetadata;
    const text = JSON.stringify(raw);
    expect(text).not.toMatch(/abstract/i);
    expect(text).toContain('kept');
  });

  it('handles missing optional values without inventing them', () => {
    const sparse = buildNormalizedPublication(mapWosDocument(doc(4, { identifiers: null, source: null, types: null, sourceTypes: null, citations: null })));
    expect(sparse).toMatchObject({ dois: [], year: null, venue: null, typeFamily: 'OTHER' });
  });

  it('a document without a title cannot be normalized and is skipped by ingestion', () => {
    expect(() => buildNormalizedPublication(mapWosDocument(doc(5, { title: undefined })))).toThrow(NormalizationError);
    expect(() => buildNormalizedPublication(mapWosDocument(doc(5, { title: '   ' })))).toThrow(NormalizationError);
  });

  it('an implausible publication year is dropped by the shared normalization', () => {
    expect(buildNormalizedPublication(mapWosDocument(doc(6, { source: { publishYear: 99 } }))).year).toBeNull();
  });
});

describe('wosTypeFamily', () => {
  const family = (types: string[] | null, ids: { issn?: boolean; isbn?: boolean } = { issn: true }, dois: string[] = [], sourceTypes: string[] | null = null) =>
    wosTypeFamily({ types, sourceTypes, hasIssn: Boolean(ids.issn), hasIsbn: Boolean(ids.isbn), dois });

  it('maps the documented document types, using ISSN/ISBN to recognize journals', () => {
    expect(family(['Article'])).toBe('JOURNAL');
    expect(family(['Review'])).toBe('JOURNAL');
    expect(family(['Article', 'Early Access'])).toBe('JOURNAL');
    expect(family(['Article'], {})).toBe('OTHER'); // no ISSN: venue unknown
    expect(family(['Article'], { issn: true, isbn: true })).toBe('OTHER'); // book series
    expect(family(['Proceedings Paper'], { issn: true, isbn: true })).toBe('CONFERENCE');
    expect(family(['Article', 'Proceedings Paper'])).toBe('CONFERENCE');
    expect(family(['Book Chapter'], { isbn: true })).toBe('BOOK_CHAPTER');
    expect(family(['Book'], { isbn: true })).toBe('BOOK');
    for (const other of ['Editorial Material', 'Letter', 'Meeting Abstract', 'Correction', 'Note', 'Book Review', 'Data Paper']) {
      expect(family([other]), other).toBe('OTHER');
    }
    expect(family([])).toBe('OTHER');
    expect(family(null)).toBe('OTHER');
    expect(family([], { issn: true }, [], ['Article'])).toBe('JOURNAL'); // source types when no normalized types
    expect(family(['  ARTICLE '])).toBe('JOURNAL');
  });

  it('an arXiv DOI is a preprint, as for every source', () => {
    expect(family(['Article'], { issn: true }, ['10.48550/arxiv.2101.00001'])).toBe('PREPRINT');
  });
});

describe('wosTimesCited', () => {
  it('reads the Core Collection count only', () => {
    expect(wosTimesCited(doc(1, { citations: [{ db: 'WOS', count: 7 }] }))).toBe(7);
    expect(wosTimesCited(doc(1, { citations: [{ db: 'BCI', count: 3 }, { db: 'wos', count: 0 }] }))).toBe(0);
    expect(wosTimesCited(doc(1, { citations: [{ db: 'BCI', count: 3 }] }))).toBeNull();
    expect(wosTimesCited(doc(1, { citations: [{ db: 'WOS' }] }))).toBeNull();
    expect(wosTimesCited(doc(1, { citations: [] }))).toBeNull();
    expect(wosTimesCited(doc(1, { citations: undefined }))).toBeNull();
  });
});
