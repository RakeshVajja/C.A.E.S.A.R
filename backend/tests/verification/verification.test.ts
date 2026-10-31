import { Prisma, PublicationSource, VerificationStatus } from '@prisma/client';
import request from 'supertest';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../../src/app';
import { prisma } from '../../src/config/database';
import { OrcidClient } from '../../src/integrations/orcid/client';
import { discoverOrcidIdentity } from '../../src/services/discovery/orcidDiscovery';
import { setIdentityActive } from '../../src/services/identities/identities';
import { decide } from '../../src/services/verification/verification';
import { cookiePair, createUser, PASSWORD, testClock } from '../auth/helpers';
import { resetDatabase } from '../helpers/database';
import { loadFixture, noSleep, replayFetch } from '../helpers/fixtures';
import { tableCounts } from '../professors/helpers';

/* Professor verification workflow (Project_plan.md §11; Phase 10, decisions #72–#76). */

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

const NOW = '2026-10-14T12:00:00.000Z';

async function professorWithSession(server: ReturnType<typeof createApp>, email: string) {
  const user = await createUser({ email, professor: 'active' });
  const professor = await prisma.professor.findUniqueOrThrow({ where: { userId: user.id } });
  const cookie = cookiePair(await request(server).post('/api/auth/login').send({ email, password: PASSWORD }), 'cse_session');
  return { user, professor, cookie };
}

let pubSeq = 0;
async function publication(title: string, year: number | null, sources: PublicationSource[] = ['DBLP'], status: 'ACTIVE' | 'SUPPRESSED' = 'ACTIVE') {
  const pub = await prisma.publication.create({
    data: { title, normalizedTitle: title.toLowerCase(), year, typeFamily: 'JOURNAL', doi: `10.1000/p${++pubSeq}`, venue: 'Venue', authorNamesDisplay: 'A. Author', status },
  });
  for (const [i, source] of sources.entries()) {
    await prisma.publicationSourceRecord.create({
      data: {
        publicationId: pub.id,
        source,
        externalId: `${source}-${i}-${pub.id}`,
        title,
        normalizedTitle: title.toLowerCase(),
        typeFamily: 'JOURNAL',
        matchMethod: 'NEW_PUBLICATION',
        rawMetadata: { secret: 'raw-metadata-never-returned' },
      },
    });
  }
  return pub;
}

function link(professorId: string, publicationId: string, status: VerificationStatus = 'PENDING') {
  return prisma.professorPublication.create({ data: { professorId, publicationId, status, origin: 'DISCOVERED' } });
}

async function setup() {
  const clock = testClock(NOW);
  const server = createApp({ mailer: null, now: clock.now });
  const a = await professorWithSession(server, 'a@example.org');
  const b = await professorWithSession(server, 'b@example.org');
  const as = (cookie: string) => ({
    list: (query = '') => request(server).get(`/api/me/publications${query}`).set('Cookie', cookie),
    decide: (id: string, status: string, expectedStatus: string) =>
      request(server).patch(`/api/me/publications/${id}`).set('Cookie', cookie).send({ status, expectedStatus }),
    bulk: (relationshipIds: unknown) => request(server).post('/api/me/publications/approve').set('Cookie', cookie).send({ relationshipIds }),
  });
  return { clock, server, a, b, A: as(a.cookie), B: as(b.cookie) };
}

