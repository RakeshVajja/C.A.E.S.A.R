import { describe, expect, it } from 'vitest';
import { dblpTypeFamily } from '../../src/integrations/dblp/typeFamily';
import { openAlexTypeFamily } from '../../src/integrations/openalex/typeFamily';
import { orcidTypeFamily } from '../../src/integrations/orcid/typeFamily';

describe('openAlexTypeFamily (§7.3, §7.4)', () => {
  const map = (type: string | null, sourceType: string | null, dois: string[] = []) =>
    openAlexTypeFamily({ type, sourceType, dois });

  it('detects preprints by type or arXiv DOI', () => {
    expect(map('preprint', 'repository')).toBe('PREPRINT');
    expect(map('article', 'journal', ['10.48550/arxiv.1306.5726'])).toBe('PREPRINT');
  });

  it('uses the source type because OpenAlex labels conference papers "article"', () => {
    // Real case: LICS paper typed "article" whose primary source type is "conference".
    expect(map('article', 'conference')).toBe('CONFERENCE');
    expect(map('conference-paper', null)).toBe('CONFERENCE');
    expect(map('conference-paper', 'book series')).toBe('CONFERENCE');
  });

  it('needs both "article" and a journal source for JOURNAL', () => {
    expect(map('article', 'journal')).toBe('JOURNAL');
    expect(map('article', null)).toBe('OTHER');
    expect(map('article', 'book series')).toBe('OTHER');
  });

  it('maps books and chapters', () => {
    expect(map('book-chapter', 'book series')).toBe('BOOK_CHAPTER');
    expect(map('book', null)).toBe('BOOK');
  });

  it('does not yet apply the repository rule (deferred to Phase 4, decision #25)', () => {
    // Real case: AAAI 2019 paper typed "article", repository-hosted, with the published AAAI DOI.
    expect(map('article', 'repository', ['10.1609/aaai.v33i01.33014731'])).toBe('OTHER');
    expect(map('report', 'repository')).toBe('OTHER');
  });

  it('maps everything else to OTHER', () => {
    expect(map('editorial', 'journal')).toBe('OTHER');
    expect(map('paratext', null)).toBe('OTHER');
    expect(map(null, null)).toBe('OTHER');
  });

  it('is case- and whitespace-insensitive', () => {
    expect(map(' Article ', 'JOURNAL')).toBe('JOURNAL');
  });
});

describe('dblpTypeFamily (§7.3, §7.4)', () => {
  it('detects preprints by Informal type or CoRR key', () => {
    expect(dblpTypeFamily({ recordType: 'Informal', key: 'journals/corr/ChakrabortyMV13' })).toBe('PREPRINT');
    expect(dblpTypeFamily({ recordType: 'Article', key: 'journals/corr/abs-2003-00330' })).toBe('PREPRINT');
  });

  it('maps record types', () => {
    expect(dblpTypeFamily({ recordType: 'Inproceedings', key: 'conf/cav/KupfermanV96' })).toBe('CONFERENCE');
    expect(dblpTypeFamily({ recordType: 'Article', key: 'journals/iandc/KupfermanVW01' })).toBe('JOURNAL');
    expect(dblpTypeFamily({ recordType: 'Incollection', key: 'books/x/Y01' })).toBe('BOOK_CHAPTER');
    expect(dblpTypeFamily({ recordType: 'Book', key: 'books/x/Y02' })).toBe('BOOK');
    expect(dblpTypeFamily({ recordType: 'Data', key: 'data/x/Y' })).toBe('OTHER');
    expect(dblpTypeFamily({ recordType: null, key: 'phd/x/Y' })).toBe('OTHER');
  });

  it('accepts schema and bibtex URIs', () => {
    expect(dblpTypeFamily({ recordType: 'https://dblp.org/rdf/schema#Inproceedings', key: 'conf/a/B' })).toBe(
      'CONFERENCE',
    );
    expect(dblpTypeFamily({ recordType: 'http://purl.org/net/nknouf/ns/bibtex#Article', key: 'journals/a/B' })).toBe(
      'JOURNAL',
    );
  });
});

describe('orcidTypeFamily (§7.3, §7.4)', () => {
  it.each([
    ['preprint', 'PREPRINT'],
    ['conference-paper', 'CONFERENCE'],
    ['journal-article', 'JOURNAL'],
    ['book-chapter', 'BOOK_CHAPTER'],
    ['book', 'BOOK'],
    ['JOURNAL_ARTICLE', 'JOURNAL'],
    ['data-set', 'OTHER'],
    ['report', 'OTHER'],
    ['other', 'OTHER'],
    [null, 'OTHER'],
  ])('maps %j to %s', (type, family) => {
    expect(orcidTypeFamily(type)).toBe(family);
  });
});
