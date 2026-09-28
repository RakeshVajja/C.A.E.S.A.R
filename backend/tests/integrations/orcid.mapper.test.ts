import { describe, expect, it } from 'vitest';
import { mapOrcidWorkSummary } from '../../src/integrations/orcid/mapper';
import { OrcidWorkSummary, OrcidWorksSchema } from '../../src/integrations/orcid/types';
import { buildNormalizedPublication, NormalizationError } from '../../src/services/normalization/normalizedPublication';
import { loadFixture } from '../helpers/fixtures';

function summariesOf(name: string): OrcidWorkSummary[] {
  return OrcidWorksSchema.parse(loadFixture('orcid', name).body).group.flatMap((g) => g['work-summary']);
}

const piwowar = summariesOf('works-piwowar');
const vardi = summariesOf('works-vardi');
const carberry = summariesOf('works-carberry');
const byPutCode = (list: OrcidWorkSummary[], putCode: number) => list.find((s) => s['put-code'] === putCode)!;

describe('mapOrcidWorkSummary — recorded summaries', () => {
  it('uses "{orcid}:{put-code}" as the external ID (one record per summary)', () => {
    const inputs = piwowar.map((s) => mapOrcidWorkSummary('0000-0003-1613-5981', s));
    expect(inputs.every((i) => /^0000-0003-1613-5981:\d+$/.test(i.externalId))).toBe(true);
    expect(new Set(inputs.map((i) => i.externalId)).size).toBe(100);
  });

  it('keeps only DOIs with relationship "self"', () => {
    const withSelfDoi = piwowar.find((s) =>
      s['external-ids']?.['external-id'].some((e) => e['external-id-type'] === 'doi' && e['external-id-relationship'] === 'self'),
    )!;
    expect(mapOrcidWorkSummary('0000-0003-1613-5981', withSelfDoi).dois).toHaveLength(1);
  });

  it('ignores part-of and version-of identifiers (e.g. a book DOI on a chapter, an ISSN)', () => {
    const summary = structuredClone(piwowar[0]);
    summary['external-ids'] = {
      'external-id': [
        { 'external-id-type': 'doi', 'external-id-value': '10.1371/journal.pmed.0020124', 'external-id-relationship': 'part-of' },
        { 'external-id-type': 'doi', 'external-id-value': '10.48550/arxiv.1234.5678', 'external-id-relationship': 'version-of' },
        { 'external-id-type': 'issn', 'external-id-value': '1549-1277', 'external-id-relationship': 'part-of' },
        { 'external-id-type': 'eid', 'external-id-value': '2-s2.0-1', 'external-id-relationship': 'self' },
      ],
    };
    expect(mapOrcidWorkSummary('0000-0003-1613-5981', summary).dois).toEqual([]);
    // Everything is still kept as raw metadata.
    expect(JSON.stringify(mapOrcidWorkSummary('0000-0003-1613-5981', summary).rawMetadata)).toContain('journal.pmed.0020124');
  });

  it('records the ISSN part-of identifier only in raw metadata (real Piwowar summary)', () => {
    const withIssn = piwowar.find((s) =>
      s['external-ids']?.['external-id'].some((e) => e['external-id-type'] === 'issn' && e['external-id-relationship'] === 'part-of'),
    )!;
    const selfDois = withIssn['external-ids']!['external-id']
      .filter((e) => e['external-id-type'] === 'doi' && e['external-id-relationship'] === 'self')
      .map((e) => e['external-id-value']);
    const input = mapOrcidWorkSummary('0000-0003-1613-5981', withIssn);
    expect(input.dois).toEqual(selfDois);
    expect(JSON.stringify(input.rawMetadata)).toContain('"external-id-type":"issn"');
  });

  it('maps a missing publication year to unknown (real Vardi summary 5160615)', () => {
    const summary = byPutCode(vardi, 5160615);
    expect(summary['publication-date']).toBeNull();
    const record = buildNormalizedPublication(mapOrcidWorkSummary('0000-0002-0661-5773', summary));
    expect(record).toMatchObject({ year: null, title: 'On decomposition of relational databases', typeFamily: 'JOURNAL' });
  });

  it('produces records normalization rejects when the title is null (real Vardi summaries)', () => {
    for (const putCode of [5160608, 5160609, 5160610]) {
      expect(() => buildNormalizedPublication(mapOrcidWorkSummary('0000-0002-0661-5773', byPutCode(vardi, putCode)))).toThrow(
        NormalizationError,
      );
    }
  });

  it('uses the title only; the subtitle stays in raw metadata (decision #44)', () => {
    const withSubtitle = carberry.find((s) => s.title?.subtitle?.value)!;
    const input = mapOrcidWorkSummary('0000-0002-1825-0097', withSubtitle);
    expect(input.title).toBe(withSubtitle.title!.title!.value);
    expect(input.title).not.toContain(withSubtitle.title!.subtitle!.value!);
    expect(input.rawMetadata).toBe(withSubtitle);
  });

  it('uses journal-title as venue and has no author names (not in summaries)', () => {
    const withJournal = piwowar.find((s) => s['journal-title']?.value)!;
    const input = mapOrcidWorkSummary('0000-0003-1613-5981', withJournal);
    expect(input.venue).toBe(withJournal['journal-title']!.value);
    expect(input.authorNamesDisplay).toBeNull();
  });

  it('maps the recorded ORCID types to type families', () => {
    const families: Record<string, string> = {};
    for (const s of [...piwowar, ...vardi, ...carberry]) {
      families[s.type!] = mapOrcidWorkSummary('0000-0003-1613-5981', s).typeFamily;
    }
    expect(families).toEqual({
      'journal-article': 'JOURNAL',
      'conference-paper': 'CONFERENCE',
      'data-set': 'OTHER',
      other: 'OTHER',
      report: 'OTHER',
    });
  });

  it('maps and normalizes every recorded summary that has a title', () => {
    for (const [orcid, list] of [
      ['0000-0003-1613-5981', piwowar],
      ['0000-0002-0661-5773', vardi],
      ['0000-0002-1825-0097', carberry],
    ] as const) {
      for (const s of list.filter((x) => x.title?.title?.value)) {
        const record = buildNormalizedPublication(mapOrcidWorkSummary(orcid, s));
        expect(record.source).toBe('ORCID');
        expect(record.dois.every((d) => d.startsWith('10.'))).toBe(true);
      }
    }
  });
});