describe('access', () => {
  it('requires a professor session without a temporary password; inactive professors lose access', async () => {
    const { server, a, A } = await setup();
    const pub = await publication('Some Paper', 2020);
    const rel = await link(a.professor.id, pub.id);

    expect((await request(server).get('/api/me/publications')).status).toBe(401);

    await createUser({ email: 'admin@example.org', role: 'ADMIN' });
    const admin = cookiePair(await request(server).post('/api/auth/login').send({ email: 'admin@example.org', password: PASSWORD }), 'cse_session');
    expect((await request(server).get('/api/me/publications').set('Cookie', admin)).body.error.code).toBe('FORBIDDEN');

    await createUser({ email: 'temp@example.org', professor: 'active', mustChangePassword: true });
    const temp = cookiePair(await request(server).post('/api/auth/login').send({ email: 'temp@example.org', password: PASSWORD }), 'cse_session');
    expect((await request(server).get('/api/me/publications').set('Cookie', temp)).body.error.code).toBe('PASSWORD_CHANGE_REQUIRED');

    await createUser({ email: 'unlinked@example.org' });
    const unlinked = cookiePair(await request(server).post('/api/auth/login').send({ email: 'unlinked@example.org', password: PASSWORD }), 'cse_session');
    expect((await request(server).get('/api/me/publications').set('Cookie', unlinked)).body.error.code).toBe('PROFILE_NOT_FOUND');

    await prisma.professor.update({ where: { id: a.professor.id }, data: { isActive: false } });
    expect((await A.list()).status).toBe(401);
    expect((await A.decide(rel.id, 'APPROVED', 'PENDING')).status).toBe(401);
    expect((await prisma.professorPublication.findUniqueOrThrow({ where: { id: rel.id } })).status).toBe('PENDING');
  });

  it('refuses foreign origins and non-JSON bodies on decisions', async () => {
    const { server, a } = await setup();
    const rel = await link(a.professor.id, (await publication('Some Paper', 2020)).id);
    const patch = () => request(server).patch(`/api/me/publications/${rel.id}`).set('Cookie', a.cookie);
    expect((await patch().set('Origin', 'https://evil.example').send({ status: 'APPROVED', expectedStatus: 'PENDING' })).body.error.code).toBe('ORIGIN_NOT_ALLOWED');
    expect((await patch().set('Content-Type', 'text/plain').send('{"status":"APPROVED","expectedStatus":"PENDING"}')).status).toBe(400);
    expect((await patch().type('form').send({ status: 'APPROVED', expectedStatus: 'PENDING' })).status).toBe(400);
    expect((await prisma.professorPublication.findUniqueOrThrow({ where: { id: rel.id } })).status).toBe('PENDING');
  });
});

