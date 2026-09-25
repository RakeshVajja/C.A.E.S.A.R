import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '../src/config/database';
import { resetDatabase } from './helpers/database';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

beforeEach(async () => {
  await resetDatabase();
});

afterAll(async () => {
  await resetDatabase();
  await prisma.$disconnect();
});

function createProfessor(name = 'Test Professor') {
  return prisma.professor.create({ data: { name } });
}

function createPublication(overrides: { doi?: string | null; title?: string } = {}) {
  const title = overrides.title ?? 'A Study of Things';
  return prisma.publication.create({
    data: {
      title,
      normalizedTitle: title.toLowerCase(),
      typeFamily: 'JOURNAL',
      year: 2024,
      doi: overrides.doi ?? null,
    },
  });
}

function createSourceRecord(publicationId: string, source: 'OPENALEX' | 'DBLP' | 'ORCID' | 'MANUAL', externalId: string) {
  return prisma.publicationSourceRecord.create({
    data: {
      publicationId,
      source,
      externalId,
      title: 'A Study of Things',
      normalizedTitle: 'a study of things',
      typeFamily: 'JOURNAL',
      matchMethod: 'NEW_PUBLICATION',
    },
  });
}

describe('conventions', () => {
  it('uses UUID primary keys and defaults', async () => {
    const professor = await createProfessor();
    expect(professor.id).toMatch(UUID);
    expect(professor.isActive).toBe(true);
    expect(professor.createdAt).toBeInstanceOf(Date);

    const publication = await createPublication();
    expect(publication.status).toBe('ACTIVE');
    expect(publication.isCurated).toBe(false);
  });
});

describe('User', () => {
  it('enforces unique email', async () => {
    await prisma.user.create({ data: { email: 'a@example.edu', passwordHash: 'x', role: 'ADMIN' } });
    await expect(
      prisma.user.create({ data: { email: 'a@example.edu', passwordHash: 'y', role: 'PROFESSOR' } }),
    ).rejects.toMatchObject({ code: 'P2002' });
  });

  it('links to at most one professor and unlinks when the user is deleted', async () => {
    const user = await prisma.user.create({ data: { email: 'p@example.edu', passwordHash: 'x', role: 'PROFESSOR' } });
    const professor = await prisma.professor.create({ data: { name: 'P', userId: user.id } });
    await expect(prisma.professor.create({ data: { name: 'Q', userId: user.id } })).rejects.toMatchObject({
      code: 'P2002',
    });

    await prisma.user.delete({ where: { id: user.id } });
    expect((await prisma.professor.findUniqueOrThrow({ where: { id: professor.id } })).userId).toBeNull();
  });
});

describe('ExternalIdentity', () => {
  it('allows several identities per source for one professor', async () => {
    const professor = await createProfessor();
    await prisma.externalIdentity.create({ data: { professorId: professor.id, source: 'OPENALEX', externalId: 'A1' } });
    await prisma.externalIdentity.create({ data: { professorId: professor.id, source: 'OPENALEX', externalId: 'A2' } });
    expect(await prisma.externalIdentity.count({ where: { professorId: professor.id } })).toBe(2);
  });

  it('never lets one identity belong to two professors', async () => {
    const a = await createProfessor('A');
    const b = await createProfessor('B');
    await prisma.externalIdentity.create({ data: { professorId: a.id, source: 'DBLP', externalId: 'v/Someone' } });
    await expect(
      prisma.externalIdentity.create({ data: { professorId: b.id, source: 'DBLP', externalId: 'v/Someone' } }),
    ).rejects.toMatchObject({ code: 'P2002' });
  });

  it('allows the same external id string under different sources', async () => {
    const professor = await createProfessor();
    await prisma.externalIdentity.create({ data: { professorId: professor.id, source: 'OPENALEX', externalId: 'X' } });
    await prisma.externalIdentity.create({ data: { professorId: professor.id, source: 'ORCID', externalId: 'X' } });
  });

  it('prevents hard-deleting a professor who has identities', async () => {
    const professor = await createProfessor();
    await prisma.externalIdentity.create({ data: { professorId: professor.id, source: 'ORCID', externalId: 'O1' } });
    await expect(prisma.professor.delete({ where: { id: professor.id } })).rejects.toMatchObject({ code: 'P2003' });
  });
});

