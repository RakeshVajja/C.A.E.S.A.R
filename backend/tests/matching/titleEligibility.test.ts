import { describe, expect, it } from 'vitest';
import { normalizeTitle } from '../../src/services/normalization/title';
import {
  GENERIC_TITLE_PREFIXES,
  GENERIC_TITLES,
  isGenericOrShortTitle,
  MIN_TITLE_LENGTH,
  MIN_TITLE_WORDS,
} from '../../src/services/matching/titleEligibility';

const check = (title: string) => isGenericOrShortTitle(normalizeTitle(title));

describe('generic / too-short title rule (decision #23)', () => {
  it('uses the documented thresholds', () => {
    expect(MIN_TITLE_LENGTH).toBe(10);
    expect(MIN_TITLE_WORDS).toBe(2);
  });

  describe('length boundary (10 normalized characters)', () => {
    it('rejects 9 characters', () => {
      expect(normalizeTitle('Graph Nets')).toHaveLength(10);
      expect('abcd efgh'.length).toBe(9);
      expect(isGenericOrShortTitle('abcd efgh')).toBe(true);
    });

    it('accepts exactly 10 characters', () => {
      expect(isGenericOrShortTitle('abcd efghi')).toBe(false);
      expect(check('Graph Nets')).toBe(false);
    });
  });

  describe('word boundary (2 words)', () => {
    it('rejects a single long word', () => {
      expect(check('Hyperparameterization')).toBe(true);
    });

    it('accepts two words', () => {
      expect(check('Module Checking.')).toBe(false); // real DBLP title
      expect(check('Black Box Checking')).toBe(false);
    });
  });

  it('rejects every listed generic title, whatever the punctuation or case', () => {
    for (const title of GENERIC_TITLES) {
      expect(isGenericOrShortTitle(title), title).toBe(true);
    }
    expect(check('EDITORIAL.')).toBe(true);
    expect(check("Editor's Note")).toBe(true);
    expect(check('Front Matter')).toBe(true);
    expect(check('Table of Contents')).toBe(true);
    expect(check('Message from the Program Chairs')).toBe(true);
  });

  it('rejects titles starting with a generic prefix', () => {
    for (const prefix of GENERIC_TITLE_PREFIXES) {
      expect(isGenericOrShortTitle(`${prefix} special issue on formal methods`), prefix).toBe(true);
    }
    expect(check('Guest Editorial: Special Issue on Model Checking')).toBe(true);
    expect(check('Erratum to: A Scalable Approximate Model Counter')).toBe(true);
    expect(check('Correction to: Vacuity Detection in Temporal Model Checking')).toBe(true);
  });

  it('does not treat distinctive titles that merely contain a generic word as generic', () => {
    expect(check('Introduction to Automata Theory, Languages, and Computation')).toBe(false);
    expect(check('An Introduction to Model Checking')).toBe(false);
    expect(check('Corrections for Measurement Error in Surveys')).toBe(false);
    expect(check('Editorials as a Genre of Scientific Writing')).toBe(false);
    expect(check('Summary Statistics for Graph Streams')).toBe(false);
  });
});
