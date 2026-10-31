import { Prisma, PrismaClient, PublicationSource, PublicationStatus, TypeFamily } from '@prisma/client';
import { prisma as defaultClient } from '../../config/database';
import { HttpError } from '../../utils/httpError';
import { scopusCitations } from '../citations/scopusCitations';
import { SOURCE_PRIORITY } from '../matching/canonical';
import { normalizeDoi } from '../normalization/doi';
import { normalizeTitle } from '../normalization/title';
import { CanonicalFields, CuratedField, curationJson, DeclaredBasis, readCuration } from './curation';

/**
 * Administrator publication management (Project_plan.md §6.4, §9, §15.1; Phase 13B, decisions
 * #90, #92 and #125). The administrator sees every publication, suppressed ones included, and may
 * edit canonical metadata (each changed field becomes curated with a declared basis, so
 * synchronization never recomputes it) or suppress/restore it. Suppression keeps all source records and relationships; restoring creates
 * no relationship. Professor-facing lists and analytics keep hiding suppressed publications.
 */

export const LIST_DEFAULT_LIMIT = 50;
export const LIST_MAX_LIMIT = 200;

export interface PublicationListQuery {
  q?: string;
  status?: PublicationStatus;
  typeFamily?: TypeFamily;
  curated?: boolean;
  limit: number;
  offset: number;
}

export interface PublicationEdit {
  title?: string;
  year?: number | null;
  venue?: string | null;
  typeFamily?: TypeFamily;
  authorNames?: string | null;
  doi?: string | null;
  /** Basis of every value this edit changes (#125); INDEPENDENT needs `evidence`. */
  basis: DeclaredBasis;
  evidence?: string | null;
}

const notFound = () => new HttpError(404, 'PUBLICATION_NOT_FOUND', 'Publication not found');

const summarySelect = {
  id: true,
  title: true,
  year: true,
  venue: true,
  typeFamily: true,
  authorNamesDisplay: true,
  doi: true,
  status: true,
  isCurated: true,
  createdAt: true,
  updatedAt: true,
  sourceRecords: { select: { source: true } },
  professors: { select: { status: true } },
} satisfies Prisma.PublicationSelect;

type SummaryRow = Prisma.PublicationGetPayload<{ select: typeof summarySelect }>;

/** Distinct sources in canonical priority order (OpenAlex, DBLP, ORCID, Manual). */
export function orderedSources(records: readonly { source: PublicationSource }[]): PublicationSource[] {
  return SOURCE_PRIORITY.filter((source) => records.some((r) => r.source === source));
}

export function toSummary(row: SummaryRow) {
  const { sourceRecords, professors, ...publication } = row;
  const count = (status: string) => professors.filter((p) => p.status === status).length;
  return {
    ...publication,
    sources: orderedSources(sourceRecords),
    sourceRecordCount: sourceRecords.length,
    relationshipCounts: { pending: count('PENDING'), approved: count('APPROVED'), rejected: count('REJECTED') },
  };
}

/**
 * One page of publications. `q` matches the normalized title (substring) or, when it is a DOI, the
 * canonical DOI exactly. Order: normalized title, then id.
 */
export async function listPublications(query: PublicationListQuery, client: PrismaClient = defaultClient) {
  const where: Prisma.PublicationWhereInput = {
    ...(query.status && { status: query.status }),
    ...(query.typeFamily && { typeFamily: query.typeFamily }),
    ...(query.curated !== undefined && { isCurated: query.curated }),
  };
  if (query.q !== undefined) {
    const title = normalizeTitle(query.q);
    const doi = normalizeDoi(query.q);
    const match: Prisma.PublicationWhereInput[] = [
      ...(title ? [{ normalizedTitle: { contains: title } }] : []),
      ...(doi ? [{ doi }] : []),
    ];
    if (match.length === 0) {
      throw new HttpError(400, 'VALIDATION_ERROR', 'Invalid query parameters', [{ path: 'q', message: 'No searchable text' }]);
    }
    where.OR = match;
  }
  const [rows, total] = await client.$transaction([
    client.publication.findMany({
      where,
      select: summarySelect,
      orderBy: [{ normalizedTitle: 'asc' }, { id: 'asc' }],
      take: query.limit,
      skip: query.offset,
    }),
    client.publication.count({ where }),
  ]);
  return { publications: rows.map(toSummary), total, limit: query.limit, offset: query.offset };
}

