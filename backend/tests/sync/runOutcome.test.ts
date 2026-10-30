import { describe, expect, it } from 'vitest';
import type { IdentitySource, SyncTaskStatus } from '@prisma/client';
import type { ProviderCredentials } from '../../src/config/env';
import {
  countOutcomes,
  coverageSnapshot,
  parseCoverageSnapshot,
  providerCoverage,
  runStatus,
  unavailableProviders,
  unverifiedProviders,
} from '../../src/services/sync/runOutcome';
import {
  canAttempt,
  configurationWarnings,
  credentialFailure,
  providerConfiguration,
  unavailableMessage,
} from '../../src/services/providers/providerStatus';

/** Pure rules of Phase 15.2 (decisions #117, #123): mandatory provider coverage; no database. */

const NONE: ProviderCredentials = { scopus: null, wosStarter: null, wosJournals: null, issues: [] };
const SCOPUS_ONLY: ProviderCredentials = { ...NONE, scopus: { apiKey: 'k', instToken: null } };
const ALL: ProviderCredentials = { ...NONE, scopus: { apiKey: 'k', instToken: 't' }, wosStarter: { apiKey: 'k' }, wosJournals: { apiKey: 'k' } };

type Task = { source: IdentitySource; status: SyncTaskStatus };
const identities = (...sources: IdentitySource[]) => sources.map((source) => ({ source }));

/** What the engine stores at start, round-tripped through JSON as it is through the database. */
function storedSnapshot(credentials: ProviderCredentials, planned: { source: IdentitySource }[]) {
  const snapshot = parseCoverageSnapshot(JSON.parse(JSON.stringify(coverageSnapshot(providerConfiguration(credentials), planned))));
  if (!snapshot) throw new Error('snapshot did not round-trip');
  return snapshot;
}

