import { describe, expect, it } from 'vitest';
import { normalizeTitle } from '../../src/services/normalization/title';

describe('normalizeTitle (§7.2)', () => {
  it('lowercases and removes punctuation', () => {
    expect(normalizeTitle('Deep Learning: An Overview')).toBe('deep learning an overview');
  });

  it("removes DBLP's trailing period", () => {
    expect(normalizeTitle('Module Checking.')).toBe(normalizeTitle('Module Checking'));
  });

  it('turns literal "\\n" escape text (seen in OpenAlex titles) into a space', () => {
    expect(normalizeTitle('Graph Neural Networks Meet Neural-Symbolic Computing: A Survey and\\n Perspective')).toBe(
      'graph neural networks meet neural symbolic computing a survey and perspective',
    );
  });

  it('turns real control characters into spaces', () => {
    expect(normalizeTitle('Line one\nline\ttwo\r')).toBe('line one line two');
  });

  it('removes accents via NFKD (Büchi → buchi)', () => {
    expect(normalizeTitle('The complementation problem for Büchi automata')).toBe(
      'the complementation problem for buchi automata',
    );
    expect(normalizeTitle('Café Résumé Naïve')).toBe('cafe resume naive');
  });

  it('decodes HTML entities, including accented and numeric ones', () => {
    expect(normalizeTitle('Tom &amp; Jerry')).toBe('tom jerry');
    expect(normalizeTitle('Caf&eacute; B&uuml;chi')).toBe('cafe buchi');
    expect(normalizeTitle('Caf&#233; &#x42;')).toBe('cafe b');
    expect(normalizeTitle('A &unknownentity; B')).toBe('a b');
  });

  it('strips markup tags without splitting words', () => {
    expect(normalizeTitle('<i>Title</i> with <b>markup</b>')).toBe('title with markup');
    expect(normalizeTitle('H<sub>2</sub>O and x<sup>2</sup>')).toBe(normalizeTitle('H2O and x2'));
    expect(normalizeTitle('Model <mml:math><mml:mi>x</mml:mi></mml:math> Counting')).toBe('model x counting');
    expect(normalizeTitle('&lt;i&gt;Encoded&lt;/i&gt; tags')).toBe('encoded tags');
  });

  it('does not treat a lone comparison sign as a tag', () => {
    expect(normalizeTitle('When a < b and c > d')).toBe('when a b and c d');
  });

  it('unifies quotes and dashes by removing them', () => {
    expect(normalizeTitle('“Smart” quotes — and ‘dashes’ – here')).toBe(normalizeTitle('"Smart" quotes - and \'dashes\' - here'));
  });

  it('normalizes compatibility characters (NFKD)', () => {
    expect(normalizeTitle('ﬁnite ﬁeld')).toBe('finite field');
  });

  it('keeps stopwords and does not stem', () => {
    expect(normalizeTitle('On the Theory of Things')).toBe('on the theory of things');
    expect(normalizeTitle('Checking')).not.toBe(normalizeTitle('Check'));
  });

  it('collapses whitespace', () => {
    expect(normalizeTitle('  lots   of  space  ')).toBe('lots of space');
  });

  it('returns an empty string for empty or non-string input', () => {
    expect(normalizeTitle('')).toBe('');
    expect(normalizeTitle('...')).toBe('');
    expect(normalizeTitle(null)).toBe('');
    expect(normalizeTitle(undefined)).toBe('');
  });

  it('is deterministic and idempotent', () => {
    const once = normalizeTitle('A Scalable Approximate Model Counter.');
    expect(normalizeTitle(once)).toBe(once);
  });
});
