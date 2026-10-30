import { describe, expect, it } from 'vitest';
import { FetchError } from '../../src/integrations/http/httpClient';
import { canonicalJson, journalProfile, mapJournalReport } from '../../src/integrations/jcr/mapper';
import { JcrJournalHistorySchema, JcrJournalRecordSchema, JcrJournalReportSchema } from '../../src/integrations/jcr/types';
import { history, ISSN, journalRecord, report } from '../fixtures/jcr/synthetic';

/* JCR mapping, normalization and payload hashing (stage 15.6) — synthetic responses only. */

const record = (spec: Parameters<typeof journalRecord>[0]) => JcrJournalRecordSchema.parse(journalRecord(spec).body);
const hist = (...args: Parameters<typeof history>) => JcrJournalHistorySchema.parse(history(...args).body);
const rep = (...args: Parameters<typeof report>) => JcrJournalReportSchema.parse(report(...args).body);

describe('journalProfile', () => {
  it('maps the profile and classifies ISSNs: current → PRINT, electronic → ELECTRONIC, previous and history-only → PREVIOUS', () => {
    const profile = journalProfile(
      record({ id: 'SYNTH_A', name: '  Synthetic   Journal A ', issn: '99990016', eIssn: ISSN.A_ONLINE, previousIssn: [ISSN.A_PREVIOUS, 'not-an-issn'], reportYears: [2022, 2020, 2021, 2021] }),
      hist('SYNTH_A', [
        { issn: ISSN.A_PRINT, start: 2005, end: 2022 },
        { issn: ISSN.A_PREVIOUS, start: 2001, end: 2004 },
        { issn: ISSN.C_PRINT, start: 1999, end: 2000 },
        { issn: '1234-5678', start: 1990, end: 1991 },
      ]),
    );
    expect(profile).toMatchObject({
      jcrId: 'SYNTH_A',
      name: 'Synthetic Journal A',
      jcrTitle: 'SYNTH J SYNTH_A',
      publisherName: 'SYNTHETIC PUBLISHER LTD',
      firstIssueYear: 2001,
      frequency: 12,
      language: 'English',
      reportYears: [2020, 2021, 2022],
    });
    expect(profile.issns).toEqual([
      { issn: ISSN.A_PRINT, kind: 'PRINT', validFromYear: 2005, validToYear: 2022 },
      { issn: ISSN.A_ONLINE, kind: 'ELECTRONIC', validFromYear: null, validToYear: null },
      { issn: ISSN.A_PREVIOUS, kind: 'PREVIOUS', validFromYear: 2001, validToYear: 2004 },
      { issn: ISSN.C_PRINT, kind: 'PREVIOUS', validFromYear: 1999, validToYear: 2000 },
    ]);
  });

  it('works without history and without ISSNs; inverted validity years are dropped', () => {
    expect(journalProfile(record({ id: 'SYNTH_B', reportYears: [] }), null)).toMatchObject({ issns: [], reportYears: [] });
    const inverted = journalProfile(record({ id: 'SYNTH_B', issn: ISSN.B_PRINT }), hist('SYNTH_B', [{ issn: ISSN.B_PRINT, start: 2020, end: 2010 }]));
    expect(inverted.issns).toEqual([{ issn: ISSN.B_PRINT, kind: 'PRINT', validFromYear: null, validToYear: null }]);
  });
});

