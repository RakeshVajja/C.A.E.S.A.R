import { IdentitySource, Prisma, PrismaClient } from '@prisma/client';
import { prisma as defaultClient } from '../../config/database';
import { env } from '../../config/env';
import { DblpClient, normalizeDblpPid } from '../../integrations/dblp/client';
import { FetchError, SourceHttpConfig } from '../../integrations/http/httpClient';
import { normalizeOpenAlexAuthorId, OpenAlexClient } from '../../integrations/openalex/client';
import { normalizeOrcidId, OrcidClient } from '../../integrations/orcid/client';
import { normalizeScopusAuthorId, ScopusClient, scopusAuthorIdFromUrl, scopusProfileUrl } from '../../integrations/scopus/client';
import { HttpError } from '../../utils/httpError';
import { IDENTITY_PREVIEW_TTL_SECONDS, signIdentityPreviewToken, verifyIdentityPreviewToken } from '../auth/tokens';

/**
 * External identity management (Project_plan.md §6.3, §12.4, Phase 9; decisions #68, #69).
 *
 *   preview → normalize, validate with the existing source client, show source details;
 *             writes nothing (no publications, links or syncs) and returns a signed preview token
 *   save    → requires that token (bound to professor, source and normalized identifier); no
 *             further external request; the database unique constraint settles conflicts
 *   deactivate / delete → removes PENDING relationships discovered through the identity
 *             (APPROVED and REJECTED stay), in one transaction with the change (§12.4)
 *
 * The stored identifier is the normalized identifier the administrator submitted. For a merged
 * OpenAlex author it is not replaced by the resolved ID (#33): discovery resolves it when fetching.
 *
 * Scopus (stage 15.3, decision #118): an Author ID is verified either by the API preview above
 * (only when Scopus credentials are configured) or manually — the administrator checks the author's
 * public Scopus profile and submits its URL as evidence (`registerManualIdentity`). The method,
 * evidence URL and administrator are recorded. Every synchronization revalidates the identity with
 * the Scopus API before accepting any record. Identities are never transferred between professors.
 */

export interface IdentityClients {
  openAlex: OpenAlexClient;
  dblp: DblpClient;
  orcid: OrcidClient;
  /** Only when Scopus credentials are configured; without it, Scopus identities are verified manually. */
  scopus?: ScopusClient | null;
}

/** Interactive previews fail fast instead of using the synchronization retry budget (#68). */
export const PREVIEW_HTTP: Partial<SourceHttpConfig> = { timeoutMs: 20_000, maxRetries: 1, baseDelayMs: 500, maxDelayMs: 5_000 };

export function createPreviewClients(): IdentityClients {
  return {
    openAlex: new OpenAlexClient({ apiKey: env.openAlexApiKey, http: PREVIEW_HTTP }),
    dblp: new DblpClient({ http: PREVIEW_HTTP }),
    orcid: new OrcidClient({ http: PREVIEW_HTTP }),
    scopus: env.providerCredentials.scopus
      ? new ScopusClient({ apiKey: env.providerCredentials.scopus.apiKey, instToken: env.providerCredentials.scopus.instToken, http: PREVIEW_HTTP })
      : null,
  };
}

const SOURCE_LABEL: Record<IdentitySource, string> = {
  OPENALEX: 'OpenAlex author ID',
  DBLP: 'DBLP PID',
  ORCID: 'ORCID iD',
  SCOPUS: 'Scopus Author ID',
  WOS: 'Web of Science ResearcherID',
};

/** Sources whose identities can be previewed and saved today; WoS follows in Phase 15.4. */
type PreviewableSource = 'OPENALEX' | 'DBLP' | 'ORCID' | 'SCOPUS';

function previewableSource(source: IdentitySource): PreviewableSource {
  if (source === 'OPENALEX' || source === 'DBLP' || source === 'ORCID' || source === 'SCOPUS') return source;
  throw new HttpError(400, 'SOURCE_NOT_AVAILABLE', `${SOURCE_LABEL[source]} identities cannot be added yet`);
}
const RECENT_WORKS = 5;

