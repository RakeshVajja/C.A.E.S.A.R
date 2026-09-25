/**
 * Minimal development seed: demo data that exercises every relationship of the
 * 9-table model. Idempotent (fixed IDs + upserts), so it can be re-run safely.
 *
 * The admin account is NOT created here: it needs password hashing (Phase 8).
 * All identifiers below are obviously fake and do not refer to real researchers.
 */
import { prisma } from '../src/config/database';
import { env } from '../src/config/env';

const ids = {
  profA: '00000000-0000-4000-8000-00000000000a',
  profB: '00000000-0000-4000-8000-00000000000b',
  identityAOpenAlex: '00000000-0000-4000-8000-0000000000a1',
  identityADblp: '00000000-0000-4000-8000-0000000000a2',
  identityBOrcid: '00000000-0000-4000-8000-0000000000b1',
  pubShared: '00000000-0000-4000-8000-000000000101',
  pubManual: '00000000-0000-4000-8000-000000000102',
  pubPreprint: '00000000-0000-4000-8000-000000000103',
  manualRecord: '00000000-0000-4000-8000-000000000201',
};

async function main(): Promise<void> {
  if (env.nodeEnv === 'production') {
    throw new Error('The development seed must not run in production');
  }

  const profA = await prisma.professor.upsert({
    where: { id: ids.profA },
    update: {},
    create: { id: ids.profA, name: 'Demo Professor A', department: 'CSE', designation: 'Professor' },
  });
  const profB = await prisma.professor.upsert({
    where: { id: ids.profB },
    update: {},
    create: { id: ids.profB, name: 'Demo Professor B', department: 'CSE', designation: 'Associate Professor' },
  });

  const identities = [
    { id: ids.identityAOpenAlex, professorId: profA.id, source: 'OPENALEX', externalId: 'A0000000001' },
    { id: ids.identityADblp, professorId: profA.id, source: 'DBLP', externalId: 'd/DemoProfessorA' },
    { id: ids.identityBOrcid, professorId: profB.id, source: 'ORCID', externalId: '0000-0000-0000-0001' },
  ] as const;
  for (const identity of identities) {
    await prisma.externalIdentity.upsert({
      where: { source_externalId: { source: identity.source, externalId: identity.externalId } },
      update: {},
      create: { ...identity, verifiedAt: new Date() },
    });
  }

  // One publication co-authored by both professors, seen in OpenAlex, DBLP and ORCID.
  const shared = await prisma.publication.upsert({
    where: { id: ids.pubShared },
    update: {},
    create: {
      id: ids.pubShared,
      title: 'A Demo Study of Deterministic Deduplication',
      normalizedTitle: 'a demo study of deterministic deduplication',
      year: 2024,
      venue: 'Demo Conference on Data Quality',
      typeFamily: 'CONFERENCE',
      authorNamesDisplay: 'Demo Professor A, Demo Professor B',
      doi: '10.0000/demo.2024.001',
    },
  });
  const sharedRecords = [
    { source: 'OPENALEX', externalId: 'W0000000001', matchMethod: 'NEW_PUBLICATION', detail: 'first record' },
    { source: 'DBLP', externalId: 'conf/demo/AB24', matchMethod: 'DOI', detail: 'matched on DOI 10.0000/demo.2024.001' },
    { source: 'ORCID', externalId: '0000-0000-0000-0001:1001', matchMethod: 'DOI', detail: 'matched on DOI 10.0000/demo.2024.001' },
  ] as const;
  for (const record of sharedRecords) {
    await prisma.publicationSourceRecord.upsert({
      where: { source_externalId: { source: record.source, externalId: record.externalId } },
      update: {},
      create: {
        publicationId: shared.id,
        source: record.source,
        externalId: record.externalId,
        title: shared.title,
        normalizedTitle: shared.normalizedTitle,
        doi: shared.doi,
        year: shared.year,
        venue: shared.venue,
        typeFamily: shared.typeFamily,
        rawMetadata: { demo: true },
        matchMethod: record.matchMethod,
        matchDetail: record.detail,
        lastSeenAt: new Date(),
      },
    });
  }

  // A preprint kept separate from the published version (same title, no DOI).
  const preprint = await prisma.publication.upsert({
    where: { id: ids.pubPreprint },
    update: {},
    create: {
      id: ids.pubPreprint,
      title: 'A Demo Study of Deterministic Deduplication',
      normalizedTitle: 'a demo study of deterministic deduplication',
      year: 2024,
      venue: 'CoRR',
      typeFamily: 'PREPRINT',
    },
  });
  await prisma.publicationSourceRecord.upsert({
    where: { source_externalId: { source: 'DBLP', externalId: 'journals/corr/abs-0000-00001' } },
    update: {},
    create: {
      publicationId: preprint.id,
      source: 'DBLP',
      externalId: 'journals/corr/abs-0000-00001',
      title: preprint.title,
      normalizedTitle: preprint.normalizedTitle,
      year: preprint.year,
      venue: preprint.venue,
      typeFamily: 'PREPRINT',
      rawMetadata: { demo: true },
      matchMethod: 'NEW_PUBLICATION',
      matchDetail: 'preprint vs published veto',
      lastSeenAt: new Date(),
    },
  });

  // A publication added manually by Professor B.
  const manual = await prisma.publication.upsert({
    where: { id: ids.pubManual },
    update: {},
    create: {
      id: ids.pubManual,
      title: 'Notes on a Manually Added Demo Paper',
      normalizedTitle: 'notes on a manually added demo paper',
      year: 2023,
      typeFamily: 'JOURNAL',
    },
  });
  await prisma.publicationSourceRecord.upsert({
    where: { source_externalId: { source: 'MANUAL', externalId: ids.manualRecord } },
    update: {},
    create: {
      publicationId: manual.id,
      source: 'MANUAL',
      externalId: ids.manualRecord,
      title: manual.title,
      normalizedTitle: manual.normalizedTitle,
      year: manual.year,
      typeFamily: manual.typeFamily,
      matchMethod: 'NEW_PUBLICATION',
    },
  });

  const links = [
    { professorId: profA.id, publicationId: shared.id, status: 'APPROVED', origin: 'DISCOVERED', via: ids.identityAOpenAlex },
    { professorId: profB.id, publicationId: shared.id, status: 'PENDING', origin: 'DISCOVERED', via: ids.identityBOrcid },
    { professorId: profA.id, publicationId: preprint.id, status: 'PENDING', origin: 'DISCOVERED', via: ids.identityADblp },
    { professorId: profB.id, publicationId: manual.id, status: 'APPROVED', origin: 'MANUAL', via: null },
  ] as const;
  for (const link of links) {
    await prisma.professorPublication.upsert({
      where: { professorId_publicationId: { professorId: link.professorId, publicationId: link.publicationId } },
      update: {},
      create: {
        professorId: link.professorId,
        publicationId: link.publicationId,
        status: link.status,
        origin: link.origin,
        discoveredViaIdentityId: link.via,
        decidedAt: link.status === 'PENDING' ? null : new Date(),
      },
    });
  }

  // The published paper and its preprint share a title: recorded as a candidate, not merged.
  const [low, high] = [shared.id, preprint.id].sort();
  await prisma.duplicateCandidate.upsert({
    where: { publicationAId_publicationBId: { publicationAId: low, publicationBId: high } },
    update: {},
    create: { publicationAId: low, publicationBId: high, reason: 'Exact title match blocked by preprint veto' },
  });

  const counts = {
    professors: await prisma.professor.count(),
    identities: await prisma.externalIdentity.count(),
    publications: await prisma.publication.count(),
    sourceRecords: await prisma.publicationSourceRecord.count(),
    relationships: await prisma.professorPublication.count(),
    duplicateCandidates: await prisma.duplicateCandidate.count(),
  };
  console.log('Development seed complete:', counts);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