describe('Publication', () => {
  it('enforces unique DOI but allows many publications without a DOI', async () => {
    await createPublication({ doi: '10.1000/abc' });
    await expect(createPublication({ doi: '10.1000/abc' })).rejects.toMatchObject({ code: 'P2002' });

    await createPublication({ doi: null });
    await createPublication({ doi: null });
    expect(await prisma.publication.count({ where: { doi: null } })).toBe(2);
  });

  it('cannot be deleted while source records reference it', async () => {
    const publication = await createPublication();
    await createSourceRecord(publication.id, 'OPENALEX', 'W1');
    await expect(prisma.publication.delete({ where: { id: publication.id } })).rejects.toMatchObject({
      code: 'P2003',
    });
  });
});

describe('PublicationSourceRecord', () => {
  it('lets OpenAlex, DBLP, ORCID and MANUAL records share one canonical publication', async () => {
    const publication = await createPublication({ doi: '10.1000/shared' });
    await createSourceRecord(publication.id, 'OPENALEX', 'W100');
    await createSourceRecord(publication.id, 'DBLP', 'conf/x/Y24');
    await createSourceRecord(publication.id, 'ORCID', '0000-0002-0000-0000:123');
    await createSourceRecord(publication.id, 'MANUAL', 'd2a3b8a2-3c1e-4c55-9d8e-2f5c1b7a9e01');

    const records = await prisma.publicationSourceRecord.findMany({ where: { publicationId: publication.id } });
    expect(records.map((r) => r.source).sort()).toEqual(['DBLP', 'MANUAL', 'OPENALEX', 'ORCID']);
  });

  it('allows two records from the same source on one publication (in-source duplicates)', async () => {
    const publication = await createPublication();
    await createSourceRecord(publication.id, 'OPENALEX', 'W1');
    await createSourceRecord(publication.id, 'OPENALEX', 'W2');
  });

  it('enforces unique (source, external_id)', async () => {
    const a = await createPublication({ title: 'A' });
    const b = await createPublication({ title: 'B' });
    await createSourceRecord(a.id, 'OPENALEX', 'W1');
    await expect(createSourceRecord(b.id, 'OPENALEX', 'W1')).rejects.toMatchObject({ code: 'P2002' });
  });

  it('stores raw metadata as JSON', async () => {
    const publication = await createPublication();
    const record = await prisma.publicationSourceRecord.create({
      data: {
        publicationId: publication.id,
        source: 'DBLP',
        externalId: 'journals/x/Y24',
        title: 'T',
        normalizedTitle: 't',
        typeFamily: 'JOURNAL',
        matchMethod: 'DOI',
        rawMetadata: { key: 'journals/x/Y24', dois: ['10.1/a', '10.1/b'] },
      },
    });
    expect(record.rawMetadata).toEqual({ key: 'journals/x/Y24', dois: ['10.1/a', '10.1/b'] });
  });
});

describe('ProfessorPublication', () => {
  it('lets one publication be APPROVED, PENDING and REJECTED for different professors', async () => {
    const publication = await createPublication();
    const [a, b, c] = await Promise.all([createProfessor('A'), createProfessor('B'), createProfessor('C')]);

    await prisma.professorPublication.create({
      data: { professorId: a.id, publicationId: publication.id, origin: 'DISCOVERED', status: 'APPROVED' },
    });
    const pending = await prisma.professorPublication.create({
      data: { professorId: b.id, publicationId: publication.id, origin: 'DISCOVERED' },
    });
    await prisma.professorPublication.create({
      data: { professorId: c.id, publicationId: publication.id, origin: 'DISCOVERED', status: 'REJECTED' },
    });

    expect(pending.status).toBe('PENDING');
    const statuses = await prisma.professorPublication.findMany({ where: { publicationId: publication.id } });
    expect(statuses.map((s) => s.status).sort()).toEqual(['APPROVED', 'PENDING', 'REJECTED']);
  });

  it('enforces one relationship per professor and publication', async () => {
    const publication = await createPublication();
    const professor = await createProfessor();
    await prisma.professorPublication.create({
      data: { professorId: professor.id, publicationId: publication.id, origin: 'DISCOVERED' },
    });
    await expect(
      prisma.professorPublication.create({
        data: { professorId: professor.id, publicationId: publication.id, origin: 'MANUAL' },
      }),
    ).rejects.toMatchObject({ code: 'P2002' });
  });

  it('keeps the relationship but clears discovered_via_identity_id when the identity is deleted', async () => {
    const publication = await createPublication();
    const professor = await createProfessor();
    const identity = await prisma.externalIdentity.create({
      data: { professorId: professor.id, source: 'OPENALEX', externalId: 'A9' },
    });
    const link = await prisma.professorPublication.create({
      data: {
        professorId: professor.id,
        publicationId: publication.id,
        origin: 'DISCOVERED',
        discoveredViaIdentityId: identity.id,
      },
    });

    await prisma.externalIdentity.delete({ where: { id: identity.id } });

    const after = await prisma.professorPublication.findUniqueOrThrow({ where: { id: link.id } });
    expect(after.discoveredViaIdentityId).toBeNull();
    expect(after.status).toBe('PENDING');
  });

  it('prevents deleting a publication that professors are linked to', async () => {
    const publication = await createPublication();
    const professor = await createProfessor();
    await prisma.professorPublication.create({
      data: { professorId: professor.id, publicationId: publication.id, origin: 'MANUAL', status: 'APPROVED' },
    });
    await expect(prisma.publication.delete({ where: { id: publication.id } })).rejects.toMatchObject({
      code: 'P2003',
    });
  });
});

