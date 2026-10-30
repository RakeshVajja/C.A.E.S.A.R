import type { IdentitySource, SyncRunStatus, SyncTaskStatus } from '@prisma/client';
import { z } from 'zod';
import { canAttempt, DISCOVERY_PROVIDERS, type CredentialState, type DiscoveryProvider, type ProviderConfiguration } from '../providers/providerStatus';

/**
 * Outcome and provider coverage of a publication-discovery run (Project_plan.md §14; decisions
 * #83, #117). Pure functions, so the rules are testable without a database.
 *
 * Every discovery run persists a coverage snapshot (`sync_runs.provider_coverage`) taken when it
 * starts: the configuration state of all five mandatory providers and their identity counts. The
 * snapshot — not the current environment — decides the outcome and the reported coverage, so a run
 * stays historically correct after credentials change. JCR is not part of it.
 *
 *   SUCCESS          every task succeeded and every mandatory provider is covered: keyless
 *                    providers (NOT_REQUIRED) need no identities, while each licensed provider
 *                    (Scopus, WoS) must have credentials PRESENT *and* at least one successful
 *                    fetch in this run — present credentials alone prove nothing about access
 *   FAILED           no task succeeded and at least one failed
 *   PARTIAL_SUCCESS  anything else — in particular a licensed provider that is not configured,
 *                    incompletely configured, or configured but not accessed successfully in this
 *                    run (no identities, or all its tasks failed)
 */

const CREDENTIAL_STATES = ['NOT_REQUIRED', 'PRESENT', 'NOT_CONFIGURED', 'INCOMPLETE'] as const satisfies readonly CredentialState[];

const providerEntry = z.strictObject({ credentials: z.enum(CREDENTIAL_STATES), identities: z.number().int().min(0) });

export const coverageSnapshotSchema = z.strictObject({
  version: z.literal(1),
  providers: z.strictObject({
    OPENALEX: providerEntry,
    DBLP: providerEntry,
    ORCID: providerEntry,
    SCOPUS: providerEntry,
    WOS: providerEntry,
  }),
});

export type CoverageSnapshot = z.infer<typeof coverageSnapshotSchema>;

/** The snapshot stored with a new discovery run: configuration at start and identities planned. */
export function coverageSnapshot(configuration: ProviderConfiguration, identities: readonly { source: IdentitySource }[]): CoverageSnapshot {
  const entry = (provider: DiscoveryProvider) => ({
    credentials: configuration[provider].credentials,
    identities: identities.filter((i) => i.source === provider).length,
  });
  return {
    version: 1,
    providers: { OPENALEX: entry('OPENALEX'), DBLP: entry('DBLP'), ORCID: entry('ORCID'), SCOPUS: entry('SCOPUS'), WOS: entry('WOS') },
  };
}

/** Reads a stored snapshot; null for runs created before Phase 15 or not matching the schema. */
export function parseCoverageSnapshot(value: unknown): CoverageSnapshot | null {
  const parsed = coverageSnapshotSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export interface TaskOutcomeCounts {
  succeeded: number;
  failed: number;
  notConfigured: number;
}

export function countOutcomes(tasks: readonly { status: SyncTaskStatus }[]): TaskOutcomeCounts {
  return {
    succeeded: tasks.filter((t) => t.status === 'SUCCESS').length,
    failed: tasks.filter((t) => t.status === 'FAILED').length,
    notConfigured: tasks.filter((t) => t.status === 'NOT_CONFIGURED').length,
  };
}

/** Mandatory providers that could not be attempted in this run, whatever their identity count. */
export function unavailableProviders(snapshot: CoverageSnapshot): DiscoveryProvider[] {
  return DISCOVERY_PROVIDERS.filter((provider) => !canAttempt(snapshot.providers[provider].credentials));
}

type TaskLike = { source: IdentitySource | null; status: SyncTaskStatus };

/**
 * Licensed providers with credentials PRESENT but no successful fetch in this run (no identities,
 * or every task failed): their institutional access is unverified.
 */
export function unverifiedProviders(snapshot: CoverageSnapshot, tasks: readonly TaskLike[]): DiscoveryProvider[] {
  return DISCOVERY_PROVIDERS.filter(
    (provider) =>
      snapshot.providers[provider].credentials === 'PRESENT' && !tasks.some((t) => t.source === provider && t.status === 'SUCCESS'),
  );
}

export function runStatus(snapshot: CoverageSnapshot, tasks: readonly TaskLike[]): Exclude<SyncRunStatus, 'RUNNING'> {
  const counts = countOutcomes(tasks);
  if (counts.succeeded === 0 && counts.failed > 0) return 'FAILED';
  const covered = unavailableProviders(snapshot).length === 0 && unverifiedProviders(snapshot, tasks).length === 0;
  if (counts.failed === 0 && counts.notConfigured === 0 && covered) return 'SUCCESS';
  return 'PARTIAL_SUCCESS';
}

export interface ProviderCoverage {
  provider: DiscoveryProvider;
  /** Configuration state when the run started (from the snapshot). */
  credentials: CredentialState;
  /** Whether the provider could be attempted; says nothing about whether access works. */
  available: boolean;
  identities: number;
  succeeded: number;
  failed: number;
  notConfigured: number;
  /** PENDING or RUNNING. */
  unfinished: number;
  /** At least one fetch succeeded, so access worked in this run. */
  accessConfirmed: boolean;
  /**
   * Covered in this run: available, every task succeeded, and — for a licensed provider (PRESENT) —
   * access confirmed. A keyless provider (NOT_REQUIRED) without identities is complete.
   */
  complete: boolean;
}

/** Coverage of all five mandatory providers for one run, from its snapshot and its tasks. */
export function providerCoverage(
  snapshot: CoverageSnapshot,
  tasks: readonly TaskLike[],
): ProviderCoverage[] {
  return DISCOVERY_PROVIDERS.map((provider) => {
    const own = tasks.filter((t) => t.source === provider);
    const { succeeded, failed, notConfigured } = countOutcomes(own);
    const unfinished = own.length - succeeded - failed - notConfigured;
    const { credentials, identities } = snapshot.providers[provider];
    const available = canAttempt(credentials);
    return {
      provider,
      credentials,
      available,
      identities,
      succeeded,
      failed,
      notConfigured,
      unfinished,
      accessConfirmed: succeeded > 0,
      complete: available && succeeded === own.length && (credentials !== 'PRESENT' || succeeded > 0),
    };
  });
}
