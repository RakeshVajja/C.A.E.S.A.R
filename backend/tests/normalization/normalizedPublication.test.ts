import { describe, expect, it } from 'vitest';
import {
  buildNormalizedPublication,
  NormalizationError,
} from '../../src/services/normalization/normalizedPublication';
import { stripExcludedContent } from '../../src/services/normalization/rawMetadata';

describe('buildNormalizedPublication (§7)', () => {
  const base = {
    source: 'OPENALEX' as const,
    externalId: 'W2741809807',
    title: 'The state of OA: a large-scale analysis',
    typeFamily: 'JOURNAL' as const,
  };

  it('builds the common record', () => {
    const record = buildNormalizedPublication({
      ...base,
      dois: ['https://doi.org/10.7717/PEERJ.4375', 'junk'],
      year: 2018,
      venue: ' PeerJ ',
      authorNamesDisplay: 'Heather Piwowar,  Jason Priem',
      rawMetadata: { id: 'W2741809807' },
    });

    expect(record).toEqual({
      source: 'OPENALEX',
      externalId: 'W2741809807',
      title: 'The state of OA: a large-scale analysis',
      normalizedTitle: 'the state of oa a large scale analysis',
      dois: ['10.7717/peerj.4375'],
      year: 2018,
      venue: 'PeerJ',
      typeFamily: 'JOURNAL',
      isPreprint: false,
      authorNamesDisplay: 'Heather Piwowar, Jason Priem',
      rawMetadata: { id: 'W2741809807' },
    });
  });

  it('derives isPreprint from the PREPRINT type family', () => {
    expect(buildNormalizedPublication({ ...base, typeFamily: 'PREPRINT' }).isPreprint).toBe(true);
  });

  it('cleans literal escape text in the display title', () => {
    expect(buildNormalizedPublication({ ...base, title: 'A Survey and\\n Perspective' }).title).toBe(
      'A Survey and Perspective',
    );
  });

  it('treats implausible or non-integer years as unknown', () => {
    expect(buildNormalizedPublication({ ...base, year: 2018.5 }).year).toBeNull();
    expect(buildNormalizedPublication({ ...base, year: 999 }).year).toBeNull();
    expect(buildNormalizedPublication({ ...base, year: 2101 }).year).toBeNull();
    expect(buildNormalizedPublication({ ...base, year: 1000 }).year).toBe(1000);
    expect(buildNormalizedPublication({ ...base, year: null }).year).toBeNull();
  });

  it('defaults optional fields to null / empty', () => {
    const record = buildNormalizedPublication(base);
    expect(record.dois).toEqual([]);
    expect(record.venue).toBeNull();
    expect(record.authorNamesDisplay).toBeNull();
    expect(record.rawMetadata).toBeNull();
  });

  it('rejects records without a usable title or external ID', () => {
    expect(() => buildNormalizedPublication({ ...base, title: '   ' })).toThrow(NormalizationError);
    expect(() => buildNormalizedPublication({ ...base, title: '...' })).toThrow(NormalizationError);
    expect(() => buildNormalizedPublication({ ...base, externalId: ' ' })).toThrow(NormalizationError);
  });

  it('strips excluded content from raw metadata', () => {
    const record = buildNormalizedPublication({
      ...base,
      rawMetadata: { id: 'W1', abstract_inverted_index: { a: [0] }, referenced_works: ['W2'] },
    });
    expect(record.rawMetadata).toEqual({ id: 'W1' });
  });
});

describe('stripExcludedContent', () => {
  it('removes abstracts, references and full text at any depth, case-insensitively', () => {
    expect(
      stripExcludedContent({
        title: 'T',
        Abstract: 'long text',
        nested: { 'short-description': 'orcid abstract', keep: 1, fulltext: 'x' },
        list: [{ references: ['r'], ok: true }],
        content_urls: { pdf: 'u' },
      }),
    ).toEqual({ title: 'T', nested: { keep: 1 }, list: [{ ok: true }] });
  });

  it('keeps other source-specific metadata untouched', () => {
    const raw = { ids: { doi: 'x', mag: '1' }, type: 'article', counts: [1, 2], flag: false, none: null };
    expect(stripExcludedContent(raw)).toEqual(raw);
  });

  it('drops values JSON cannot represent', () => {
    expect(stripExcludedContent({ a: undefined, b: Number.NaN, c: () => 1 })).toEqual({ b: null, c: null });
  });
});

describe('U+0000 (decision #52)', () => {
  const base = { source: 'DBLP' as const, externalId: 'conf/x/A', title: 'Model Checking Programs', typeFamily: 'CONFERENCE' as const };

  it('replaces U+0000 with U+FFFD in title, venue and author names; the normalized title is unchanged', () => {
    const record = buildNormalizedPublication({
      ...base,
      title: 'Model\u0000Checking Programs',
      venue: 'CAV\u0000',
      authorNamesDisplay: 'A. Author,\u0000B. Author',
    });
    expect(record.title).toBe('Model�Checking Programs');
    expect(record.venue).toBe('CAV�');
    expect(record.authorNamesDisplay).toBe('A. Author,�B. Author');
    expect(record.normalizedTitle).toBe(buildNormalizedPublication(base).normalizedTitle);
    expect(JSON.stringify(record)).not.toContain('\\u0000');
  });

  it('rejects an external ID containing U+0000 without altering it, and the message is safe to store', () => {
    let error: unknown;
    try {
      buildNormalizedPublication({ ...base, externalId: 'conf/x/\u0000A' });
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(NormalizationError);
    expect((error as Error).message).toBe('Record DBLP:conf/x/�A has an external ID containing U+0000');
  });

  it('replaces U+0000 in nested raw-metadata values and keys, still strips excluded content', () => {
    expect(
      stripExcludedContent({
        'k\u0000': { inner: ['ok', 'x\u0000y', { 'deep\u0000': 'v\u0000' }] },
        abstract: 'never stored \u0000',
        plain: 'unchanged',
      }),
    ).toEqual({ plain: 'unchanged', 'k�': { inner: ['ok', 'x�y', { 'deep�': 'v�' }] } });
  });

  it('never silently overwrites a value when replaced keys collide (deterministic suffixes)', () => {
    const raw = {
      'a\u0000': 1,
      'a�': 2, // an original key already named like the replacement
      'a�#2': 3, // and one already named like the first suffix
      'b\u0000�': 4,
      'b�\u0000': 5, // two keys with U+0000 that collide with each other
    };
    const expected = { 'a�': 2, 'a�#2': 3, 'a�#3': 1, 'b��': 4, 'b��#2': 5 };
    expect(stripExcludedContent(raw)).toEqual(expected);
    expect(stripExcludedContent(raw)).toEqual(stripExcludedContent(structuredClone(raw)));
    expect(Object.values(stripExcludedContent(raw) as object).sort()).toEqual([1, 2, 3, 4, 5]);
  });

  it('returns a payload without U+0000 exactly as before, key order included', () => {
    const raw = { z: 1, a: { y: 'text', b: [1, 'x'] }, m: null };
    expect(JSON.stringify(stripExcludedContent(raw))).toBe(JSON.stringify(raw));
  });
});
