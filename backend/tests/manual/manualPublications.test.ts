import request from 'supertest';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../../src/app';
import { prisma } from '../../src/config/database';
import { mapOpenAlexWork } from '../../src/integrations/openalex/mapper';
import { OpenAlexWorkSchema } from '../../src/integrations/openalex/types';
import { OrcidClient } from '../../src/integrations/orcid/client';
import { ingestDiscoveredRecords } from '../../src/services/discovery/ingestDiscoveredRecords';
import { discoverOrcidIdentity } from '../../src/services/discovery/orcidDiscovery';
import { cookiePair, createUser, PASSWORD, testClock } from '../auth/helpers';
import { resetDatabase } from '../helpers/database';
import { loadFixture, noSleep, replayFetch } from '../helpers/fixtures';
import { tableCounts } from '../professors/helpers';

/* Manual publication addition (Project_plan.md §12; Phase 11). */

beforeEach(async () => {
  await resetDatabase();
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await resetDatabase();
  await prisma.$disconnect();
});

const NOW = '2026-10-14T15:00:00.000Z';

async function professor(server: ReturnType<typeof createApp>, email: string) {
  const user = await createUser({ email, professor: 'active' });
  const prof = await prisma.professor.findUniqueOrThrow({ where: { userId: user.id } });
  const cookie = cookiePair(await request(server).post('/api/auth/login').send({ email, password: PASSWORD }), 'cse_session');
  return { user, professor: prof, cookie };
}

async function setup() {
  const server = createApp({ mailer: null, now: testClock(NOW).now });
  const a = await professor(server, 'a@example.org');
  const b = await professor(server, 'b@example.org');
  const add = (body: Record<string, unknown>, cookie = a.cookie) => request(server).post('/api/me/publications').set('Cookie', cookie).send(body);
  return { server, a, b, add };
}

/** An existing publication with one discovered source record (as a sync would leave it). */
async function discovered(options: { title: string; year: number | null; typeFamily?: 'JOURNAL' | 'CONFERENCE' | 'PREPRINT'; doi?: string | null; status?: 'ACTIVE' | 'SUPPRESSED'; isCurated?: boolean }) {
  const typeFamily = options.typeFamily ?? 'JOURNAL';
  const normalizedTitle = options.title.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  return prisma.publication.create({
    data: {
      title: options.title,
      normalizedTitle,
      year: options.year,
      typeFamily,
      doi: options.doi ?? null,
      status: options.status ?? 'ACTIVE',
      isCurated: options.isCurated ?? false,
      sourceRecords: {
        create: {
          source: 'DBLP',
          externalId: `journals/x/${normalizedTitle.replace(/ /g, '')}`,
          title: options.title,
          normalizedTitle,
          year: options.year,
          typeFamily,
          doi: options.doi ?? null,
          matchMethod: 'NEW_PUBLICATION',
          lastSeenAt: new Date(NOW),
        },
      },
    },
  });
}

