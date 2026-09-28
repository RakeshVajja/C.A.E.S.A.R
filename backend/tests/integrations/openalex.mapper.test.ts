import { describe, expect, it } from 'vitest';
import { mapOpenAlexWork } from '../../src/integrations/openalex/mapper';
import { OpenAlexWork, OpenAlexWorkSchema } from '../../src/integrations/openalex/types';
import {
  buildNormalizedPublication,
  NormalizationError,
} from '../../src/services/normalization/normalizedPublication';
import { loadFixture } from '../helpers/fixtures';

const works = (name: string): OpenAlexWork[] =>
  (loadFixture('openalex', name).body as { results: unknown[] }).results.map((w) => OpenAlexWorkSchema.parse(w));

const cases = new Map(works('works-cases').map((w) => [w.id.replace('https://openalex.org/', ''), w]));
const map = (id: string) => mapOpenAlexWork(cases.get(id)!);

describe('mapOpenAlexWork — recorded edge cases', () => {
  it('maps identifiers, DOI, year, venue and author names', () => {
    const input = map('W1632042597');
    expect(input).toMatchObject({
      source: 'OPENALEX',
      externalId: 'W1632042597',
      title: 'Distribution-Aware Sampling and Weighted Model Counting for SAT',
      year: 2014,
      typeFamily: 'CONFERENCE',
    });
    expect(input.dois).toContain('https://doi.org/10.1609/aaai.v28i1.8990');
    expect(input.venue).toBe('Proceedings of the AAAI Conference on Artificial Intelligence');
    expect(input.authorNamesDisplay).toContain('Moshe Y. Vardi');
  });

  it('classifies a conference paper that OpenAlex types "article" via its conference source', () => {
    const input = map('W42364276');
    expect(cases.get('W42364276')!.type).toBe('article');
    expect(input.typeFamily).toBe('CONFERENCE');
  });

  it('detects an arXiv preprint and keeps its title (literal "\\n") for normalization', () => {
    const record = buildNormalizedPublication(map('W3037471945'));
    expect(record.typeFamily).toBe('PREPRINT');
    expect(record.title).not.toContain('\\n');
    expect(record.normalizedTitle).toBe(
      'graph neural networks meet neural symbolic computing a survey and perspective',
    );
  });

  it('does not treat repository hosting as a preprint (decision #31)', () => {
    // AAAI paper whose primary location is a repository, carrying the published AAAI DOI.
    expect(cases.get('W2963382544')!.primary_location?.source?.type).toBe('repository');
    expect(map('W2963382544').typeFamily).toBe('OTHER');
    // LIPIcs paper hosted in Dagstuhl's repository, typed article, submittedVersion.
    expect(map('W1505349556').typeFamily).toBe('OTHER');
  });

  it('gives both works that share one AAAI DOI the same normalized DOI', () => {
    const a = buildNormalizedPublication(map('W2889619879'));
    const b = buildNormalizedPublication(map('W2963382544'));
    expect(a.dois[0]).toBe('10.1609/aaai.v33i01.33014731');
    expect(b.dois[0]).toBe(a.dois[0]);
  });

  it('maps a journal article', () => {
    expect(map('W2033071128').typeFamily).toBe('JOURNAL');
  });

  it('handles a work without a primary source (type alone decides)', () => {
    expect(cases.get('W1989783863')!.primary_location?.source).toBeNull();
    const input = map('W1989783863');
    expect(input.venue).toBeNull();
    expect(input.typeFamily).toBe('CONFERENCE'); // typed conference-paper
  });

  it('produces a record that normalization rejects when the title is empty', () => {
    expect(cases.get('W4229843017')!.title).toBe('');
    expect(() => buildNormalizedPublication(map('W4229843017'))).toThrow(NormalizationError);
  });

  it('keeps the selected payload as raw metadata (no abstracts or references present)', () => {
    const input = map('W1632042597');
    expect(input.rawMetadata).toBe(cases.get('W1632042597'));
    const raw = JSON.stringify(input.rawMetadata);
    expect(raw).not.toContain('abstract_inverted_index');
    expect(raw).not.toContain('referenced_works');
  });
});

describe('mapOpenAlexWork — every recorded work', () => {
  const all = [...works('works-page-1'), ...works('works-page-2'), ...works('works-page-3'), ...cases.values()];

  it('maps all 76 recorded works to OPENALEX inputs with W-ids', () => {
    expect(all).toHaveLength(76);
    for (const work of all) {
      const input = mapOpenAlexWork(work);
      expect(input.source).toBe('OPENALEX');
      expect(input.externalId).toMatch(/^W\d+$/);
    }
  });

  it('normalizes every recorded work that has a title', () => {
    for (const work of all.filter((w) => w.title ?? w.display_name)) {
      const record = buildNormalizedPublication(mapOpenAlexWork(work));
      expect(record.normalizedTitle.length).toBeGreaterThan(0);
      expect(record.dois.every((doi) => doi.startsWith('10.'))).toBe(true);
    }
  });
});