/** A publication with source-record summaries (no raw metadata), relationships and candidates. */
export async function getPublication(id: string, client: PrismaClient = defaultClient) {
  const publication = await client.publication.findUnique({
    where: { id },
    select: {
      ...summarySelect,
      curation: true,
      sourceRecords: {
        select: {
          id: true,
          source: true,
          externalId: true,
          title: true,
          doi: true,
          year: true,
          venue: true,
          typeFamily: true,
          authorNamesDisplay: true,
          matchMethod: true,
          matchDetail: true,
          entryBasis: true,
          entryEvidence: true,
          firstSeenAt: true,
          lastSeenAt: true,
        },
        orderBy: [{ source: 'asc' }, { firstSeenAt: 'asc' }, { id: 'asc' }],
      },
      professors: {
        select: {
          id: true,
          status: true,
          origin: true,
          decidedAt: true,
          createdAt: true,
          professor: { select: { id: true, name: true, isActive: true } },
          discoveredViaIdentity: { select: { id: true, source: true, externalId: true } },
        },
        orderBy: [{ professor: { name: 'asc' } }, { id: 'asc' }],
      },
    },
  });
  if (!publication) throw notFound();

  const other = { select: { id: true, title: true, year: true, typeFamily: true, doi: true, status: true } } as const;
  const candidates = await client.duplicateCandidate.findMany({
    where: { OR: [{ publicationAId: id }, { publicationBId: id }] },
    select: {
      id: true,
      reason: true,
      status: true,
      resolvedAt: true,
      createdAt: true,
      publicationAId: true,
      publicationA: other,
      publicationB: other,
    },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  });

  const { sourceRecords, professors, ...rest } = publication;
  const count = (status: string) => professors.filter((p) => p.status === status).length;
  return {
    ...rest,
    // Per curated field: basis and evidence (#125); a whole-record legacy curation reads as PRE_PHASE15.
    curation: readCuration(publication),
    sources: orderedSources(sourceRecords),
    sourceRecordCount: sourceRecords.length,
    // Scopus only, with attribution links (#112); Web of Science and JCR values are never returned.
    scopusCitation: (await scopusCitations([id], client)).get(id) ?? null,
    relationshipCounts: { pending: count('PENDING'), approved: count('APPROVED'), rejected: count('REJECTED') },
    sourceRecords,
    relationships: professors,
    duplicateCandidates: candidates.map((c) => ({
      id: c.id,
      reason: c.reason,
      status: c.status,
      resolvedAt: c.resolvedAt,
      createdAt: c.createdAt,
      otherPublication: c.publicationAId === id ? c.publicationB : c.publicationA,
    })),
  };
}

/**
 * Edits canonical metadata (§6.4, §9; #90, #125). Every field whose value actually changes gets a
 * curation entry with the declared basis — `INDEPENDENT` needs an evidence note — replacing any
 * earlier entry for that field; synchronization then leaves exactly those fields alone. Unchanged
 * fields are not recorded and an edit that changes nothing writes nothing. Title and DOI go
 * through the shared normalizers; a DOI owned by another publication → 409 DOI_IN_USE. Source
 * records are never changed. Relationships and their decisions are unaffected (§9).
 */