/** The normalized identifier, using the source's own normalizer (and ORCID checksum). */
export function normalizeIdentifier(source: IdentitySource, value: string): string {
  const previewable = previewableSource(source);
  try {
    if (previewable === 'OPENALEX') return normalizeOpenAlexAuthorId(value);
    if (previewable === 'DBLP') return normalizeDblpPid(value);
    if (previewable === 'SCOPUS') return normalizeScopusAuthorId(value);
    return normalizeOrcidId(value);
  } catch (error) {
    if (error instanceof FetchError) {
      throw new HttpError(400, 'INVALID_IDENTIFIER', `This is not a valid ${SOURCE_LABEL[source]}`);
    }
    throw error;
  }
}

/**
 * Maps source failures to stable, project-controlled responses: no upstream message, provider
 * error code or URL reaches the client. The sanitized FetchError message (which may quote the
 * provider, e.g. ORCID's user message or a merged record's primary iD) goes to the server log.
 */
function sourceFailure(source: IdentitySource, error: unknown): never {
  if (error instanceof FetchError) {
    if (error.kind === 'IDENTITY_NOT_FOUND') {
      throw new HttpError(422, 'IDENTITY_NOT_FOUND', `${SOURCE_LABEL[source]} does not exist at the source`);
    }
    console.warn(`Identity preview: ${source} ${error.kind}${error.details.status ? ` (HTTP ${error.details.status})` : ''}: ${error.message}`);
    if (error.kind === 'IDENTITY_INVALID') throw new HttpError(422, 'IDENTITY_INVALID', invalidIdentityMessage(source, error.details.status));
    // Licensed providers (§13.9): fixed messages that never echo credentials or provider text.
    if (error.kind === 'AUTH_FAILED') {
      throw new HttpError(502, 'PROVIDER_AUTH_FAILED', `The ${SOURCE_LABEL[source]} could not be checked: the provider refused the configured API credentials`);
    }
    if (error.kind === 'NOT_ENTITLED') {
      throw new HttpError(502, 'PROVIDER_NOT_ENTITLED', `The ${SOURCE_LABEL[source]} could not be checked: the configured credentials are not entitled to this data`);
    }
    if (error.kind === 'QUOTA_EXCEEDED') {
      throw new HttpError(503, 'PROVIDER_QUOTA_EXCEEDED', `The ${SOURCE_LABEL[source]} could not be checked: the provider's request quota is exhausted; try again later`);
    }
    throw new HttpError(502, 'IDENTITY_SOURCE_UNAVAILABLE', `Could not verify the ${SOURCE_LABEL[source]} right now; try again later`);
  }
  throw error;
}

/** The known IDENTITY_INVALID classes of the existing clients, as fixed messages. */
function invalidIdentityMessage(source: IdentitySource, status: number | undefined): string {
  if (source === 'DBLP') {
    return 'This DBLP PID does not identify a single person (for example, it is a disambiguation page); use the PID of the specific person';
  }
  if (source === 'ORCID' && status === 409) return 'This ORCID record is deactivated or locked and cannot be used';
  if (source === 'ORCID' && status !== undefined && status >= 300 && status < 400) {
    return 'This ORCID iD is deprecated (merged into another record); use the record\'s current iD';
  }
  if (source === 'SCOPUS' && (status === 300 || status === 301)) {
    return 'Scopus has replaced this Author ID (the profile was merged); check the author\'s current Scopus profile and use its Author ID';
  }
  return `This ${SOURCE_LABEL[source]} cannot be used`;
}

async function sourceDetails(source: PreviewableSource, externalId: string, clients: IdentityClients) {
  try {
    if (source === 'OPENALEX') {
      const author = await clients.openAlex.validateAuthor(externalId);
      return {
        requestedId: author.requestedId,
        resolvedId: author.authorId,
        merged: author.merged,
        displayName: author.displayName,
        orcid: author.orcid,
        worksCount: author.worksCount,
        profileUrl: `https://openalex.org/${author.authorId}`,
        warning: author.merged
          ? `OpenAlex has merged ${author.requestedId} into ${author.authorId}. The submitted ID is stored; ` +
            'publications are fetched with the current ID.'
          : null,
      };
    }
    if (source === 'DBLP') {
      const person = await clients.dblp.validatePerson(externalId);
      return { pid: person.pid, name: person.name, profileUrl: `https://dblp.org/pid/${person.pid}.html` };
    }
    if (source === 'SCOPUS') {
      if (!clients.scopus) {
        throw new HttpError(
          409,
          'PROVIDER_NOT_CONFIGURED',
          'Scopus API credentials are not configured, so this Author ID cannot be checked automatically; verify it manually from the author\'s Scopus profile',
        );
      }
      // Author name and document count only: nothing is stored by a preview.
      const author = await clients.scopus.validateAuthor(externalId);
      return { authorId: author.authorId, name: author.name, documentCount: author.documentCount, profileUrl: author.profileUrl };
    }
    const works = await clients.orcid.fetchWorks(externalId);
    const person = await clients.orcid.fetchPersonName(externalId);
    const recentWorks = works.summaries
      .map((s) => ({ title: s.title?.title?.value ?? null, year: Number(s['publication-date']?.year?.value) || null }))
      .filter((w) => w.title)
      .sort((a, b) => (b.year ?? 0) - (a.year ?? 0))
      .slice(0, RECENT_WORKS);
    return {
      orcid: works.orcid,
      name: person.name,
      worksCount: works.summaries.length,
      recentWorks,
      profileUrl: `https://orcid.org/${works.orcid}`,
    };
  } catch (error) {
    sourceFailure(source, error);
  }
}