describe('access and validation', () => {
  it('requires an active professor session without a temporary password; same-origin JSON only', async () => {
    const { server, a, add } = await setup();
    const body = { title: 'A Manual Paper', typeFamily: 'JOURNAL' };
    expect((await request(server).post('/api/me/publications').send(body)).status).toBe(401);

    await createUser({ email: 'admin@example.org', role: 'ADMIN' });
    const admin = cookiePair(await request(server).post('/api/auth/login').send({ email: 'admin@example.org', password: PASSWORD }), 'cse_session');
    expect((await add(body, admin)).body.error.code).toBe('FORBIDDEN');

    await createUser({ email: 'temp@example.org', professor: 'active', mustChangePassword: true });
    const temp = cookiePair(await request(server).post('/api/auth/login').send({ email: 'temp@example.org', password: PASSWORD }), 'cse_session');
    expect((await add(body, temp)).body.error.code).toBe('PASSWORD_CHANGE_REQUIRED');

    await createUser({ email: 'unlinked@example.org' });
    const unlinked = cookiePair(await request(server).post('/api/auth/login').send({ email: 'unlinked@example.org', password: PASSWORD }), 'cse_session');
    expect((await add(body, unlinked)).body.error.code).toBe('PROFILE_NOT_FOUND');

    const before = await tableCounts();
    expect((await request(server).post('/api/me/publications').set('Cookie', a.cookie).set('Origin', 'https://evil.example').send(body)).body.error.code).toBe('ORIGIN_NOT_ALLOWED');
    expect((await request(server).post('/api/me/publications').set('Cookie', a.cookie).type('form').send(body)).status).toBe(400);

    await prisma.professor.update({ where: { id: a.professor.id }, data: { isActive: false } });
    expect((await add(body)).status).toBe(401);
    expect(await tableCounts()).toEqual(before);
  });

  it('requires title and type family; refuses invalid values, unknown fields and content fields', async () => {
    const { a, b, add } = await setup();
    const before = await tableCounts();
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ typeFamily: 'JOURNAL' }, 'VALIDATION_ERROR'],
      [{ title: 'A Paper Title' }, 'VALIDATION_ERROR'],
      [{ title: '   ', typeFamily: 'JOURNAL' }, 'VALIDATION_ERROR'],
      [{ title: 'A Paper Title', typeFamily: 'THESIS' }, 'VALIDATION_ERROR'],
      [{ title: 'A Paper Title', typeFamily: 'JOURNAL', year: 999 }, 'VALIDATION_ERROR'],
      [{ title: 'A Paper Title', typeFamily: 'JOURNAL', year: 2020.5 }, 'VALIDATION_ERROR'],
      [{ title: 'A Paper Title', typeFamily: 'JOURNAL', abstract: 'never stored' }, 'VALIDATION_ERROR'],
      [{ title: 'A Paper Title', typeFamily: 'JOURNAL', fullText: 'never stored' }, 'VALIDATION_ERROR'],
      [{ title: 'A Paper Title', typeFamily: 'JOURNAL', pdfUrl: 'https://x/y.pdf' }, 'VALIDATION_ERROR'],
      [{ title: 'A Paper Title', typeFamily: 'JOURNAL', professorId: b.professor.id }, 'VALIDATION_ERROR'],
      [{ title: 'A Paper Title', typeFamily: 'JOURNAL', status: 'PENDING' }, 'VALIDATION_ERROR'],
      [{ title: 'A Paper Title', typeFamily: 'JOURNAL', doi: 'not a doi' }, 'INVALID_DOI'],
      [{ title: '!!! ???', typeFamily: 'JOURNAL' }, 'INVALID_TITLE'],
    ];
    for (const [body, code] of cases) {
      const res = await add(body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(res.body.error.code, JSON.stringify(body)).toBe(code);
    }
    expect(await tableCounts()).toEqual(before);
    void a;
  });
});

describe('new publications', () => {
  it('creates a canonical publication, a MANUAL source record and an APPROVED/MANUAL relationship', async () => {
    const { a, add } = await setup();
    const res = await add({
      title: '  A Manually Added Paper  ',
      typeFamily: 'JOURNAL',
      doi: 'https://doi.org/10.5555/MANUAL.1',
      year: 2022,
      venue: 'Journal of Examples',
      authorNames: 'A. Author, B. Author',
    });
    expect(res.status).toBe(201);
    expect(res.body.match).toEqual({ outcome: 'NEW_PUBLICATION', candidatesCreated: 0, relationship: 'CREATED' });
    expect(res.body.item).toMatchObject({
      status: 'APPROVED',
      origin: 'MANUAL',
      decidedAt: NOW,
      publication: {
        title: 'A Manually Added Paper',
        year: 2022,
        venue: 'Journal of Examples',
        typeFamily: 'JOURNAL',
        doi: '10.5555/manual.1',
        authorNamesDisplay: 'A. Author, B. Author',
        sources: ['MANUAL'],
      },
    });

    const record = await prisma.publicationSourceRecord.findFirstOrThrow({ where: { source: 'MANUAL' } });
    expect(record).toMatchObject({
      publicationId: res.body.item.publication.id,
      createdByUserId: a.user.id,
      matchMethod: 'NEW_PUBLICATION',
      doi: '10.5555/manual.1',
      lastSeenAt: null,
      rawMetadata: { _normalizedDois: ['10.5555/manual.1'] }, // the DOI list only; no content
    });
    expect(record.externalId).toMatch(/^[0-9a-f-]{36}$/);
    expect(await prisma.professorPublication.findUniqueOrThrow({ where: { id: res.body.item.id } })).toMatchObject({
      professorId: a.professor.id,
      status: 'APPROVED',
      origin: 'MANUAL',
      decidedAt: new Date(NOW),
      decidedByUserId: a.user.id,
      discoveredViaIdentityId: null,
    });
  });
});

