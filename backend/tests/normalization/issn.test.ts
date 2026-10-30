import { describe, expect, it } from 'vitest';
import { openAlexIssns } from '../../src/integrations/openalex/mapper';
import { mapOrcidWorkSummary, orcidIssns } from '../../src/integrations/orcid/mapper';
import { scopusIssns } from '../../src/integrations/scopus/mapper';
import { wosIssns } from '../../src/integrations/wos/mapper';
import { buildNormalizedPublication } from '../../src/services/normalization/normalizedPublication';
import { normalizeIssn, normalizeIssns } from '../../src/services/normalization/issn';

/* The shared ISSN normalizer and the providers' ISSN extraction (stage 15.6) — synthetic values. */

describe('normalizeIssn', () => {
  it('normalizes the usual spellings to NNNN-NNNC and checks the ISO 3297 check character', () => {
    for (const value of ['9999-0016', '99990016', ' 9999 0016 ', '9999–0016', 'ISSN 9999-0016', 'issn:9999-0016', 'urn:issn:9999-0016']) {
      expect(normalizeIssn(value), value).toBe('9999-0016');
    }
    expect(normalizeIssn('0000-006x')).toBe('0000-006X'); // check character 10 → X
    expect(normalizeIssn('2049-3630')).toBe('2049-3630');
  });

  it('rejects wrong check characters, wrong lengths and non-ISSN values', () => {
    for (const value of ['9999-0017', '1234-5678', '9999-001', '9999-00160', 'X999-0016', '9999-00X6', 'abcd-efgh', '', '   ', null, undefined, '10.5555/9999-0016']) {
      expect(normalizeIssn(value as string), String(value)).toBeNull();
    }
  });

  it('normalizeIssns de-duplicates, sorts and drops invalid values', () => {
    expect(normalizeIssns(['9999-0024', '99990016', '9999-0016', 'bad', null, '9999-0017'])).toEqual(['9999-0016', '9999-0024']);
  });
});

describe('provider ISSN extraction', () => {
  it('OpenAlex: primary_location.source.issn and issn_l', () => {
    expect(openAlexIssns({ primary_location: { source: { issn: ['9999-0016', '9999-0024'], issn_l: '9999-0016' } } })).toEqual(['9999-0016', '9999-0024', '9999-0016']);
    expect(openAlexIssns({ primary_location: { source: null } })).toEqual([]);
    expect(openAlexIssns({})).toEqual([]);
    expect(openAlexIssns(null)).toEqual([]);
  });

  it('ORCID: issn/eissn identifiers with relationship part-of only', () => {
    const summary = {
      'external-ids': {
        'external-id': [
          { 'external-id-type': 'issn', 'external-id-value': '9999-0016', 'external-id-relationship': 'part-of' },
          { 'external-id-type': 'eissn', 'external-id-value': '9999-0024', 'external-id-relationship': 'part-of' },
          { 'external-id-type': 'issn', 'external-id-value': '9999-0032', 'external-id-relationship': 'self' },
          { 'external-id-type': 'doi', 'external-id-value': '10.5555/x', 'external-id-relationship': 'self' },
        ],
      },
    };
    expect(orcidIssns(summary)).toEqual(['9999-0016', '9999-0024']);
    expect(orcidIssns({ 'external-ids': null })).toEqual([]);
  });

  it('Scopus prism:issn/eIssn (unhyphenated) and WoS identifiers.issn/eissn', () => {
    expect(scopusIssns({ 'prism:issn': '99990016', 'prism:eIssn': '99990024' })).toEqual(['99990016', '99990024']);
    expect(scopusIssns({})).toEqual([]);
    expect(wosIssns({ identifiers: { issn: '9999-0016', eissn: '9999-0024', isbn: '978-0' } })).toEqual(['9999-0016', '9999-0024']);
    expect(wosIssns({ identifiers: null })).toEqual([]);
  });

  it('normalized records carry the valid ISSNs only, sorted', () => {
    const record = buildNormalizedPublication({
      source: 'SCOPUS',
      externalId: '2-s2.0-1',
      title: 'Synthetic ISSN record',
      typeFamily: 'JOURNAL',
      issns: scopusIssns({ 'prism:issn': '99990024', 'prism:eIssn': '99990016' }).concat(['1234-5678']),
    });
    expect(record.issns).toEqual(['9999-0016', '9999-0024']);
    const orcid = buildNormalizedPublication(
      mapOrcidWorkSummary('0009-0000-0000-0017', {
        'put-code': 1,
        path: '/0009-0000-0000-0017/work/1',
        type: 'journal-article',
        title: { title: { value: 'Synthetic ORCID work' } },
        'external-ids': { 'external-id': [{ 'external-id-type': 'issn', 'external-id-value': '9999-0016', 'external-id-relationship': 'part-of' }] },
      }),
    );
    expect(orcid.issns).toEqual(['9999-0016']);
  });
});