describe('discovery run outcome over the five mandatory providers', () => {
  const ok = (...sources: IdentitySource[]): Task[] => sources.map((source) => ({ source, status: 'SUCCESS' }));
  const coverageOf = (snapshot: ReturnType<typeof storedSnapshot>, tasks: Task[], provider: IdentitySource) =>
    providerCoverage(snapshot, tasks).find((c) => c.provider === provider)!;

  it('SUCCESS only when every licensed provider was actually accessed and every task succeeded', () => {
    const snapshot = storedSnapshot(ALL, identities('OPENALEX', 'DBLP', 'ORCID', 'SCOPUS', 'WOS'));
    const tasks = ok('OPENALEX', 'DBLP', 'ORCID', 'SCOPUS', 'WOS');
    expect(unavailableProviders(snapshot)).toEqual([]);
    expect(unverifiedProviders(snapshot, tasks)).toEqual([]);
    expect(runStatus(snapshot, tasks)).toBe('SUCCESS');
    expect(providerCoverage(snapshot, tasks).every((c) => c.complete && c.accessConfirmed)).toBe(true);
  });

  it('Scopus and WoS unconfigured with zero identities: never SUCCESS', () => {
    const snapshot = storedSnapshot(NONE, identities('OPENALEX', 'DBLP'));
    const tasks = ok('OPENALEX', 'DBLP');
    expect(unavailableProviders(snapshot)).toEqual(['SCOPUS', 'WOS']);
    expect(runStatus(snapshot, tasks)).toBe('PARTIAL_SUCCESS');
    expect(providerCoverage(snapshot, tasks).map((c) => c.provider)).toEqual(['OPENALEX', 'DBLP', 'ORCID', 'SCOPUS', 'WOS']);
    for (const provider of ['SCOPUS', 'WOS'] as const) {
      expect(coverageOf(snapshot, tasks, provider)).toMatchObject({ credentials: 'NOT_CONFIGURED', available: false, identities: 0, accessConfirmed: false, complete: false });
    }
  });

  it('Scopus credentials present with zero identities: access unverified, run PARTIAL_SUCCESS', () => {
    const snapshot = storedSnapshot(ALL, identities('OPENALEX', 'ORCID', 'WOS'));
    const tasks = ok('OPENALEX', 'ORCID', 'WOS');
    expect(unavailableProviders(snapshot)).toEqual([]);
    expect(unverifiedProviders(snapshot, tasks)).toEqual(['SCOPUS']);
    expect(runStatus(snapshot, tasks)).toBe('PARTIAL_SUCCESS');
    expect(coverageOf(snapshot, tasks, 'SCOPUS')).toMatchObject({ credentials: 'PRESENT', available: true, identities: 0, accessConfirmed: false, complete: false });
    expect(coverageOf(snapshot, tasks, 'WOS')).toMatchObject({ credentials: 'PRESENT', accessConfirmed: true, complete: true });
  });

  it('WoS credentials present with zero identities: access unverified, run PARTIAL_SUCCESS', () => {
    const snapshot = storedSnapshot(ALL, identities('DBLP', 'SCOPUS'));
    const tasks = ok('DBLP', 'SCOPUS');
    expect(unverifiedProviders(snapshot, tasks)).toEqual(['WOS']);
    expect(runStatus(snapshot, tasks)).toBe('PARTIAL_SUCCESS');
    expect(coverageOf(snapshot, tasks, 'WOS')).toMatchObject({ credentials: 'PRESENT', identities: 0, accessConfirmed: false, complete: false });
  });

  it('Scopus and WoS credentials both present, no licensed identities: both unverified, run PARTIAL_SUCCESS', () => {
    const snapshot = storedSnapshot(ALL, identities('OPENALEX'));
    const tasks = ok('OPENALEX');
    expect(unverifiedProviders(snapshot, tasks)).toEqual(['SCOPUS', 'WOS']);
    expect(runStatus(snapshot, tasks)).toBe('PARTIAL_SUCCESS');
  });

  it('Scopus configured, WoS unconfigured, zero identities: neither is covered', () => {
    const snapshot = storedSnapshot(SCOPUS_ONLY, identities('ORCID'));
    const tasks = ok('ORCID');
    expect(unavailableProviders(snapshot)).toEqual(['WOS']);
    expect(unverifiedProviders(snapshot, tasks)).toEqual(['SCOPUS']);
    expect(runStatus(snapshot, tasks)).toBe('PARTIAL_SUCCESS');
  });

  it('a licensed provider whose every task failed is not confirmed, while the others succeed: PARTIAL_SUCCESS', () => {
    const snapshot = storedSnapshot(ALL, identities('OPENALEX', 'SCOPUS', 'WOS'));
    const tasks: Task[] = [...ok('OPENALEX', 'WOS'), { source: 'SCOPUS', status: 'FAILED' }];
    expect(unverifiedProviders(snapshot, tasks)).toEqual(['SCOPUS']);
    expect(runStatus(snapshot, tasks)).toBe('PARTIAL_SUCCESS');
    expect(coverageOf(snapshot, tasks, 'SCOPUS')).toMatchObject({ failed: 1, accessConfirmed: false, complete: false });
  });

  it('one Scopus identity succeeds and another fails: access confirmed, coverage incomplete, run PARTIAL_SUCCESS', () => {
    const snapshot = storedSnapshot(ALL, identities('SCOPUS', 'SCOPUS', 'WOS'));
    const tasks: Task[] = [...ok('SCOPUS', 'WOS'), { source: 'SCOPUS', status: 'FAILED' }];
    expect(unverifiedProviders(snapshot, tasks)).toEqual([]);
    expect(runStatus(snapshot, tasks)).toBe('PARTIAL_SUCCESS');
    expect(coverageOf(snapshot, tasks, 'SCOPUS')).toMatchObject({ succeeded: 1, failed: 1, accessConfirmed: true, complete: false });
  });

  it('a provider unavailable while the others succeed: its identities are NOT_CONFIGURED and the run is partial', () => {
    const snapshot = storedSnapshot(SCOPUS_ONLY, identities('OPENALEX', 'SCOPUS', 'WOS', 'WOS'));
    const tasks: Task[] = [
      { source: 'OPENALEX', status: 'SUCCESS' },
      { source: 'SCOPUS', status: 'SUCCESS' },
      { source: 'WOS', status: 'NOT_CONFIGURED' },
      { source: 'WOS', status: 'NOT_CONFIGURED' },
    ];
    expect(countOutcomes(tasks)).toEqual({ succeeded: 2, failed: 0, notConfigured: 2 });
    expect(runStatus(snapshot, tasks)).toBe('PARTIAL_SUCCESS');
    expect(coverageOf(snapshot, tasks, 'WOS')).toMatchObject({ credentials: 'NOT_CONFIGURED', identities: 2, notConfigured: 2, complete: false });
  });

  it('keyless providers keep NOT_REQUIRED semantics: complete without identities and never unverified', () => {
    const snapshot = storedSnapshot(ALL, identities('SCOPUS', 'WOS'));
    const tasks = ok('SCOPUS', 'WOS');
    expect(runStatus(snapshot, tasks)).toBe('SUCCESS');
    for (const provider of ['OPENALEX', 'DBLP', 'ORCID'] as const) {
      expect(coverageOf(snapshot, tasks, provider)).toMatchObject({ credentials: 'NOT_REQUIRED', identities: 0, accessConfirmed: false, complete: true });
    }
  });

  it('no identities for any provider: never SUCCESS, since no licensed provider was accessed', () => {
    expect(runStatus(storedSnapshot(ALL, []), [])).toBe('PARTIAL_SUCCESS');
    expect(unverifiedProviders(storedSnapshot(ALL, []), [])).toEqual(['SCOPUS', 'WOS']);
    expect(runStatus(storedSnapshot(NONE, []), [])).toBe('PARTIAL_SUCCESS');
    expect(unavailableProviders(storedSnapshot(NONE, []))).toEqual(['SCOPUS', 'WOS']);
  });

  it('coverage stays historically correct after the configuration changes, in both directions', () => {
    // Stored while Scopus and WoS were unconfigured; the environment later gains every credential.
    const unconfiguredThen = parseCoverageSnapshot(JSON.parse(JSON.stringify(coverageSnapshot(providerConfiguration(NONE), identities('OPENALEX')))))!;
    expect(providerConfiguration(ALL).SCOPUS.credentials).toBe('PRESENT');
    expect(runStatus(unconfiguredThen, ok('OPENALEX'))).toBe('PARTIAL_SUCCESS');
    expect(coverageOf(unconfiguredThen, ok('OPENALEX'), 'WOS').credentials).toBe('NOT_CONFIGURED');

    // Stored while every credential was present and both licensed providers were accessed; the
    // credentials are later removed — the run stays SUCCESS and keeps PRESENT/confirmed coverage.
    const presentThen = parseCoverageSnapshot(JSON.parse(JSON.stringify(coverageSnapshot(providerConfiguration(ALL), identities('SCOPUS', 'WOS')))))!;
    expect(providerConfiguration(NONE).SCOPUS.credentials).toBe('NOT_CONFIGURED');
    expect(runStatus(presentThen, ok('SCOPUS', 'WOS'))).toBe('SUCCESS');
    expect(coverageOf(presentThen, ok('SCOPUS', 'WOS'), 'SCOPUS')).toMatchObject({ credentials: 'PRESENT', accessConfirmed: true });
  });

  it('keeps the existing failure rules', () => {
    const snapshot = storedSnapshot(ALL, identities('OPENALEX', 'SCOPUS', 'WOS'));
    expect(runStatus(snapshot, [...ok('OPENALEX', 'SCOPUS', 'WOS'), { source: 'DBLP', status: 'FAILED' }])).toBe('PARTIAL_SUCCESS');
    expect(runStatus(snapshot, [{ source: 'OPENALEX', status: 'FAILED' }, { source: 'SCOPUS', status: 'FAILED' }])).toBe('FAILED');
    expect(runStatus(storedSnapshot(NONE, []), [{ source: 'OPENALEX', status: 'FAILED' }, { source: 'WOS', status: 'NOT_CONFIGURED' }])).toBe('FAILED');
  });

  it('rejects malformed or pre-Phase-15 snapshots instead of guessing', () => {
    expect(parseCoverageSnapshot(null)).toBeNull();
    expect(parseCoverageSnapshot({ version: 1, providers: {} })).toBeNull();
    const snapshot = coverageSnapshot(providerConfiguration(ALL), []);
    expect(parseCoverageSnapshot({ ...snapshot, providers: { ...snapshot.providers, JCR: { credentials: 'PRESENT', identities: 0 } } })).toBeNull();
  });
});