const professorNotFound = () => new HttpError(404, 'PROFESSOR_NOT_FOUND', 'Professor not found');
const identityNotFound = () => new HttpError(404, 'IDENTITY_NOT_FOUND', 'External identity not found for this professor');

async function requireProfessor(client: PrismaClient, professorId: string): Promise<void> {
  if (!(await client.professor.findUnique({ where: { id: professorId }, select: { id: true } }))) throw professorNotFound();
}

/** Validates an identity with its source and describes it. Reads only; writes nothing. */
export async function previewIdentity(
  professorId: string,
  source: IdentitySource,
  submitted: string,
  deps: { clients: IdentityClients; now: () => Date; client?: PrismaClient },
) {
  const client = deps.client ?? defaultClient;
  const previewable = previewableSource(source);
  const externalId = normalizeIdentifier(previewable, submitted);
  await requireProfessor(client, professorId);

  const details = await sourceDetails(previewable, externalId, deps.clients);
  const existing = await client.externalIdentity.findUnique({
    where: { source_externalId: { source, externalId } },
    select: { id: true, professorId: true, isActive: true },
  });
  const now = deps.now();
  return {
    preview: { source, externalId, ...details },
    alreadyAssigned: existing
      ? { identityId: existing.id, professorId: existing.professorId, sameProfessor: existing.professorId === professorId, isActive: existing.isActive }
      : null,
    previewToken: signIdentityPreviewToken({ professorId, source: previewable, externalId }, now),
    previewExpiresAt: new Date(now.getTime() + IDENTITY_PREVIEW_TTL_SECONDS * 1000),
  };
}

/** Sources that may be verified manually from public profile evidence (decision #118). */
const MANUALLY_VERIFIABLE = new Set<IdentitySource>(['SCOPUS']);

const identityOutput = {
  id: true,
  source: true,
  externalId: true,
  isActive: true,
  verifiedAt: true,
  verificationMethod: true,
  verificationEvidenceUrl: true,
  createdAt: true,
} as const;

/**
 * Registers an identity verified manually by the administrator from the provider's public profile
 * (decision #118; Scopus only in stage 15.3). The evidence must be the author's profile URL on
 * scopus.com naming the same Author ID. Records MANUAL_PROFILE, the evidence URL, the administrator
 * and the time. No external request is made here; the first synchronization revalidates the
 * identity with the Scopus API before accepting any record. An identity already assigned (to this
 * or another professor) is refused, never transferred.
 */
export async function registerManualIdentity(
  professorId: string,
  input: { source: IdentitySource; externalId: string; evidenceUrl: string },
  deps: { now: () => Date; client?: PrismaClient; verifiedByUserId: string },
) {
  const client = deps.client ?? defaultClient;
  if (!MANUALLY_VERIFIABLE.has(input.source)) {
    throw new HttpError(400, 'SOURCE_NOT_AVAILABLE', `${SOURCE_LABEL[input.source]} identities cannot be verified manually`);
  }
  const externalId = normalizeIdentifier(input.source, input.externalId);
  const evidenceId = scopusAuthorIdFromUrl(input.evidenceUrl);
  if (evidenceId === null) {
    throw new HttpError(400, 'INVALID_EVIDENCE', 'The evidence must be the author\'s Scopus profile URL, e.g. https://www.scopus.com/authid/detail.uri?authorId=…');
  }
  if (evidenceId !== externalId) {
    throw new HttpError(400, 'EVIDENCE_MISMATCH', 'The Scopus profile URL names a different Author ID than the one entered');
  }
  await requireProfessor(client, professorId);
  try {
    return await client.externalIdentity.create({
      data: {
        professorId,
        source: input.source,
        externalId,
        verifiedAt: deps.now(),
        verificationMethod: 'MANUAL_PROFILE',
        // Stored in canonical form, so the evidence always names exactly the stored identifier.
        verificationEvidenceUrl: scopusProfileUrl(externalId),
        verifiedByUserId: deps.verifiedByUserId,
      },
      select: identityOutput,
    });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      throw new HttpError(409, 'IDENTITY_IN_USE', 'This identity is already assigned to a professor');
    }
    throw error;
  }
}