describe('listing', () => {
  it('returns only the professor\'s own visible relationships, with the approved fields only', async () => {
    const { a, b, A } = await setup();
    // Two OpenAlex records on one publication (an in-source duplicate) are listed once.
    const shared = await publication('Shared Paper', 2021, ['ORCID', 'OPENALEX', 'DBLP', 'OPENALEX']);
    const relA = await link(a.professor.id, shared.id);
    await link(b.professor.id, shared.id, 'APPROVED');
    await link(b.professor.id, (await publication('Only B', 2019)).id);

    const res = await A.list();
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      items: [
        {
          id: relA.id,
          status: 'PENDING',
          origin: 'DISCOVERED',
          decidedAt: null,
          createdAt: relA.createdAt.toISOString(),
          publication: {
            id: shared.id,
            title: 'Shared Paper',
            year: 2021,
            venue: 'Venue',
            typeFamily: 'JOURNAL',
            doi: shared.doi,
            authorNamesDisplay: 'A. Author',
            sources: ['OPENALEX', 'DBLP', 'ORCID'], // distinct, fixed order
            scopusCitation: null, // no Scopus count observed
          },
        },
      ],
      total: 1,
      limit: 50,
      offset: 0,
      counts: { PENDING: 1, APPROVED: 0, REJECTED: 0 },
    });
    const text = JSON.stringify(res.body);
    for (const hidden of ['raw-metadata-never-returned', b.professor.id, b.user.id, 'decidedByUserId', 'discoveredVia', 'b@example.org']) {
      expect(text).not.toContain(hidden);
    }
  });

  it('filters by status (the verified list is status=APPROVED), with filtered total and unfiltered counts', async () => {
    const { a, A } = await setup();
    for (const [i, status] of (['PENDING', 'PENDING', 'APPROVED', 'REJECTED'] as const).entries()) {
      await link(a.professor.id, (await publication(`Paper ${i}`, 2020 + i)).id, status);
    }
    const approved = await A.list('?status=APPROVED');
    expect(approved.body.items.map((i: { status: string }) => i.status)).toEqual(['APPROVED']);
    expect(approved.body.total).toBe(1);
    expect(approved.body.counts).toEqual({ PENDING: 2, APPROVED: 1, REJECTED: 1 });
    expect((await A.list('?status=PENDING')).body.total).toBe(2);
    expect((await A.list()).body.total).toBe(4);
  });

  it('sorts deterministically: PENDING first, newest year (unknown last), title, id; pages with limit/offset', async () => {
    const { a, A } = await setup();
    const make = async (title: string, year: number | null, status: VerificationStatus) =>
      (await link(a.professor.id, (await publication(title, year)).id, status)).id;
    await make('Rejected Old', 2001, 'REJECTED');
    await make('Approved New', 2024, 'APPROVED');
    await make('Pending No Year', null, 'PENDING');
    await make('Pending B 2020', 2020, 'PENDING');
    await make('Pending A 2020', 2020, 'PENDING');
    await make('Pending 2023', 2023, 'PENDING');

    const all = (await A.list()).body.items.map((i: { publication: { title: string } }) => i.publication.title);
    expect(all).toEqual(['Pending 2023', 'Pending A 2020', 'Pending B 2020', 'Pending No Year', 'Approved New', 'Rejected Old']);
    expect((await A.list()).body.items.map((i: { id: string }) => i.id)).toEqual((await A.list()).body.items.map((i: { id: string }) => i.id));

    const page = await A.list('?limit=2&offset=2');
    expect(page.body.items.map((i: { publication: { title: string } }) => i.publication.title)).toEqual(['Pending B 2020', 'Pending No Year']);
    expect(page.body).toMatchObject({ total: 6, limit: 2, offset: 2 });

    for (const bad of ['?limit=0', '?limit=201', '?offset=-1', '?status=ARCHIVED', '?professorId=x', '?limit=abc']) {
      const res = await A.list(bad);
      expect(res.status, bad).toBe(400);
      expect(res.body.error).toMatchObject({ code: 'VALIDATION_ERROR', message: 'Invalid query parameters' });
    }
    expect((await A.list('?limit=200')).status).toBe(200);
  });

  it('hides relationships to SUPPRESSED publications from results and counts; decisions on them are 404', async () => {
    const { a, A } = await setup();
    await link(a.professor.id, (await publication('Visible', 2020)).id);
    const hidden = await link(a.professor.id, (await publication('Suppressed', 2021, ['DBLP'], 'SUPPRESSED')).id);
    const res = await A.list();
    expect(res.body.items.map((i: { publication: { title: string } }) => i.publication.title)).toEqual(['Visible']);
    expect(res.body).toMatchObject({ total: 1, counts: { PENDING: 1, APPROVED: 0, REJECTED: 0 } });
    expect((await A.decide(hidden.id, 'APPROVED', 'PENDING')).body.error.code).toBe('RELATIONSHIP_NOT_FOUND');
    expect(await A.bulk([hidden.id])).toMatchObject({ body: { approved: 0, skipped: 1 } });
    expect((await prisma.professorPublication.findUniqueOrThrow({ where: { id: hidden.id } })).status).toBe('PENDING');
  });
});