describe('DuplicateCandidate', () => {
  async function orderedPair() {
    const [x, y] = await Promise.all([createPublication({ title: 'X' }), createPublication({ title: 'Y' })]);
    return x.id < y.id ? [x.id, y.id] : [y.id, x.id];
  }

  it('stores a pair once in canonical order', async () => {
    const [low, high] = await orderedPair();
    await prisma.duplicateCandidate.create({ data: { publicationAId: low, publicationBId: high, reason: 'test' } });
    await expect(
      prisma.duplicateCandidate.create({ data: { publicationAId: low, publicationBId: high, reason: 'again' } }),
    ).rejects.toMatchObject({ code: 'P2002' });
  });

  it('rejects reversed or self pairs', async () => {
    const [low, high] = await orderedPair();
    await expect(
      prisma.duplicateCandidate.create({ data: { publicationAId: high, publicationBId: low, reason: 'reversed' } }),
    ).rejects.toThrow(/duplicate_candidates_ordered_pair_check/);
    await expect(
      prisma.duplicateCandidate.create({ data: { publicationAId: low, publicationBId: low, reason: 'self' } }),
    ).rejects.toThrow(/duplicate_candidates_ordered_pair_check/);
  });

  it('keeps a resolved candidate when a merged-away publication is removed', async () => {
    const [low, high] = await orderedPair();
    const candidate = await prisma.duplicateCandidate.create({
      data: { publicationAId: low, publicationBId: high, reason: 'title match blocked by type', status: 'MERGED' },
    });

    await prisma.publication.delete({ where: { id: high } });

    const after = await prisma.duplicateCandidate.findUniqueOrThrow({ where: { id: candidate.id } });
    expect(after.publicationBId).toBeNull();
    expect(after.status).toBe('MERGED');
  });
});

describe('SyncRun / SyncTask', () => {
  it('creates a run with a task per identity and cascades tasks when the run is deleted', async () => {
    const professor = await createProfessor();
    const identity = await prisma.externalIdentity.create({
      data: { professorId: professor.id, source: 'ORCID', externalId: '0000-0001-0000-0000' },
    });
    const run = await prisma.syncRun.create({
      data: { trigger: 'MANUAL', tasks: { create: [{ identityId: identity.id, source: 'ORCID' }] } },
      include: { tasks: true },
    });

    expect(run.status).toBe('RUNNING');
    expect(run.tasks[0].status).toBe('PENDING');

    await prisma.syncRun.delete({ where: { id: run.id } });
    expect(await prisma.syncTask.count()).toBe(0);
  });

  it('keeps task history when an identity is deleted', async () => {
    const professor = await createProfessor();
    const identity = await prisma.externalIdentity.create({
      data: { professorId: professor.id, source: 'DBLP', externalId: 'v/X' },
    });
    const run = await prisma.syncRun.create({
      data: { trigger: 'SCHEDULED', tasks: { create: [{ identityId: identity.id, source: 'DBLP', status: 'FAILED' }] } },
      include: { tasks: true },
    });

    await prisma.externalIdentity.delete({ where: { id: identity.id } });

    const task = await prisma.syncTask.findUniqueOrThrow({ where: { id: run.tasks[0].id } });
    expect(task.identityId).toBeNull();
    expect(task.status).toBe('FAILED');
  });
});