/** Saves a previewed identity (no external request). verified_at is the preview time. */
export async function saveIdentity(
  professorId: string,
  previewToken: string,
  deps: { now: () => Date; client?: PrismaClient; verifiedByUserId?: string | null },
) {
  const client = deps.client ?? defaultClient;
  const claims = verifyIdentityPreviewToken(previewToken, deps.now());
  if (!claims || claims.professorId !== professorId) {
    throw new HttpError(400, 'INVALID_PREVIEW', 'Preview the identity for this professor again before saving it');
  }
  await requireProfessor(client, professorId);
  try {
    return await client.externalIdentity.create({
      data: {
        professorId,
        source: claims.source,
        externalId: claims.externalId,
        verifiedAt: claims.previewedAt,
        // Saved only after a successful API preview (#68); the administrator is recorded (#118).
        verificationMethod: 'API_PREVIEW',
        verifiedByUserId: deps.verifiedByUserId ?? null,
      },
      select: identityOutput,
    });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      throw new HttpError(409, 'IDENTITY_IN_USE', 'This identity is already assigned to a professor');
    }
    throw error;
  }
}

/** PENDING relationships discovered through the identity are removed (§12.4); others stay. */
function removePendingDiscoveries(tx: Prisma.TransactionClient, identityId: string) {
  return tx.professorPublication.deleteMany({ where: { discoveredViaIdentityId: identityId, status: 'PENDING' } });
}

/**
 * Activates or deactivates an identity of this professor. Deactivation removes the PENDING
 * relationships it discovered, in the same transaction; reactivation restores nothing directly
 * (the next synchronization rediscovers). Idempotent.
 */
export async function setIdentityActive(
  professorId: string,
  identityId: string,
  isActive: boolean,
  client: PrismaClient = defaultClient,
) {
  return client.$transaction(async (tx) => {
    const identity = await tx.externalIdentity.findFirst({ where: { id: identityId, professorId }, select: { id: true } });
    if (!identity) throw identityNotFound();
    const removed = isActive ? 0 : (await removePendingDiscoveries(tx, identityId)).count;
    // Conditional update: if a concurrent request removed the identity meanwhile, nothing matches,
    // the transaction rolls back (including the link removal) and the answer is 404, not a 500.
    const { count } = await tx.externalIdentity.updateMany({ where: { id: identityId, professorId }, data: { isActive } });
    if (count !== 1) throw identityNotFound();
    const updated = await tx.externalIdentity.findUniqueOrThrow({ where: { id: identityId }, select: identityOutput });
    return { identity: updated, pendingLinksRemoved: removed };
  });
}

/**
 * Removes an incorrect identity: its PENDING discoveries are deleted, then the identity; APPROVED
 * and REJECTED relationships stay (their discovered_via becomes NULL), as do publications and
 * source records (§6.10, §12.4).
 */
export async function deleteIdentity(professorId: string, identityId: string, client: PrismaClient = defaultClient) {
  return client.$transaction(async (tx) => {
    const identity = await tx.externalIdentity.findFirst({ where: { id: identityId, professorId }, select: { id: true } });
    if (!identity) throw identityNotFound();
    const removed = (await removePendingDiscoveries(tx, identityId)).count;
    // Conditional delete: a concurrent removal leaves nothing to delete → rollback and 404.
    const { count } = await tx.externalIdentity.deleteMany({ where: { id: identityId, professorId } });
    if (count !== 1) throw identityNotFound();
    return { pendingLinksRemoved: removed };
  });
}