describe('decisions and the state machine', () => {
  it('allows exactly PENDING→APPROVED/REJECTED and APPROVED⇄REJECTED, attributing every decision', async () => {
    const { clock, a, A } = await setup();
    const rel = await link(a.professor.id, (await publication('Paper', 2020)).id);
    const other = await link(a.professor.id, (await publication('Other', 2021)).id);

    const approved = await A.decide(rel.id, 'APPROVED', 'PENDING');
    expect(approved.status).toBe(200);
    expect(approved.body.item).toMatchObject({ id: rel.id, status: 'APPROVED', decidedAt: NOW });
    expect(await prisma.professorPublication.findUniqueOrThrow({ where: { id: rel.id } })).toMatchObject({
      status: 'APPROVED',
      decidedAt: new Date(NOW),
      decidedByUserId: a.user.id,
    });

    clock.advance(60_000);
    expect((await A.decide(rel.id, 'REJECTED', 'APPROVED')).body.item).toMatchObject({ status: 'REJECTED', decidedAt: '2026-10-14T12:01:00.000Z' });
    clock.advance(60_000);
    expect((await A.decide(rel.id, 'APPROVED', 'REJECTED')).body.item).toMatchObject({ status: 'APPROVED', decidedAt: '2026-10-14T12:02:00.000Z' });
    expect((await A.decide(other.id, 'REJECTED', 'PENDING')).body.item.status).toBe('REJECTED');

    // Never back to PENDING; same status is not a change.
    expect((await A.decide(rel.id, 'PENDING', 'APPROVED')).body.error.code).toBe('VALIDATION_ERROR');
    const same = await A.decide(rel.id, 'APPROVED', 'APPROVED');
    expect(same.status).toBe(409);
    expect(same.body.error).toMatchObject({ code: 'INVALID_TRANSITION', details: { currentStatus: 'APPROVED' } });
    expect((await prisma.professorPublication.findUniqueOrThrow({ where: { id: rel.id } })).decidedAt).toEqual(new Date('2026-10-14T12:02:00.000Z'));
  });

  it('refuses a stale expectedStatus (409)', async () => {
    const { a, A } = await setup();
    const rel = await link(a.professor.id, (await publication('Paper', 2020)).id, 'APPROVED');
    const stale = await A.decide(rel.id, 'REJECTED', 'PENDING');
    expect(stale.status).toBe(409);
    expect(stale.body.error).toMatchObject({ code: 'STATUS_CONFLICT', details: { currentStatus: 'APPROVED' } });
    expect((await prisma.professorPublication.findUniqueOrThrow({ where: { id: rel.id } })).status).toBe('APPROVED');
  });

  it('a lost compare-and-set is STATUS_CONFLICT even if the status is restored before the lookup (L1)', async () => {
    const { a } = await setup();
    const rel = await link(a.professor.id, (await publication('Paper', 2020)).id);
    // Deterministic race: around this decision's conditional update, another connection approves
    // the relationship (so the update matches nothing) and then sets it back to PENDING.
    const relationships = new Proxy(prisma.professorPublication, {
      get(target, prop) {
        const value = Reflect.get(target, prop);
        if (prop !== 'updateMany') return typeof value === 'function' ? value.bind(target) : value;
        return async (args: Prisma.ProfessorPublicationUpdateManyArgs) => {
          await prisma.professorPublication.update({ where: { id: rel.id }, data: { status: 'APPROVED' } });
          const result = await target.updateMany(args);
          await prisma.professorPublication.update({ where: { id: rel.id }, data: { status: 'PENDING' } });
          return result;
        };
      },
    });
    const racing = new Proxy(prisma, {
      get(target, prop) {
        if (prop === 'professorPublication') return relationships;
        const value = Reflect.get(target, prop);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });

    await expect(decide(a.professor.id, a.user.id, rel.id, 'REJECTED', 'PENDING', new Date(NOW), racing)).rejects.toMatchObject({
      status: 409,
      code: 'STATUS_CONFLICT',
      details: { currentStatus: 'PENDING' },
    });
    expect(await prisma.professorPublication.findUniqueOrThrow({ where: { id: rel.id } })).toMatchObject({ status: 'PENDING', decidedAt: null });
  });

  it('validates decision bodies strictly; a client-supplied professor ID is refused, not used', async () => {
    const { server, a, b } = await setup();
    const rel = await link(a.professor.id, (await publication('Paper', 2020)).id);
    for (const body of [
      { status: 'APPROVED' },
      { expectedStatus: 'PENDING' },
      { status: 'MAYBE', expectedStatus: 'PENDING' },
      { status: 'APPROVED', expectedStatus: 'PENDING', professorId: b.professor.id },
      { status: 'APPROVED', expectedStatus: 'PENDING', decidedByUserId: b.user.id },
    ]) {
      const res = await request(server).patch(`/api/me/publications/${rel.id}`).set('Cookie', a.cookie).send(body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    }
    expect((await prisma.professorPublication.findUniqueOrThrow({ where: { id: rel.id } })).status).toBe('PENDING');
  });

  it('never lets a professor see or change another professor\'s relationship (404, no detail)', async () => {
    const { a, b, A, B } = await setup();
    const shared = await publication('Shared', 2020);
    const relA = await link(a.professor.id, shared.id);
    const relB = await link(b.professor.id, shared.id);

    const res = await B.decide(relA.id, 'REJECTED', 'PENDING');
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: { code: 'RELATIONSHIP_NOT_FOUND', message: 'Publication relationship not found' } });
    expect((await B.decide('00000000-0000-4000-8000-000000000099', 'REJECTED', 'PENDING')).body).toEqual(res.body);
    expect((await B.decide('not-a-uuid', 'REJECTED', 'PENDING')).body).toEqual(res.body);
    expect((await prisma.professorPublication.findUniqueOrThrow({ where: { id: relA.id } })).status).toBe('PENDING');

    // The same publication can be approved by A and rejected by B independently.
    expect((await A.decide(relA.id, 'APPROVED', 'PENDING')).status).toBe(200);
    expect((await B.decide(relB.id, 'REJECTED', 'PENDING')).status).toBe(200);
    expect((await prisma.professorPublication.findUniqueOrThrow({ where: { id: relA.id } })).status).toBe('APPROVED');
    expect((await prisma.professorPublication.findUniqueOrThrow({ where: { id: relB.id } })).status).toBe('REJECTED');
    expect((await prisma.publication.findUniqueOrThrow({ where: { id: shared.id } })).status).toBe('ACTIVE');
  });

  it('rejection deletes nothing: publications, source records and other relationships stay', async () => {
    const { a, b, A } = await setup();
    const shared = await publication('Shared', 2020, ['OPENALEX', 'DBLP']);
    const relA = await link(a.professor.id, shared.id);
    await link(b.professor.id, shared.id, 'APPROVED');
    const before = await tableCounts();
    expect((await A.decide(relA.id, 'REJECTED', 'PENDING')).status).toBe(200);
    expect(await tableCounts()).toEqual(before);
  });

  it('concurrent approve and reject of one PENDING relationship: exactly one wins, the other gets 409', async () => {
    const { a, A } = await setup();
    const rel = await link(a.professor.id, (await publication('Paper', 2020)).id);
    const [x, y] = await Promise.all([A.decide(rel.id, 'APPROVED', 'PENDING'), A.decide(rel.id, 'REJECTED', 'PENDING')]);
    expect([x.status, y.status].sort()).toEqual([200, 409]);
    const loser = x.status === 409 ? x : y;
    const winner = x.status === 200 ? x : y;
    expect(loser.body.error.code).toBe('STATUS_CONFLICT');
    expect((await prisma.professorPublication.findUniqueOrThrow({ where: { id: rel.id } })).status).toBe(winner.body.item.status);
  });

  it('a failing update rolls back and answers a generic 500 without database detail', async () => {
    const { a, A } = await setup();
    const rel = await link(a.professor.id, (await publication('Paper', 2020)).id);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const fn = 'phase10_test_block_decision';
    const [{ current_database: db }] = await prisma.$queryRaw<{ current_database: string }[]>`SELECT current_database()`;
    expect(db.endsWith('_test')).toBe(true);
    await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS ${fn} ON professor_publications`);
    await prisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS ${fn}()`);
    try {
      await prisma.$executeRawUnsafe(`CREATE FUNCTION ${fn}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'phase10 test: update blocked'; END $$`);
      await prisma.$executeRawUnsafe(`CREATE TRIGGER ${fn} BEFORE UPDATE ON professor_publications FOR EACH ROW EXECUTE FUNCTION ${fn}()`);
      const single = await A.decide(rel.id, 'APPROVED', 'PENDING');
      const bulk = await A.bulk([rel.id]);
      for (const res of [single, bulk]) {
        expect(res.status).toBe(500);
        expect(res.body).toEqual({ error: { code: 'INTERNAL_ERROR', message: 'Internal server error' } });
      }
      expect(await prisma.professorPublication.findUniqueOrThrow({ where: { id: rel.id } })).toMatchObject({ status: 'PENDING', decidedAt: null });
    } finally {
      await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS ${fn} ON professor_publications`);
      await prisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS ${fn}()`);
    }
  });
});

