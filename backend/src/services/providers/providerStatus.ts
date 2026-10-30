import type { ProviderCredentials } from '../../config/env';

/**
 * Provider configuration (Project_plan.md §13.9; decisions #107, #117). The five publication sources
 * are mandatory and JCR is a core journal-metrics integration; none can be switched off.
 *
 * The configuration state describes only what the environment provides, never whether access works:
 *   NOT_REQUIRED    a keyless public API (OpenAlex, DBLP, ORCID)
 *   PRESENT         credentials are set — institutional access and entitlement are NOT verified by
 *                   this; only a successful fetch shows that access works (run coverage reports it)
 *   NOT_CONFIGURED  no credentials
 *   INCOMPLETE      a partial configuration that cannot be used (e.g. a token without a key)
 * A provider can be attempted when its state is NOT_REQUIRED or PRESENT. An unusable provider never
 * blocks startup or the other providers. Credentials themselves never leave env.ts and the adapters.
 */

export type DiscoveryProvider = 'OPENALEX' | 'DBLP' | 'ORCID' | 'SCOPUS' | 'WOS';
export type ProviderId = DiscoveryProvider | 'JCR';
export type CredentialState = 'NOT_REQUIRED' | 'PRESENT' | 'NOT_CONFIGURED' | 'INCOMPLETE';

/** The mandatory publication-discovery providers, in reporting order. JCR is not one of them. */
export const DISCOVERY_PROVIDERS: readonly DiscoveryProvider[] = ['OPENALEX', 'DBLP', 'ORCID', 'SCOPUS', 'WOS'];

export const PROVIDER_LABEL: Readonly<Record<ProviderId, string>> = {
  OPENALEX: 'OpenAlex',
  DBLP: 'DBLP',
  ORCID: 'ORCID',
  SCOPUS: 'Scopus',
  WOS: 'Web of Science',
  JCR: 'Journal Citation Reports',
};

export interface ProviderConfigurationEntry {
  credentials: CredentialState;
  /** Safe description of an INCOMPLETE configuration (variable names only); otherwise null. */
  issue: string | null;
}

export type ProviderConfiguration = Readonly<Record<ProviderId, ProviderConfigurationEntry>>;

export function providerConfiguration(credentials: ProviderCredentials): ProviderConfiguration {
  const licensed = (provider: 'SCOPUS' | 'WOS' | 'JCR', present: boolean): ProviderConfigurationEntry => {
    if (present) return { credentials: 'PRESENT', issue: null };
    const issue = credentials.issues.find((i) => i.provider === provider);
    return issue ? { credentials: 'INCOMPLETE', issue: issue.message } : { credentials: 'NOT_CONFIGURED', issue: null };
  };
  const keyless: ProviderConfigurationEntry = { credentials: 'NOT_REQUIRED', issue: null };
  return {
    OPENALEX: keyless,
    DBLP: keyless,
    ORCID: keyless,
    SCOPUS: licensed('SCOPUS', credentials.scopus !== null),
    WOS: licensed('WOS', credentials.wosStarter !== null),
    JCR: licensed('JCR', credentials.wosJournals !== null),
  };
}

/** Whether a provider with this configuration state may be attempted (its access is still unverified). */
export function canAttempt(state: CredentialState): boolean {
  return state === 'NOT_REQUIRED' || state === 'PRESENT';
}

/** Safe, fixed message for a discovery task whose provider cannot be attempted. */
export function unavailableMessage(provider: ProviderId, state: CredentialState): string {
  return state === 'INCOMPLETE'
    ? `${PROVIDER_LABEL[provider]} is incompletely configured: its credentials cannot be used`
    : `${PROVIDER_LABEL[provider]} is not configured: no API credentials are set`;
}

/** One startup line per provider whose state needs attention; never includes credential values. */
export function configurationWarnings(configuration: ProviderConfiguration): string[] {
  return (Object.keys(PROVIDER_LABEL) as ProviderId[]).flatMap((provider) => {
    const { credentials, issue } = configuration[provider];
    const label = PROVIDER_LABEL[provider];
    if (credentials === 'NOT_CONFIGURED') return [`${label} is NOT_CONFIGURED: no API credentials are set`];
    if (credentials === 'INCOMPLETE') return [`${label} is incompletely configured (${issue}); it will not be used`];
    if (credentials === 'PRESENT') return [`${label} credentials are present; institutional access is not verified until a request succeeds`];
    return [];
  });
}

/**
 * Classification of credential-related HTTP failures for the licensed providers (§22.4), used by
 * their adapters from Phase 15.3 on: 401 → authentication failure, 403 → not entitled, 429 → quota
 * or rate limit exhausted. Other statuses are ordinary fetch failures (null).
 */
export type CredentialFailure = 'AUTH_FAILED' | 'NOT_ENTITLED' | 'QUOTA_EXCEEDED';

export function credentialFailure(httpStatus: number | undefined): CredentialFailure | null {
  if (httpStatus === 401) return 'AUTH_FAILED';
  if (httpStatus === 403) return 'NOT_ENTITLED';
  if (httpStatus === 429) return 'QUOTA_EXCEEDED';
  return null;
}