describe('matching existing publications (rules 1–3, §12.2–12.3)', () => {
  it('DOI match: links to the existing publication and upgrades the professor\'s PENDING link; others are untouched', async () => {
    const { a, b, add } = await setup();
    const existing = await discovered({ title: 'Shared Results', year: 2020, doi: '10.1000/shared' });
    const pending = await prisma.professorPublication.create({ data: { professorId: a.professor.id, publicationId: existing.id, status: 'PENDING', origin: 'DISCOVERED' } });
    const bLink = await prisma.professorPublication.create({ data: { professorId: b.professor.id, publicationId: existing.id, status: 'PENDING', origin: 'DISCOVERED' } });

    const res = await add({ title: 'Shared Results', typeFamily: 'JOURNAL', doi: '10.1000/SHARED', year: 2020 });
    expect(res.body.match).toEqual({ outcome: 'MATCHED_DOI', candidatesCreated: 0, relationship: 'UPGRADED' });
    expect(res.body.item).toMatchObject({ id: pending.id, status: 'APPROVED', origin: 'MANUAL', publication: { id: existing.id, sources: ['DBLP', 'MANUAL'] } });
    expect(await prisma.publication.count()).toBe(1);
    expect(await prisma.professorPublication.findUniqueOrThrow({ where: { id: pending.id } })).toMatchObject({ decidedByUserId: a.user.id, decidedAt: new Date(NOW) });
    expect(await prisma.professorPublication.findUniqueOrThrow({ where: { id: bLink.id } })).toMatchObject({ status: 'PENDING', decidedAt: null });
  });

  it('upgrades a REJECTED relationship (explicit assertion, §12.2) and leaves an APPROVED one unchanged', async () => {
    const { a, add } = await setup();
    const rejectedPub = await discovered({ title: 'Once Rejected', year: 2019, doi: '10.1000/rejected' });
    const rejected = await prisma.professorPublication.create({
      data: { professorId: a.professor.id, publicationId: rejectedPub.id, status: 'REJECTED', origin: 'DISCOVERED', decidedAt: new Date('2026-01-01T00:00:00Z') },
    });
    const up = await add({ title: 'Once Rejected', typeFamily: 'JOURNAL', doi: '10.1000/rejected' });
    expect(up.body.match.relationship).toBe('UPGRADED');
    expect(await prisma.professorPublication.findUniqueOrThrow({ where: { id: rejected.id } })).toMatchObject({ status: 'APPROVED', origin: 'MANUAL', decidedAt: new Date(NOW) });

    const approvedPub = await discovered({ title: 'Already Approved', year: 2018, doi: '10.1000/approved' });
    const decidedAt = new Date('2026-02-02T00:00:00Z');
    const approved = await prisma.professorPublication.create({
      data: { professorId: a.professor.id, publicationId: approvedPub.id, status: 'APPROVED', origin: 'DISCOVERED', decidedAt, decidedByUserId: a.user.id },
    });
    const same = await add({ title: 'Already Approved', typeFamily: 'JOURNAL', doi: '10.1000/approved' });
    expect(same.body.match).toEqual({ outcome: 'MATCHED_DOI', candidatesCreated: 0, relationship: 'UNCHANGED' });
    expect(await prisma.professorPublication.findUniqueOrThrow({ where: { id: approved.id } })).toMatchObject({ status: 'APPROVED', origin: 'DISCOVERED', decidedAt });
  });

  it('exact title + year ±1 with the same known type family: links to the existing publication', async () => {
    const { add } = await setup();
    const existing = await discovered({ title: 'Model Checking Without DOIs', year: 2015 });
    const res = await add({ title: 'Model checking without DOIs.', typeFamily: 'JOURNAL', year: 2016 });
    expect(res.body.match).toMatchObject({ outcome: 'MATCHED_TITLE_YEAR', relationship: 'CREATED' });
    expect(res.body.item.publication.id).toBe(existing.id);
    expect(await prisma.publication.count()).toBe(1);
  });

  it('uncertain match (unknown year, or another type family): a new publication plus a DuplicateCandidate, never silent', async () => {
    const { add } = await setup();
    const existing = await discovered({ title: 'Ambiguous Findings', year: 2015 });
    const noYear = await add({ title: 'Ambiguous Findings', typeFamily: 'JOURNAL' });
    expect(noYear.body.match).toEqual({ outcome: 'NEW_PUBLICATION', candidatesCreated: 1, relationship: 'CREATED' });
    const otherType = await add({ title: 'Ambiguous Findings', typeFamily: 'CONFERENCE', year: 2015 });
    expect(otherType.body.match.outcome).toBe('NEW_PUBLICATION');
    expect(otherType.body.match.candidatesCreated).toBeGreaterThanOrEqual(1);

    const candidates = await prisma.duplicateCandidate.findMany();
    const ids = [existing.id, noYear.body.item.publication.id];
    expect(candidates.some((c) => ids.includes(c.publicationAId!) && ids.includes(c.publicationBId!))).toBe(true);
    expect(candidates.find((c) => [c.publicationAId, c.publicationBId].includes(existing.id))?.reason).toMatch(/year unknown/);
  });

  it('a curated publication keeps its canonical metadata when a manual entry attaches to it', async () => {
    const { add } = await setup();
    const curated = await discovered({ title: 'Curated Work', year: 2020, doi: '10.1000/curated', isCurated: true });
    await prisma.publication.update({ where: { id: curated.id }, data: { title: 'Curated Work (Admin Edited)', venue: 'Curated Venue' } });
    const res = await add({ title: 'Curated Work', typeFamily: 'JOURNAL', doi: '10.1000/curated', year: 2021, venue: 'Manual Venue' });
    expect(res.body.match.outcome).toBe('MATCHED_DOI');
    expect(await prisma.publication.findUniqueOrThrow({ where: { id: curated.id } })).toMatchObject({ title: 'Curated Work (Admin Edited)', venue: 'Curated Venue', year: 2020 });
  });

  it('a match with a SUPPRESSED publication is refused and nothing is stored', async () => {
    const { add } = await setup();
    await discovered({ title: 'Withdrawn Paper', year: 2020, doi: '10.1000/withdrawn', status: 'SUPPRESSED' });
    const before = await tableCounts();
    const res = await add({ title: 'Withdrawn Paper', typeFamily: 'JOURNAL', doi: '10.1000/withdrawn' });
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: { code: 'PUBLICATION_SUPPRESSED', message: 'This publication was removed by the administrator and cannot be added' } });
    expect(await tableCounts()).toEqual(before); // no MANUAL record, no link
  });
});

