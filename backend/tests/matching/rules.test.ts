import type { TypeFamily } from '@prisma/client';
import { describe, expect, it } from 'vitest';
import {
  buildNormalizedPublication,
  NormalizedPublication,
  PublicationInput,
} from '../../src/services/normalization/normalizedPublication';
import { normalizeTitle } from '../../src/services/normalization/title';
import {
  evaluateDoiMatch,
  evaluateTitleMatch,
  PublicationSnapshot,
  titlesRelated,
} from '../../src/services/matching/rules';

function incoming(overrides: Partial<PublicationInput> = {}): NormalizedPublication {
  return buildNormalizedPublication({
    source: 'DBLP',
    externalId: 'conf/cp/ChakrabortyMV13',
    title: 'A Scalable Approximate Model Counter.',
    year: 2013,
    typeFamily: 'CONFERENCE',
    dois: [],
    ...overrides,
  });
}

function snapshot(overrides: Partial<Omit<PublicationSnapshot, 'normalizedTitles'>> & { titles?: string[] } = {}) {
  const { titles = ['A Scalable Approximate Model Counter'], ...rest } = overrides;
  return {
    id: 'p1',
    year: 2013,
    typeFamily: 'CONFERENCE' as TypeFamily,
    dois: [] as string[],
    normalizedTitles: titles.map(normalizeTitle),
    ...rest,
  } satisfies PublicationSnapshot;
}

describe('titlesRelated', () => {
  it('is true for equal titles and whole-word containment (subtitle present or absent)', () => {
    expect(titlesRelated('model checking', 'model checking')).toBe(true);
    expect(titlesRelated('symbolic ltlf synthesis', 'symbolic ltlf synthesis a survey')).toBe(true);
    expect(titlesRelated('symbolic ltlf synthesis a survey', 'symbolic ltlf synthesis')).toBe(true);
  });

  it('is false for partial-word overlap or unrelated titles', () => {
    expect(titlesRelated('model check', 'model checking')).toBe(false);
    expect(titlesRelated('module checking', 'vacuity detection in temporal model checking')).toBe(false);
    expect(titlesRelated('', 'anything')).toBe(false);
  });
});

describe('evaluateDoiMatch — rule 2 contradiction criteria (decision #22)', () => {
  const doi = '10.1007/978-3-642-40627-0_18';

  it('matches when the DOI is shared and titles are related', () => {
    expect(evaluateDoiMatch(incoming({ dois: [doi] }), snapshot({ dois: [doi] }))).toEqual({ kind: 'match' });
  });

  it('matches despite a different type family (type labels are unreliable)', () => {
    const result = evaluateDoiMatch(
      incoming({ dois: [doi], typeFamily: 'JOURNAL' }),
      snapshot({ dois: [doi], typeFamily: 'CONFERENCE' }),
    );
    expect(result).toEqual({ kind: 'match' });
  });

  it('matches despite a year difference (e.g. OpenAlex listing a 1997 paper as 2002)', () => {
    const result = evaluateDoiMatch(incoming({ dois: [doi], year: 2002 }), snapshot({ dois: [doi], year: 1997 }));
    expect(result).toEqual({ kind: 'match' });
  });

  it('matches OTHER-typed records on DOI', () => {
    expect(evaluateDoiMatch(incoming({ dois: [doi], typeFamily: 'OTHER' }), snapshot({ dois: [doi] }))).toEqual({
      kind: 'match',
    });
  });

  it('matches when the incoming title adds or drops a subtitle', () => {
    const result = evaluateDoiMatch(
      incoming({ dois: [doi], title: 'A Scalable Approximate Model Counter: Theory and Practice' }),
      snapshot({ dois: [doi] }),
    );
    expect(result).toEqual({ kind: 'match' });
  });

  it('matches when any title of the publication (canonical or source record) is related', () => {
    const result = evaluateDoiMatch(
      incoming({ dois: [doi], title: 'ApproxMC: A Scalable Approximate Model Counter' }),
      snapshot({ dois: [doi], titles: ['Something else entirely', 'ApproxMC: A Scalable Approximate Model Counter'] }),
    );
    expect(result).toEqual({ kind: 'match' });
  });

  it('is a contradiction for preprint vs published, in either direction', () => {
    const preprintIn = evaluateDoiMatch(incoming({ dois: [doi], typeFamily: 'PREPRINT' }), snapshot({ dois: [doi] }));
    expect(preprintIn).toMatchObject({ kind: 'contradiction', reason: expect.stringContaining('preprint vs published') });

    const preprintExisting = evaluateDoiMatch(
      incoming({ dois: [doi] }),
      snapshot({ dois: [doi], typeFamily: 'PREPRINT' }),
    );
    expect(preprintExisting.kind).toBe('contradiction');
  });

  it('matches a preprint to a preprint', () => {
    const arxiv = '10.48550/arxiv.1306.5726';
    const result = evaluateDoiMatch(
      incoming({ dois: [arxiv], typeFamily: 'PREPRINT' }),
      snapshot({ dois: [arxiv], typeFamily: 'PREPRINT' }),
    );
    expect(result).toEqual({ kind: 'match' });
  });

  it('is a contradiction when the titles are unrelated (likely incorrect DOI)', () => {
    const result = evaluateDoiMatch(
      incoming({ dois: [doi], title: 'Ophthalmic Biometry in Children' }),
      snapshot({ dois: [doi] }),
    );
    expect(result).toMatchObject({ kind: 'contradiction', reason: expect.stringContaining('unrelated titles') });
  });

  it('treats small wording differences as unrelated (no fuzzy threshold; becomes a candidate)', () => {
    const result = evaluateDoiMatch(
      incoming({ dois: [doi], title: 'A Scalable Approximate Model Countr' }),
      snapshot({ dois: [doi] }),
    );
    expect(result.kind).toBe('contradiction');
  });
});

