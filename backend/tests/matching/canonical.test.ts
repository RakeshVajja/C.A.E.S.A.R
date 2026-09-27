import type { PublicationSource, TypeFamily } from '@prisma/client';
import { describe, expect, it } from 'vitest';
import { selectCanonicalMetadata, SourceRecordMetadata } from '../../src/services/matching/canonical';

let counter = 0;
function record(source: PublicationSource, overrides: Partial<SourceRecordMetadata> = {}): SourceRecordMetadata {
  counter++;
  return {
    id: `r${String(counter).padStart(3, '0')}`,
    source,
    title: `${source} title`,
    year: null,
    venue: null,
    typeFamily: 'OTHER' as TypeFamily,
    doi: null,
    authorNamesDisplay: null,
    firstSeenAt: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  };
}

const notTaken = () => false;

describe('selectCanonicalMetadata — CURATED → OpenAlex → DBLP → ORCID → MANUAL (§9)', () => {
  it('prefers OpenAlex, then DBLP, then ORCID, then MANUAL, whatever the input order', () => {
    const records = [
      record('MANUAL', { title: 'Manual Title' }),
      record('ORCID', { title: 'Orcid Title' }),
      record('DBLP', { title: 'Dblp Title.' }),
      record('OPENALEX', { title: 'OpenAlex Title' }),
    ];
    expect(selectCanonicalMetadata(records, notTaken).title).toBe('OpenAlex Title');
    expect(selectCanonicalMetadata(records.slice(0, 3), notTaken).title).toBe('Dblp Title.');
    expect(selectCanonicalMetadata(records.slice(0, 2), notTaken).title).toBe('Orcid Title');
    expect(selectCanonicalMetadata(records.slice(0, 1), notTaken).title).toBe('Manual Title');
  });

  it('keeps MANUAL as the last fallback, not an override', () => {
    const result = selectCanonicalMetadata(
      [record('MANUAL', { title: 'Typed by professor', year: 2020 }), record('ORCID', { title: 'From ORCID', year: 2021 })],
      notTaken,
    );
    expect(result.title).toBe('From ORCID');
    expect(result.year).toBe(2021);
  });

  it('selects each field independently: the first non-empty value wins', () => {
    const result = selectCanonicalMetadata(
      [
        record('OPENALEX', { title: 'OA', year: null, venue: null, authorNamesDisplay: 'A, B' }),
        record('DBLP', { title: 'DBLP', year: 2013, venue: 'CP', authorNamesDisplay: 'A B' }),
        record('MANUAL', { title: 'M', venue: 'Manual venue' }),
      ],
      notTaken,
    );
    expect(result).toMatchObject({ title: 'OA', normalizedTitle: 'oa', year: 2013, venue: 'CP', authorNamesDisplay: 'A, B' });
  });

  it('does not let OTHER outrank a known type family (decision #26)', () => {
    const result = selectCanonicalMetadata(
      [record('OPENALEX', { typeFamily: 'OTHER' }), record('DBLP', { typeFamily: 'CONFERENCE' })],
      notTaken,
    );
    expect(result.typeFamily).toBe('CONFERENCE');
  });

  it('falls back to OTHER when no record knows the type', () => {
    expect(selectCanonicalMetadata([record('OPENALEX'), record('DBLP')], notTaken).typeFamily).toBe('OTHER');
  });

  it('skips a DOI already owned by another publication', () => {
    const result = selectCanonicalMetadata(
      [record('OPENALEX', { doi: '10.1000/taken' }), record('DBLP', { doi: '10.1000/free' })],
      (doi) => doi === '10.1000/taken',
    );
    expect(result.doi).toBe('10.1000/free');
    expect(selectCanonicalMetadata([record('OPENALEX', { doi: '10.1000/taken' })], () => true).doi).toBeNull();
  });

  it('breaks ties within one source by oldest record, then id (in-source duplicates)', () => {
    const newer = record('OPENALEX', { title: 'Newer', firstSeenAt: new Date('2026-02-01') });
    const older = record('OPENALEX', { title: 'Older', firstSeenAt: new Date('2025-02-01') });
    expect(selectCanonicalMetadata([newer, older], notTaken).title).toBe('Older');

    const a = record('DBLP', { id: 'a', title: 'A' });
    const b = record('DBLP', { id: 'b', title: 'B' });
    expect(selectCanonicalMetadata([b, a], notTaken).title).toBe('A');
  });

  it('requires at least one source record', () => {
    expect(() => selectCanonicalMetadata([], notTaken)).toThrow();
  });
});