describe('later API discovery of a manual publication (§12.3)', () => {
  it('recorded ORCID data matches the manual publication by title + year; the relationship stays APPROVED/MANUAL', async () => {
    const { a, add } = await setup();
    const manual = await add({ title: 'Endmarkers can make a difference', typeFamily: 'JOURNAL', year: 1990 });
    const identity = await prisma.externalIdentity.create({ data: { professorId: a.professor.id, source: 'ORCID', externalId: '0000-0002-0661-5773' } });
    const orcid = new OrcidClient({ deps: { fetchImpl: replayFetch([loadFixture('orcid', 'works-vardi')]).fetchImpl, sleep: noSleep } });

    await discoverOrcidIdentity(identity.id, { orcid });
    const orcidRecord = await prisma.publicationSourceRecord.findUniqueOrThrow({
      where: { source_externalId: { source: 'ORCID', externalId: '0000-0002-0661-5773:5160613' } },
    });
    expect(orcidRecord).toMatchObject({ publicationId: manual.body.item.publication.id, matchMethod: 'TITLE_YEAR' });
    expect(await prisma.professorPublication.findUniqueOrThrow({ where: { id: manual.body.item.id } })).toMatchObject({ status: 'APPROVED', origin: 'MANUAL' });
    expect(await prisma.professorPublication.count({ where: { publicationId: manual.body.item.publication.id } })).toBe(1);
  });

  it('recorded OpenAlex data matches by DOI; API metadata outranks MANUAL for the canonical record (§9)', async () => {
    const { a, add } = await setup();
    const manual = await add({ title: 'Distribution-aware sampling and weighted model counting for SAT', typeFamily: 'CONFERENCE', doi: '10.1609/AAAI.V28I1.8990', year: 2014 });
    const work = (loadFixture('openalex', 'works-cases').body as { results: Array<{ id: string }> }).results.find((w) => w.id.endsWith('W1632042597'))!;
    const identity = await prisma.externalIdentity.create({ data: { professorId: a.professor.id, source: 'OPENALEX', externalId: 'A5000059818' } });
    const summary = await ingestDiscoveredRecords({ id: identity.id, professorId: a.professor.id }, [mapOpenAlexWork(OpenAlexWorkSchema.parse(work))], { seenAt: new Date(NOW) });

    expect(summary).toMatchObject({ recordsNew: 1, linksCreated: 0 });
    expect(await prisma.publication.count()).toBe(1);
    const publication = await prisma.publication.findUniqueOrThrow({ where: { id: manual.body.item.publication.id } });
    expect(publication.title).toBe('Distribution-Aware Sampling and Weighted Model Counting for SAT'); // OpenAlex title
    expect(await prisma.professorPublication.findUniqueOrThrow({ where: { id: manual.body.item.id } })).toMatchObject({ status: 'APPROVED', origin: 'MANUAL' });
  });
});