describe('mapJournalReport', () => {
  it('stores the metrics returned directly, with derived numeric values kept separate', () => {
    const mapped = mapJournalReport(rep('SYNTH_A', 2021));
    expect(mapped.report).toMatchObject({
      totalCites: 3221,
      jifText: '2.345',
      jifWithoutSelfText: '2.100',
      jif5Years: 2.9,
      immediacyIndex: 0.4,
      jci: 1.1,
      averageJifPercentile: 71.5,
      suppressed: false,
      onHold: false,
      delisted: false,
    });
    expect(mapped).toMatchObject({ jifValue: 2.345, jifWithoutSelfValue: 2.1, warnings: [] });
    for (const text of ['N/A', '<0.1', '']) {
      expect(mapJournalReport(rep('SYNTH_A', 2021, { jif: text })).jifValue, text).toBeNull();
    }
    expect(mapJournalReport(rep('SYNTH_A', 2021, { impact: { jif5Years: null, jci: undefined } })).report).toMatchObject({ jif5Years: null, jci: null });
  });

  it('category metrics: normalized names, codes from self, edition "" when absent, parsed ranks, quartiles and percentiles', () => {
    expect(mapJournalReport(rep('SYNTH_A', 2021)).report.categories).toEqual([
      { metric: 'JCI', categoryName: 'SYNTHETIC SCIENCE, APPLIED', categoryCode: null, edition: '', rankText: '15/130', rank: 15, rankTotal: 130, quartile: 'Q1', percentile: 88.8 },
      { metric: 'JIF', categoryName: 'SYNTHETIC SCIENCE, APPLIED', categoryCode: 'ZZ_SCIE', edition: 'SCIE', rankText: '12/120', rank: 12, rankTotal: 120, quartile: 'Q1', percentile: 90.4 },
      { metric: 'JIF', categoryName: 'SYNTHETIC SOCIAL STUDIES', categoryCode: 'ZY_SSCI', edition: 'SSCI', rankText: '40/80', rank: 40, rankTotal: 80, quartile: 'Q2', percentile: 50.6 },
    ]);
  });

  it('an unfamiliar edition is stored as returned and reported; unusable ranks and quartiles are reported, never invented', () => {
    const mapped = mapJournalReport(
      rep('SYNTH_A', 2021, {
        ranks: {
          jif: [
            { category: 'SYNTHETIC SCIENCE', edition: ' scie-x ', rank: 'n/a', quartile: 'Q5', jifPercentile: 10 },
            { category: 'SYNTHETIC SCIENCE', edition: 'SCIE', rank: '130/120', quartile: 'q3' },
          ],
          jci: [],
        },
      }),
    );
    expect(mapped.report.categories).toEqual([
      { metric: 'JIF', categoryName: 'SYNTHETIC SCIENCE', categoryCode: null, edition: 'SCIE', rankText: '130/120', rank: null, rankTotal: null, quartile: 'Q3', percentile: null },
      { metric: 'JIF', categoryName: 'SYNTHETIC SCIENCE', categoryCode: null, edition: 'SCIE-X', rankText: 'n/a', rank: null, rankTotal: null, quartile: null, percentile: 10 },
    ]);
    expect(mapped.warnings).toEqual([
      'Unfamiliar JCR edition "SCIE-X" for JIF category SYNTHETIC SCIENCE; stored as returned',
      'JIF rank "n/a" in SYNTHETIC SCIENCE is not "n/total"; kept as text only',
      'JIF quartile "Q5" in SYNTHETIC SCIENCE is not Q1–Q4; not stored',
      'JIF rank "130/120" in SYNTHETIC SCIENCE is not "n/total"; kept as text only',
    ]);
  });

  it('identical duplicate category rows collapse; conflicting ones make the report invalid without quoting JCR text', () => {
    const row = { category: 'SYNTHETIC SCIENCE', edition: 'SCIE', rank: '1/10', quartile: 'Q1' };
    expect(mapJournalReport(rep('SYNTH_A', 2021, { ranks: { jif: [row, { ...row, category: ' synthetic  science ' }] } })).report.categories).toHaveLength(1);
    let error: unknown;
    try {
      mapJournalReport(rep('SYNTH_A', 2021, { ranks: { jif: [row, { ...row, rank: '2/10' }] } }));
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(FetchError);
    expect(error).toMatchObject({ kind: 'INVALID_RESPONSE' });
    expect((error as Error).message).not.toMatch(/SYNTHETIC/);
  });

  it('the payload hash is stable for equal content (key and rank order) and changes with any stored value', () => {
    const base = report('SYNTH_A', 2021).body as Record<string, unknown>;
    const reordered = JSON.parse(JSON.stringify(base)) as { ranks: { jif: unknown[] }; metrics: Record<string, unknown> };
    reordered.ranks.jif.reverse();
    reordered.metrics = Object.fromEntries(Object.entries(reordered.metrics).reverse());
    const a = mapJournalReport(JcrJournalReportSchema.parse(base)).payloadHash;
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(mapJournalReport(JcrJournalReportSchema.parse(reordered)).payloadHash).toBe(a);
    // Fields that are not stored (e.g. Eigenfactor) do not change the identity.
    expect(mapJournalReport(rep('SYNTH_A', 2021, { overrides: { journalData: { anything: 1 } } })).payloadHash).toBe(a);
    for (const changed of [rep('SYNTH_A', 2021, { jif: '2.346' }), rep('SYNTH_A', 2021, { overrides: { suppressed: true } }), rep('SYNTH_A', 2021, { impact: { totalCites: 1 } })]) {
      expect(mapJournalReport(changed).payloadHash).not.toBe(a);
    }
  });

  it('canonical JSON sorts keys at every level', () => {
    expect(canonicalJson({ b: 1, a: { d: [2, { f: 1, e: 0 }], c: null } })).toBe('{"a":{"c":null,"d":[2,{"e":0,"f":1}]},"b":1}');
  });
});