describe('bulk approval', () => {
  it('approves only the professor\'s visible PENDING relationships and reports counts without naming IDs', async () => {
    const { a, b, A } = await setup();
    const pending = await Promise.all([1, 2, 3].map(async (i) => (await link(a.professor.id, (await publication(`P${i}`, 2020)).id)).id));
    const rejected = (await link(a.professor.id, (await publication('Rejected', 2020)).id, 'REJECTED')).id;
    const othersRel = (await link(b.professor.id, (await publication('B only', 2020)).id)).id;
    const missing = '00000000-0000-4000-8000-000000000099';

    const res = await A.bulk([...pending, rejected, othersRel, missing]);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ approved: 3, skipped: 3 });
    for (const id of pending) {
      expect(await prisma.professorPublication.findUniqueOrThrow({ where: { id } })).toMatchObject({ status: 'APPROVED', decidedAt: new Date(NOW), decidedByUserId: a.user.id });
    }
    expect((await prisma.professorPublication.findUniqueOrThrow({ where: { id: rejected } })).status).toBe('REJECTED');
    expect((await prisma.professorPublication.findUniqueOrThrow({ where: { id: othersRel } })).status).toBe('PENDING');
  });

  it('validates the ID list: 1–500 unique UUIDs', async () => {
    const { a, A } = await setup();
    const id = (await link(a.professor.id, (await publication('P', 2020)).id)).id;
    const uuid = (i: number) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`;
    for (const ids of [[], [id, id], ['not-a-uuid'], Array.from({ length: 501 }, (_, i) => uuid(i)), 'x']) {
      const res = await A.bulk(ids);
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    }
    expect((await prisma.professorPublication.findUniqueOrThrow({ where: { id } })).status).toBe('PENDING');
    expect((await A.bulk(Array.from({ length: 500 }, (_, i) => (i === 0 ? id : uuid(i))))).body).toEqual({ approved: 1, skipped: 499 });
  });

  it('concurrent identical bulk approvals approve each relationship once', async () => {
    const { a, A } = await setup();
    const ids = await Promise.all([1, 2, 3, 4, 5].map(async (i) => (await link(a.professor.id, (await publication(`P${i}`, 2020)).id)).id));
    const results = await Promise.all([A.bulk(ids), A.bulk(ids), A.bulk(ids)]);
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(results.reduce((n, r) => n + r.body.approved, 0)).toBe(5);
    expect(results.reduce((n, r) => n + r.body.skipped, 0)).toBe(10);
    expect(await prisma.professorPublication.count({ where: { status: 'APPROVED' } })).toBe(5);
  });
});

describe('decisions survive discovery and identity cleanup', () => {
  async function vardiWithOrcid() {
    const ctx = await setup();
    const identity = await prisma.externalIdentity.create({ data: { professorId: ctx.a.professor.id, source: 'ORCID', externalId: '0000-0002-0661-5773' } });
    const orcid = () => new OrcidClient({ deps: { fetchImpl: replayFetch([loadFixture('orcid', 'works-vardi')]).fetchImpl, sleep: noSleep } });
    await discoverOrcidIdentity(identity.id, { orcid: orcid() });
    return { ...ctx, identity, orcid };
  }

  it('re-running recorded ORCID discovery keeps API decisions, their attribution, and recreates nothing', async () => {
    const { A, identity, orcid } = await vardiWithOrcid();
    const items = (await A.list()).body.items as Array<{ id: string }>;
    expect(items.length).toBeGreaterThanOrEqual(3);
    await A.decide(items[0].id, 'APPROVED', 'PENDING');
    await A.decide(items[1].id, 'REJECTED', 'PENDING');
    const snapshot = await prisma.professorPublication.findMany({ orderBy: { id: 'asc' } });

    const rerun = await discoverOrcidIdentity(identity.id, { orcid: orcid() });
    expect(rerun.linksCreated).toBe(0);
    expect(await prisma.professorPublication.findMany({ orderBy: { id: 'asc' } })).toEqual(snapshot);
  });

  it('identity deactivation removes only PENDING links; APPROVED and REJECTED decisions stay', async () => {
    const { a, A, identity } = await vardiWithOrcid();
    const items = (await A.list()).body.items as Array<{ id: string }>;
    await A.decide(items[0].id, 'APPROVED', 'PENDING');
    await A.decide(items[1].id, 'REJECTED', 'PENDING');

    const result = await setIdentityActive(a.professor.id, identity.id, false);
    expect(result.pendingLinksRemoved).toBe(items.length - 2);
    const left = await prisma.professorPublication.findMany({ select: { id: true, status: true } });
    expect(left.map((l) => l.status).sort()).toEqual(['APPROVED', 'REJECTED']);
    expect((await A.list()).body.counts).toEqual({ PENDING: 0, APPROVED: 1, REJECTED: 1 });
  });
});