describe('concurrency and failures', () => {
  it('a double submission creates one publication (with and without a DOI)', async () => {
    const { add } = await setup();
    const withDoi = { title: 'Twice Submitted With DOI', typeFamily: 'JOURNAL', doi: '10.1000/twice', year: 2021 };
    const noDoi = { title: 'Twice Submitted Without DOI', typeFamily: 'JOURNAL', year: 2021 };
    const results = await Promise.all([add(withDoi), add(withDoi), add(noDoi), add(noDoi)]);
    expect(results.every((r) => r.status === 201)).toBe(true);
    expect(await prisma.publication.count()).toBe(2);
    expect(await prisma.professorPublication.count()).toBe(2);
    expect(await prisma.duplicateCandidate.count()).toBe(0);
    expect(results.map((r) => r.body.match.relationship).sort()).toEqual(['CREATED', 'CREATED', 'UNCHANGED', 'UNCHANGED']);
  });

  it('two professors adding the same paper share one publication, each with their own relationship', async () => {
    const { a, b, add } = await setup();
    const body = { title: 'Co-authored Manual Paper', typeFamily: 'CONFERENCE', year: 2023 };
    const [ra, rb] = await Promise.all([add(body, a.cookie), add(body, b.cookie)]);
    expect(ra.body.item.publication.id).toBe(rb.body.item.publication.id);
    expect(await prisma.professorPublication.count({ where: { professorId: a.professor.id } })).toBe(1);
    expect(await prisma.professorPublication.count({ where: { professorId: b.professor.id } })).toBe(1);
  });

  it('a failure while linking rolls the whole entry back and answers a generic 500', async () => {
    const { add } = await setup();
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const fn = 'phase11_test_block_link';
    const [{ current_database: db }] = await prisma.$queryRaw<{ current_database: string }[]>`SELECT current_database()`;
    expect(db.endsWith('_test')).toBe(true);
    await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS ${fn} ON professor_publications`);
    await prisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS ${fn}()`);
    const before = await tableCounts();
    try {
      await prisma.$executeRawUnsafe(`CREATE FUNCTION ${fn}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'phase11 test: link blocked'; END $$`);
      await prisma.$executeRawUnsafe(`CREATE TRIGGER ${fn} BEFORE INSERT ON professor_publications FOR EACH ROW EXECUTE FUNCTION ${fn}()`);
      const res = await add({ title: 'Never Stored Paper', typeFamily: 'JOURNAL', year: 2020 });
      expect(res.status).toBe(500);
      expect(res.body).toEqual({ error: { code: 'INTERNAL_ERROR', message: 'Internal server error' } });
      expect(await tableCounts()).toEqual(before); // no publication, no MANUAL record, no link
    } finally {
      await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS ${fn} ON professor_publications`);
      await prisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS ${fn}()`);
    }
  });
});