export async function updatePublication(id: string, edit: PublicationEdit, client: PrismaClient = defaultClient) {
  const evidence = edit.evidence?.trim() || null;
  if (edit.basis === 'INDEPENDENT' && !evidence) {
    throw new HttpError(400, 'EVIDENCE_REQUIRED', 'An independent value needs evidence (for example a DOI, publisher or repository URL)');
  }
  const requested: Partial<CanonicalFields> = {};
  if (edit.title !== undefined) {
    const normalizedTitle = normalizeTitle(edit.title);
    if (!normalizedTitle) throw new HttpError(400, 'INVALID_TITLE', 'The title has no usable text');
    requested.title = edit.title;
    requested.normalizedTitle = normalizedTitle;
  }
  if (edit.doi !== undefined) {
    const doi = edit.doi === null ? null : normalizeDoi(edit.doi);
    if (edit.doi !== null && !doi) throw new HttpError(400, 'INVALID_DOI', 'The DOI is not valid (expected e.g. 10.1234/abcd)');
    requested.doi = doi;
  }
  if (edit.year !== undefined) requested.year = edit.year;
  if (edit.venue !== undefined) requested.venue = edit.venue;
  if (edit.typeFamily !== undefined) requested.typeFamily = edit.typeFamily;
  if (edit.authorNames !== undefined) requested.authorNamesDisplay = edit.authorNames;

  try {
    await client.$transaction(async (tx) => {
      // The row lock orders this edit with canonical recomputation (engine.recomputeCanonical).
      const locked = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM publications WHERE id = ${id}::uuid FOR UPDATE`;
      if (locked.length === 0) throw notFound();
      const current = await tx.publication.findUniqueOrThrow({ where: { id } });

      const data: Prisma.PublicationUpdateInput = {};
      const curation = readCuration(current);
      const entry = { basis: edit.basis, evidence };
      for (const [field, column] of EDITABLE) {
        const value = requested[column];
        if (value === undefined || value === current[column]) continue;
        if (column === 'title') {
          data.title = requested.title;
          data.normalizedTitle = requested.normalizedTitle;
        } else {
          (data as Record<string, unknown>)[column] = value;
        }
        curation[field] = entry;
      }
      if (Object.keys(data).length === 0) return;

      if (typeof data.doi === 'string') {
        const owner = await tx.publication.findFirst({ where: { doi: data.doi, id: { not: id } }, select: { id: true } });
        if (owner) throw doiInUse(owner.id);
      }
      await tx.publication.update({ where: { id }, data: { ...data, curation: curationJson(curation), isCurated: true } });
    });
  } catch (error) {
    // A concurrent change claimed the DOI between the check and the update.
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') throw doiInUse(null);
    throw error;
  }
  return getPublication(id, client);
}

/** Curated fields and their `publications` columns, in curation order. */
const EDITABLE: readonly [CuratedField, Exclude<keyof CanonicalFields, 'normalizedTitle'>][] = [
  ['title', 'title'],
  ['year', 'year'],
  ['venue', 'venue'],
  ['type_family', 'typeFamily'],
  ['author_names_display', 'authorNamesDisplay'],
  ['doi', 'doi'],
];

function doiInUse(publicationId: string | null) {
  return new HttpError(409, 'DOI_IN_USE', 'This DOI already belongs to another publication', publicationId ? { publicationId } : undefined);
}

/**
 * Suppresses or restores a publication with optimistic concurrency (#92):
 *   404 PUBLICATION_NOT_FOUND; 409 STATUS_CONFLICT (current status is not `expected`, with the
 *   current status); 409 INVALID_TRANSITION (`status` equals the current status).
 * Source records, relationships and candidates are kept; restoring creates no relationship.
 */
export async function setPublicationStatus(
  id: string,
  status: PublicationStatus,
  expected: PublicationStatus,
  client: PrismaClient = defaultClient,
) {
  const attempted = status !== expected;
  if (attempted) {
    const { count } = await client.publication.updateMany({ where: { id, status: expected }, data: { status } });
    if (count === 1) return getPublication(id, client);
  }
  const current = await client.publication.findUnique({ where: { id }, select: { status: true } });
  if (!current) throw notFound();
  if (attempted || current.status !== expected) {
    throw new HttpError(409, 'STATUS_CONFLICT', 'The publication was changed meanwhile; reload and try again', {
      currentStatus: current.status,
    });
  }
  throw new HttpError(409, 'INVALID_TRANSITION', `The publication is already ${current.status}`, { currentStatus: current.status });
}
