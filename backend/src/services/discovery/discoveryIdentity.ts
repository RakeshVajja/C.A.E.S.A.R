import type { IdentitySource, PrismaClient } from '@prisma/client';

/** Shared precondition checks for discovering publications through one external identity. */

export class DiscoveryPreconditionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DiscoveryPreconditionError';
  }
}

export interface ActiveDiscoveryIdentity {
  id: string;
  professorId: string;
  externalId: string;
}

/**
 * Loads an identity that may be synchronized: it exists, belongs to `source`, is active, and its
 * professor is active (§6.10, §14). Throws DiscoveryPreconditionError otherwise, before any API call.
 */
export async function loadActiveIdentity(
  client: PrismaClient,
  identityId: string,
  source: IdentitySource,
): Promise<ActiveDiscoveryIdentity> {
  const identity = await client.externalIdentity.findUnique({
    where: { id: identityId },
    include: { professor: { select: { isActive: true } } },
  });
  if (!identity) throw new DiscoveryPreconditionError(`External identity ${identityId} not found`);
  if (identity.source !== source) {
    throw new DiscoveryPreconditionError(`Identity ${identityId} is a ${identity.source} identity, not ${source}`);
  }
  if (!identity.isActive) throw new DiscoveryPreconditionError(`Identity ${identityId} is inactive`);
  if (!identity.professor.isActive) {
    throw new DiscoveryPreconditionError(`The professor of identity ${identityId} is inactive`);
  }
  return { id: identity.id, professorId: identity.professorId, externalId: identity.externalId };
}