describe('evaluateTitleMatch — rule 3 and vetoes', () => {
  it('merges an exact title with the same known family and year ±1', () => {
    expect(evaluateTitleMatch(incoming(), snapshot())).toEqual({ kind: 'merge' });
    expect(evaluateTitleMatch(incoming({ year: 2014 }), snapshot())).toEqual({ kind: 'merge' });
    expect(evaluateTitleMatch(incoming({ year: 2012 }), snapshot())).toEqual({ kind: 'merge' });
  });

  it('merges two preprints (same known family)', () => {
    const result = evaluateTitleMatch(incoming({ typeFamily: 'PREPRINT' }), snapshot({ typeFamily: 'PREPRINT' }));
    expect(result).toEqual({ kind: 'merge' });
  });

  it('merges when only one side has a DOI', () => {
    expect(evaluateTitleMatch(incoming({ dois: ['10.1000/x'] }), snapshot())).toEqual({ kind: 'merge' });
    expect(evaluateTitleMatch(incoming(), snapshot({ dois: ['10.1000/x'] }))).toEqual({ kind: 'merge' });
  });

  const blockedBy = (reason: RegExp, record: NormalizedPublication, publication: PublicationSnapshot) => {
    const result = evaluateTitleMatch(record, publication);
    expect(result.kind).toBe('blocked');
    expect(result.kind === 'blocked' && result.reasons.some((r) => reason.test(r))).toBe(true);
  };

  it('blocks when years differ by more than 1', () => {
    blockedBy(/years differ/, incoming({ year: 2015 }), snapshot());
    blockedBy(/years differ/, incoming({ year: 1996 }), snapshot({ year: 2001 }));
  });

  it('blocks when either year is missing', () => {
    blockedBy(/year unknown/, incoming({ year: null }), snapshot());
    blockedBy(/year unknown/, incoming(), snapshot({ year: null }));
  });

  it('blocks preprint vs published (DBLP CoRR record vs the CP 2013 paper)', () => {
    blockedBy(/preprint vs published/, incoming({ typeFamily: 'PREPRINT', externalId: 'journals/corr/ChakrabortyMV13' }), snapshot());
    blockedBy(/preprint vs published/, incoming(), snapshot({ typeFamily: 'PREPRINT' }));
  });

  it('blocks conference vs journal', () => {
    blockedBy(/incompatible type families \(JOURNAL vs CONFERENCE\)/, incoming({ typeFamily: 'JOURNAL' }), snapshot());
  });

  it('blocks when either type family is OTHER', () => {
    blockedBy(/type family unknown/, incoming({ typeFamily: 'OTHER' }), snapshot());
    blockedBy(/type family unknown/, incoming(), snapshot({ typeFamily: 'OTHER' }));
    blockedBy(/type family unknown/, incoming({ typeFamily: 'OTHER' }), snapshot({ typeFamily: 'OTHER' }));
  });

  it('blocks different non-null DOIs', () => {
    blockedBy(/different DOIs/, incoming({ dois: ['10.1000/a'] }), snapshot({ dois: ['10.1000/b'] }));
  });

  it('blocks generic or too-short titles even when everything else agrees', () => {
    blockedBy(/generic or too-short title/, incoming({ title: 'Editorial' }), snapshot({ titles: ['Editorial'] }));
    blockedBy(/generic or too-short title/, incoming({ title: 'Networks' }), snapshot({ titles: ['Networks'] }));
  });

  it('reports every blocking reason', () => {
    const result = evaluateTitleMatch(
      incoming({ title: 'Editorial', year: null, typeFamily: 'OTHER', dois: ['10.1000/a'] }),
      snapshot({ titles: ['Editorial'], dois: ['10.1000/b'] }),
    );
    expect(result).toEqual({
      kind: 'blocked',
      reasons: ['generic or too-short title', 'year unknown', 'type family unknown (OTHER)', 'different DOIs'],
    });
  });
});
