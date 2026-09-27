import { describe, expect, it } from 'vitest';
import { normalizeDoi, normalizeDois } from '../../src/services/normalization/doi';

describe('normalizeDoi (§7.1)', () => {
  it.each([
    ['10.1000/ABC', '10.1000/abc'],
    ['10.1000/abc', '10.1000/abc'],
    ['https://doi.org/10.1000/abc', '10.1000/abc'],
    ['http://doi.org/10.1000/abc', '10.1000/abc'],
    ['https://dx.doi.org/10.1000/abc', '10.1000/abc'],
    ['http://dx.doi.org/10.1000/abc', '10.1000/abc'],
    ['doi:10.1000/abc', '10.1000/abc'],
    ['DOI: 10.1000/abc', '10.1000/abc'],
    ['HTTPS://DOI.ORG/10.1000/ABC', '10.1000/abc'],
    ['  10.1000/abc  ', '10.1000/abc'],
  ])('normalizes %j to %j', (input, expected) => {
    expect(normalizeDoi(input)).toBe(expected);
  });

  it('lowercases DBLP-style uppercase DOIs', () => {
    expect(normalizeDoi('https://doi.org/10.1016/J.IC.2012.11.005')).toBe('10.1016/j.ic.2012.11.005');
  });

  it('URL-decodes percent-encoded DOIs', () => {
    expect(normalizeDoi('https://doi.org/10.1000%2Fabc')).toBe('10.1000/abc');
    expect(normalizeDoi('10.1002/%28SICI%291097-4571')).toBe('10.1002/(sici)1097-4571');
  });

  it('keeps an undecodable value as it is (then validates it)', () => {
    expect(normalizeDoi('10.1000/abc%E0%A4%A')).toBe('10.1000/abc%e0%a4%a');
  });

  it('removes trailing punctuation', () => {
    expect(normalizeDoi('10.1000/abc.')).toBe('10.1000/abc');
    expect(normalizeDoi('10.1000/abc,')).toBe('10.1000/abc');
    expect(normalizeDoi('10.1000/abc;')).toBe('10.1000/abc');
    expect(normalizeDoi('(see 10.1000/abc)')).toBeNull();
    expect(normalizeDoi('10.1000/abc).')).toBe('10.1000/abc');
  });

  it('keeps parentheses inside a DOI', () => {
    expect(normalizeDoi('10.1016/0022-0000(86)90026-7')).toBe('10.1016/0022-0000(86)90026-7');
  });

  it.each([
    [''],
    ['   '],
    ['not a doi'],
    ['10.12/abc'], // registrant code too short
    ['10.1234567890/abc'], // registrant code too long
    ['10.1000/'],
    ['10.1000/has space'],
    ['https://example.org/10.1000/abc'],
    ['arXiv:1306.5726'],
  ])('rejects invalid value %j', (input) => {
    expect(normalizeDoi(input)).toBeNull();
  });

  it('rejects non-string input', () => {
    expect(normalizeDoi(null)).toBeNull();
    expect(normalizeDoi(undefined)).toBeNull();
  });

  it('accepts arXiv DataCite DOIs', () => {
    expect(normalizeDoi('https://doi.org/10.48550/arXiv.1306.5726')).toBe('10.48550/arxiv.1306.5726');
  });
});

describe('normalizeDois', () => {
  it('normalizes, drops invalid values and de-duplicates while keeping order', () => {
    expect(
      normalizeDois(['https://doi.org/10.1000/B', null, 'junk', '10.1000/a', '10.1000/b', 'doi:10.1000/A']),
    ).toEqual(['10.1000/b', '10.1000/a']);
  });
});