describe('provider configuration', () => {
  it('describes configuration only: keyless sources need nothing, licensed ones are PRESENT, NOT_CONFIGURED or INCOMPLETE', () => {
    expect(providerConfiguration(NONE)).toEqual({
      OPENALEX: { credentials: 'NOT_REQUIRED', issue: null },
      DBLP: { credentials: 'NOT_REQUIRED', issue: null },
      ORCID: { credentials: 'NOT_REQUIRED', issue: null },
      SCOPUS: { credentials: 'NOT_CONFIGURED', issue: null },
      WOS: { credentials: 'NOT_CONFIGURED', issue: null },
      JCR: { credentials: 'NOT_CONFIGURED', issue: null },
    });
    expect(providerConfiguration(ALL).SCOPUS).toEqual({ credentials: 'PRESENT', issue: null });
    const incomplete = providerConfiguration({ ...NONE, issues: [{ provider: 'SCOPUS', message: 'SCOPUS_INST_TOKEN is set but SCOPUS_API_KEY is not' }] });
    expect(incomplete.SCOPUS).toEqual({ credentials: 'INCOMPLETE', issue: 'SCOPUS_INST_TOKEN is set but SCOPUS_API_KEY is not' });
    expect(canAttempt('PRESENT')).toBe(true);
    expect(canAttempt('NOT_REQUIRED')).toBe(true);
    expect(canAttempt('INCOMPLETE')).toBe(false);
    expect(canAttempt('NOT_CONFIGURED')).toBe(false);
  });

  it('warns without values and never claims that present credentials work', () => {
    const warnings = configurationWarnings(
      providerConfiguration({ scopus: null, wosStarter: { apiKey: 'secret-wos-key' }, wosJournals: null, issues: [{ provider: 'SCOPUS', message: 'SCOPUS_INST_TOKEN is set but SCOPUS_API_KEY is not' }] }),
    );
    expect(warnings).toEqual([
      'Scopus is incompletely configured (SCOPUS_INST_TOKEN is set but SCOPUS_API_KEY is not); it will not be used',
      'Web of Science credentials are present; institutional access is not verified until a request succeeds',
      'Journal Citation Reports is NOT_CONFIGURED: no API credentials are set',
    ]);
    expect(warnings.join(' ')).not.toContain('secret-wos-key');
  });

  it('gives fixed, credential-free task messages', () => {
    expect(unavailableMessage('SCOPUS', 'NOT_CONFIGURED')).toBe('Scopus is not configured: no API credentials are set');
    expect(unavailableMessage('SCOPUS', 'INCOMPLETE')).toBe('Scopus is incompletely configured: its credentials cannot be used');
  });

  it('classifies credential-related HTTP failures', () => {
    expect(credentialFailure(401)).toBe('AUTH_FAILED');
    expect(credentialFailure(403)).toBe('NOT_ENTITLED');
    expect(credentialFailure(429)).toBe('QUOTA_EXCEEDED');
    expect(credentialFailure(500)).toBeNull();
    expect(credentialFailure(undefined)).toBeNull();
  });
});
