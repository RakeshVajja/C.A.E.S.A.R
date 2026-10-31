import type { ClarivateGate } from '../../src/services/providers/clarivateGate';
import { providerConfiguration, type ProviderConfiguration } from '../../src/services/providers/providerStatus';

/**
 * Provider configurations for synchronization tests (Phase 15.2). The test environment leaves every
 * licensed credential unset, so Scopus and WoS are NOT_CONFIGURED by default. `allProvidersPresent()`
 * gives them placeholder credentials (state PRESENT); without Scopus/WoS identities nothing is ever
 * requested, and because present credentials do not prove access, such runs end PARTIAL_SUCCESS
 * until a Scopus and a WoS fetch succeed (#130).
 */
export function allProvidersPresent(): ProviderConfiguration {
  return providerConfiguration({
    scopus: { apiKey: 'test-placeholder', instToken: null },
    wosStarter: { apiKey: 'test-placeholder' },
    wosJournals: { apiKey: 'test-placeholder' },
    issues: [],
  });
}

/** The configuration of the test environment itself: only the keyless sources can be attempted. */
export function noLicensedProviders(): ProviderConfiguration {
  return providerConfiguration({ scopus: null, wosStarter: null, wosJournals: null, issues: [] });
}

/**
 * An OPEN Clarivate gate, for tests of the Web of Science and JCR code paths with synthetic responses
 * only. The application's own gate is closed (src/services/providers/clarivateGate.ts); tests that
 * check the closed gate use the default.
 */
export const OPEN_CLARIVATE_GATE: ClarivateGate = Object.freeze({ removalToolingComplete: true, writtenConfirmationsOnRecord: true });
