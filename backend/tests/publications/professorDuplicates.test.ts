import request from 'supertest';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { prisma } from '../../src/config/database';
import { addManualPublication } from '../../src/services/manual/manualPublications';
import { ingestPublication } from '../../src/services/matching/engine';
import { buildNormalizedPublication } from '../../src/services/normalization/normalizedPublication';
import { withMergeNote } from '../../src/services/publications/duplicates';
import { cookiePair, createUser, PASSWORD } from '../auth/helpers';
import { INDEPENDENT_ENTRY } from '../helpers/basis';
import { resetDatabase } from '../helpers/database';
import { loadFixture, toResponse } from '../helpers/fixtures';
import { AUTHOR_URL, candidate, link, NOW, PRIEM, professor, professorSession, publication, setup, snapshot, syncService, withTrigger } from './helpers';

/*
 * Duplicate-candidate resolution by professors (Project_plan.md §8.5; decisions #149–#151): every OPEN
 * candidate in which either publication has a relationship with the professor, in any status, shared
 * and suppressed publications included; merge (keeping either publication) and dismiss through the
 * existing transactional logic. Synthetic rows only, no network.
 */

vi.setConfig({ testTimeout: 60_000 });

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

const BASE = '/api/me/duplicate-candidates';
const NONE = '00000000-0000-4000-8000-000000000001';

/** The server, the acting professor's session and request helpers. */
async function world(sync = syncService()) {
  const { server, admin } = await setup(sync);
  const me = await professorSession(server, 'me@example.org');
  const list = (cookie = me.cookie, qs = '') => request(server).get(`${BASE}${qs}`).set('Cookie', cookie);
  const dismiss = (id: string, cookie = me.cookie) => request(server).post(`${BASE}/${id}/dismiss`).set('Cookie', cookie);
  const merge = (id: string, keepPublicationId: unknown, cookie = me.cookie) =>
    request(server).post(`${BASE}/${id}/merge`).set('Cookie', cookie).send({ keepPublicationId });
  return { server, admin, sync, me, list, dismiss, merge };
}

const ids = (body: { candidates: { id: string }[] }) => body.candidates.map((c) => c.id);

describe('authorization and request safety', () => {
  it('requires a professor session without a temporary password; state changes also the allowed origin', async () => {
    const { server, admin, me } = await world();
    await createUser({ email: 'temp@example.org', professor: 'active', mustChangePassword: true });
    const temp = cookiePair(await request(server).post('/api/auth/login').send({ email: 'temp@example.org', password: PASSWORD }), 'cse_session');
    const a = await publication({ title: 'Same' });
    const b = await publication({ title: 'Same' });
    await link(me.prof.id, a.id, 'APPROVED');
    const c = await candidate(a.id, b.id);
    const before = await snapshot();

    for (const [method, path] of [
      ['get', BASE],
      ['post', `${BASE}/${c.id}/dismiss`],
      ['post', `${BASE}/${c.id}/merge`],
    ] as const) {
      expect((await request(server)[method](path).send({})).status, path).toBe(401);
      expect((await request(server)[method](path).set('Cookie', admin).send({})).body.error.code, path).toBe('FORBIDDEN');
      expect((await request(server)[method](path).set('Cookie', temp).send({})).body.error.code, path).toBe('PASSWORD_CHANGE_REQUIRED');
      if (method === 'post') {
        const foreign = await request(server)[method](path).set('Cookie', me.cookie).set('Origin', 'https://evil.example').send({ keepPublicationId: a.id });
        expect(foreign.body.error.code, path).toBe('ORIGIN_NOT_ALLOWED');
      }
    }
    expect(await snapshot()).toEqual(before);
  });

  it('candidates of other professors are never listed or disclosed (404), whatever their status', async () => {
    const { server, list, dismiss, merge } = await world();
    const other = await professorSession(server, 'other@example.org');
    const a = await publication({ title: 'Same' });
    const b = await publication({ title: 'Same' });
    const x = await publication({ title: 'X' });
    await link(other.prof.id, a.id, 'APPROVED');
    const open = await candidate(a.id, b.id);
    const resolved = await candidate(a.id, x.id, 'DISMISSED');
    const before = await snapshot();

    expect((await list()).body).toMatchObject({ candidates: [], total: 0 });
    expect(ids((await list(other.cookie)).body)).toEqual([open.id]);
    for (const id of [open.id, resolved.id, NONE]) {
      expect((await dismiss(id)).body.error.code, id).toBe('CANDIDATE_NOT_FOUND');
      expect((await merge(id, a.id)).body.error.code, id).toBe('CANDIDATE_NOT_FOUND');
    }
    expect((await dismiss('not-an-id')).status).toBe(404);
    expect(await snapshot()).toEqual(before);
  });

  it('responses never contain raw metadata or user emails; queries are validated', async () => {
    const { list, dismiss, me } = await world();
    const a = await publication({ title: 'Same', records: [{ source: 'DBLP' }, { source: 'ORCID' }] });
    const b = await publication({ title: 'Same' });
    await link(me.prof.id, a.id, 'PENDING');
    const c = await candidate(a.id, b.id);
    for (const body of [(await list()).body, (await dismiss(c.id)).body].map((x) => JSON.stringify(x))) {
      expect(body).not.toContain('raw-metadata-never-returned');
      expect(body).not.toContain('rawMetadata');
      expect(body).not.toContain('me@example.org');
    }
    for (const qs of ['?limit=0', '?limit=201', '?offset=-1', '?status=OPEN', '?professorId=1']) {
      expect((await list(undefined, qs)).status, qs).toBe(400);
    }
  });
});

describe('eligibility: every OPEN candidate involving the professor (#149, #150)', () => {
  it('includes APPROVED, PENDING and REJECTED links, shared, suppressed, mismatched and preprint pairs; excludes resolved and unrelated ones', async () => {
    const { list, me } = await world();
    const someoneElse = await professor('Prof Other');
    const make = async (title: string, a: Parameters<typeof publication>[0] = {}, b: Parameters<typeof publication>[0] = {}) => {
      const x = await publication({ title, ...a });
      const y = await publication({ title, ...b });
      return { x, y, c: await candidate(x.id, y.id) };
    };
    const approved = await make('Approved');
    await link(me.prof.id, approved.x.id, 'APPROVED');
    const pending = await make('Pending');
    await link(me.prof.id, pending.y.id, 'PENDING');
    const rejected = await make('Rejected');
    await link(me.prof.id, rejected.x.id, 'REJECTED');
    const shared = await make('Shared');
    await link(me.prof.id, shared.x.id, 'PENDING');
    await link(someoneElse.id, shared.x.id, 'APPROVED');
    await link(someoneElse.id, shared.y.id, 'APPROVED');
    const suppressed = await make('Suppressed', { status: 'SUPPRESSED' }, { status: 'SUPPRESSED' });
    await link(me.prof.id, suppressed.x.id, 'APPROVED');
    const mixed = await make('Mixed', { status: 'ACTIVE' }, { status: 'SUPPRESSED' });
    await link(me.prof.id, mixed.y.id, 'REJECTED');
    const preprint = await make('Preprint', { type: 'PREPRINT' }, { type: 'CONFERENCE' });
    await link(me.prof.id, preprint.x.id, 'APPROVED');
    const unrelated = await make('Unrelated');
    await link(someoneElse.id, unrelated.x.id, 'APPROVED');
    const done = await publication({ title: 'Done' });
    await link(me.prof.id, done.id, 'APPROVED');
    await candidate(done.id, (await publication({ title: 'Done' })).id, 'DISMISSED');

    const res = await list();
    expect(res.status).toBe(200);
    const mine = [approved, pending, rejected, shared, suppressed, mixed, preprint].map((w) => w.c.id);
    expect(res.body).toMatchObject({ total: 7, limit: 50, offset: 0 });
    expect(ids(res.body).sort()).toEqual([...mine].sort());

    // Each side carries the professor's own relationship status, and the full comparison data.
    const shown = res.body.candidates.find((c: { id: string }) => c.id === shared.c.id);
    const side = (id: string) => [shown.publicationA, shown.publicationB].find((p: { id: string }) => p.id === id);
    expect(side(shared.x.id)).toMatchObject({ myRelationshipStatus: 'PENDING', relationshipCounts: { pending: 1, approved: 1, rejected: 0 } });
    expect(side(shared.y.id)).toMatchObject({ myRelationshipStatus: null, relationshipCounts: { pending: 0, approved: 1, rejected: 0 } });
    const hidden = res.body.candidates.find((c: { id: string }) => c.id === suppressed.c.id);
    expect(hidden.publicationA).toMatchObject({ status: 'SUPPRESSED', title: 'Suppressed', sources: ['DBLP'], year: 2020, typeFamily: 'JOURNAL' });

    const page = (await list(undefined, '?limit=2&offset=1')).body;
    expect(page).toMatchObject({ total: 7, limit: 2, offset: 1 });
    expect(ids(page)).toEqual(ids(res.body).slice(1, 3));
  });
});

describe('dismiss', () => {
  it('dismisses with the professor as resolver, keeps both publications, and is refused once resolved', async () => {
    const { dismiss, me } = await world();
    const a = await publication({ title: 'Same' });
    const b = await publication({ title: 'Same' });
    await link(me.prof.id, a.id, 'REJECTED');
    await link((await professor('Prof Other')).id, b.id, 'APPROVED'); // shared: still resolvable
    const c = await candidate(a.id, b.id);

    const res = await dismiss(c.id);
    expect(res.status).toBe(200);
    expect(res.body.candidate).toMatchObject({ id: c.id, status: 'DISMISSED', resolvedAt: NOW });
    expect(await prisma.duplicateCandidate.findUniqueOrThrow({ where: { id: c.id } })).toMatchObject({ resolvedByUserId: me.user.id, resolvedAt: new Date(NOW) });
    expect(await prisma.publication.count()).toBe(2);

    const again = await dismiss(c.id);
    expect(again.status).toBe(409);
    expect(again.body.error).toMatchObject({ code: 'CANDIDATE_NOT_OPEN', details: { currentStatus: 'DISMISSED' } });
  });
});

describe('merge', () => {
  async function mergeWorld(meId: string) {
    const keep = await publication({ title: 'Model checking', doi: null, records: [{ source: 'OPENALEX', doi: null, venue: null }] });
    const remove = await publication({ title: 'Model checking', doi: '10.1000/merged', records: [{ source: 'DBLP', doi: '10.1000/merged', venue: 'CAV' }, { source: 'ORCID' }] });
    await link(meId, remove.id, 'PENDING');
    return { keep, remove, c: await candidate(keep.id, remove.id) };
  }

  it('moves source records, recomputes the survivor, removes the other publication and records the professor as resolver', async () => {
    const { merge, me } = await world();
    const { keep, remove, c } = await mergeWorld(me.prof.id);
    const res = await merge(c.id, keep.id);
    expect(res.status).toBe(200);
    expect(res.body.merge).toEqual({ removedPublicationId: remove.id, sourceRecordsMoved: 2, relationshipsMoved: 1, relationshipsRemoved: 0, candidatesRepointed: 0, candidatesClosed: 0 });
    expect(res.body.candidate).toMatchObject({ id: c.id, status: 'MERGED' });
    expect(await prisma.publication.findUnique({ where: { id: remove.id } })).toBeNull();
    expect(await prisma.publication.findUniqueOrThrow({ where: { id: keep.id } })).toMatchObject({ venue: 'CAV', doi: '10.1000/merged', status: 'ACTIVE' });
    expect(await prisma.publicationSourceRecord.count({ where: { publicationId: keep.id } })).toBe(3);
    const merged = await prisma.duplicateCandidate.findUniqueOrThrow({ where: { id: c.id } });
    expect(merged).toMatchObject({ status: 'MERGED', resolvedByUserId: me.user.id, resolvedAt: new Date(NOW) });
    expect([merged.publicationAId, merged.publicationBId]).toContain(keep.id);
    expect([merged.publicationAId, merged.publicationBId]).toContain(null); // the removed side (§6.10)
  });

  it('keeps each moved record’s original match_method and full match_detail, appends the merge reference, and never writes ADMIN (#151)', async () => {
    const { merge, me } = await world();
    const keep = await publication({ title: 'Provenance', records: [{ source: 'OPENALEX' }] });
    const remove = await publication({ title: 'Provenance', records: [{ source: 'DBLP' }, { source: 'ORCID' }, { source: 'SCOPUS' }] });
    await link(me.prof.id, keep.id, 'APPROVED');
    const [first, second, third] = await prisma.publicationSourceRecord.findMany({ where: { publicationId: remove.id }, orderBy: { externalId: 'asc' } });
    // A long original text (TEXT has no length limit), a null one, and the fixture's own.
    const long = `Matched on DOI ${'x'.repeat(20_000)} end-of-original`;
    await prisma.publicationSourceRecord.update({ where: { id: second.id }, data: { matchDetail: long, matchMethod: 'TITLE_YEAR' } });
    await prisma.publicationSourceRecord.update({ where: { id: third.id }, data: { matchDetail: null } });
    const before = new Map((await prisma.publicationSourceRecord.findMany({ where: { publicationId: remove.id } })).map((r) => [r.id, r]));
    const c = await candidate(keep.id, remove.id);

    expect((await merge(c.id, keep.id)).status).toBe(200);
    const note = `moved by duplicate candidate ${c.id} from publication ${remove.id}`;
    for (const id of [first.id, second.id, third.id]) {
      const original = before.get(id)!;
      const after = await prisma.publicationSourceRecord.findUniqueOrThrow({ where: { id } });
      expect(after.publicationId).toBe(keep.id);
      expect(after.matchMethod).toBe(original.matchMethod); // original attachment provenance, unchanged
      expect(after.matchMethod).not.toBe('ADMIN');
      expect(after.matchDetail).toBe(withMergeNote(original.matchDetail, c.id, remove.id));
      if (original.matchDetail) expect(after.matchDetail!.startsWith(`${original.matchDetail}; `)).toBe(true);
      expect(after.matchDetail!.toLowerCase().endsWith(note)).toBe(true);
      expect(after.matchDetail).not.toMatch(/administrator/i);
    }
    expect((await prisma.publicationSourceRecord.findUniqueOrThrow({ where: { id: second.id } })).matchDetail).toBe(`${long}; ${note}`); // not truncated
    expect((await prisma.publicationSourceRecord.findUniqueOrThrow({ where: { id: third.id } })).matchDetail).toBe(`M${note.slice(1)}`);
    expect(await prisma.publicationSourceRecord.count({ where: { matchMethod: 'ADMIN' } })).toBe(0);

    // A later synchronization of a moved record (rule 1) keeps its provenance and the merge reference.
    const moved = await prisma.publicationSourceRecord.findUniqueOrThrow({ where: { id: first.id } });
    await ingestPublication(buildNormalizedPublication({ source: moved.source, externalId: moved.externalId, title: 'Provenance', year: 2020, typeFamily: 'JOURNAL' }));
    expect(await prisma.publicationSourceRecord.findUniqueOrThrow({ where: { id: first.id } })).toMatchObject({
      publicationId: keep.id,
      matchMethod: moved.matchMethod,
      matchDetail: moved.matchDetail,
    });
  });

  it('either publication may be kept', async () => {
    const { merge, me } = await world();
    const { keep, remove, c } = await mergeWorld(me.prof.id);
    const res = await merge(c.id, remove.id);
    expect(res.status).toBe(200);
    expect(res.body.merge.removedPublicationId).toBe(keep.id);
    expect(await prisma.publicationSourceRecord.count({ where: { publicationId: remove.id } })).toBe(3);
  });

  it('consolidates every professor’s relationships APPROVED > PENDING > REJECTED; ties keep the survivor’s; winners keep their decision metadata', async () => {
    const { server, merge } = await world();
    const { keep, remove, c } = await (async () => {
      const k = await publication({ title: 'Model checking', doi: null, records: [{ source: 'OPENALEX', doi: null, venue: null }] });
      const r = await publication({ title: 'Model checking', doi: '10.1000/merged', records: [{ source: 'DBLP', doi: '10.1000/merged', venue: 'CAV' }, { source: 'ORCID' }] });
      return { keep: k, remove: r, c: await candidate(k.id, r.id) };
    })();
    const actor = await professorSession(server, 'p1@example.org'); // P1, linked to both — resolves for everyone
    const p1 = actor.prof;
    const [p2, p3, p4, p5, p6] = await Promise.all(['P2', 'P3', 'P4', 'P5', 'P6'].map((n) => professor(n)));
    const decided = { decidedAt: new Date('2026-09-01T00:00:00Z'), decidedByUserId: actor.user.id };
    await link(p1.id, keep.id, 'PENDING');
    const p1Winner = await link(p1.id, remove.id, 'APPROVED', decided);
    await link(p2.id, keep.id, 'REJECTED', decided);
    const p2Winner = await link(p2.id, remove.id, 'PENDING');
    const p3Winner = await link(p3.id, keep.id, 'APPROVED', decided);
    await link(p3.id, remove.id, 'REJECTED', decided);
    const p4Winner = await link(p4.id, keep.id, 'PENDING');
    await link(p4.id, remove.id, 'PENDING');
    const p5Moved = await link(p5.id, remove.id, 'REJECTED', decided);
    const p6Kept = await link(p6.id, keep.id, 'APPROVED', decided);

    const res = await merge(c.id, keep.id, actor.cookie);
    expect(res.status).toBe(200);
    expect(res.body.merge).toMatchObject({ relationshipsMoved: 3, relationshipsRemoved: 4 }); // moved: p1, p2, p5

    const rows = await prisma.professorPublication.findMany({ orderBy: { id: 'asc' } });
    expect(rows).toHaveLength(6);
    expect(rows.every((r) => r.publicationId === keep.id)).toBe(true);
    const byId = (id: string) => rows.find((r) => r.id === id);
    for (const winner of [p1Winner, p2Winner, p3Winner, p4Winner, p5Moved, p6Kept]) {
      expect(byId(winner.id), winner.id).toEqual({ ...winner, publicationId: keep.id, updatedAt: expect.any(Date) });
    }
    expect(byId(p2Winner.id)?.status).toBe('PENDING');
  });

  it('re-points other open candidates, closes redundant ones, never reopens dismissed pairs, and keeps resolved history', async () => {
    const { merge, me } = await world();
    const { keep, remove, c } = await mergeWorld(me.prof.id);
    const x = await publication({ title: 'X' });
    const y = await publication({ title: 'Y' });
    const z = await publication({ title: 'Z' });
    const repoint = await candidate(remove.id, x.id);
    const dismissedPair = await candidate(keep.id, y.id, 'DISMISSED');
    const redundant = await candidate(remove.id, y.id);
    const history = await candidate(remove.id, z.id, 'DISMISSED');

    const res = await merge(c.id, keep.id);
    expect(res.body.merge).toMatchObject({ candidatesRepointed: 1, candidatesClosed: 1 });
    const after = await prisma.duplicateCandidate.findUniqueOrThrow({ where: { id: repoint.id } });
    expect(after.status).toBe('OPEN');
    expect([after.publicationAId, after.publicationBId]).toEqual(keep.id < x.id ? [keep.id, x.id] : [x.id, keep.id]);
    expect(await prisma.duplicateCandidate.findUniqueOrThrow({ where: { id: dismissedPair.id } })).toMatchObject({ status: 'DISMISSED' });
    const closed = await prisma.duplicateCandidate.findUniqueOrThrow({ where: { id: redundant.id } });
    expect(closed).toMatchObject({ status: 'DISMISSED', resolvedByUserId: me.user.id });
    expect(closed.reason).toContain('the pair already exists');
    const kept = await prisma.duplicateCandidate.findUniqueOrThrow({ where: { id: history.id } });
    expect(kept).toMatchObject({ status: 'DISMISSED', reason: history.reason });
    const pairs = (await prisma.duplicateCandidate.findMany()).filter((d) => d.publicationAId && d.publicationBId).map((d) => `${d.publicationAId}|${d.publicationBId}`);
    expect(new Set(pairs).size).toBe(pairs.length);
  });

  it('merges ACTIVE with SUPPRESSED in either direction without administrator action; the kept publication keeps its status (#150)', async () => {
    const { merge, me } = await world();
    for (const keepStatus of ['ACTIVE', 'SUPPRESSED'] as const) {
      const active = await publication({ title: `Mixed ${keepStatus}` });
      const hidden = await publication({ title: `Mixed ${keepStatus}`, status: 'SUPPRESSED' });
      await link(me.prof.id, hidden.id, 'REJECTED'); // eligible through a rejected link
      const c = await candidate(active.id, hidden.id);
      const keepId = keepStatus === 'ACTIVE' ? active.id : hidden.id;
      const res = await merge(c.id, keepId);
      expect(res.status, keepStatus).toBe(200);
      expect(await prisma.publication.findUniqueOrThrow({ where: { id: keepId } })).toMatchObject({ status: keepStatus });
      expect(await prisma.professorPublication.findFirstOrThrow({ where: { professorId: me.prof.id, publicationId: keepId } })).toMatchObject({ status: 'REJECTED' });
    }
    // Two suppressed publications, and a curated survivor, as before.
    const s1 = await publication({ status: 'SUPPRESSED' });
    const s2 = await publication({ status: 'SUPPRESSED' });
    await link(me.prof.id, s1.id, 'PENDING');
    expect((await merge((await candidate(s1.id, s2.id)).id, s2.id)).status).toBe(200);
    expect(await prisma.publication.findUniqueOrThrow({ where: { id: s2.id } })).toMatchObject({ status: 'SUPPRESSED' });
    const curated = await publication({ title: 'Curated title', isCurated: true, doi: null, records: [{ source: 'OPENALEX' }] });
    const raw = await publication({ title: 'Raw title', doi: '10.1000/raw', records: [{ source: 'DBLP', doi: '10.1000/raw', venue: 'V' }] });
    await link(me.prof.id, raw.id, 'APPROVED');
    expect((await merge((await candidate(curated.id, raw.id)).id, curated.id)).status).toBe(200);
    expect(await prisma.publication.findUniqueOrThrow({ where: { id: curated.id } })).toMatchObject({ title: 'Curated title', doi: null, venue: null, isCurated: true });
  });

  it('refuses a publication outside the candidate, invalid bodies and resolved candidates — changing nothing', async () => {
    const { server, merge, me } = await world();
    const a = await publication();
    const b = await publication();
    const c = await publication();
    await link(me.prof.id, b.id, 'APPROVED');
    await link(me.prof.id, a.id, 'APPROVED');
    const ok = await candidate(b.id, c.id);
    const done = await candidate(a.id, b.id, 'DISMISSED');
    const before = await snapshot();

    expect((await merge(ok.id, a.id)).body.error.code).toBe('INVALID_KEEP_PUBLICATION');
    expect((await merge(ok.id, 'x')).body.error.code).toBe('VALIDATION_ERROR');
    expect((await request(server).post(`${BASE}/${ok.id}/merge`).set('Cookie', me.cookie).send({})).body.error.code).toBe('VALIDATION_ERROR');
    expect((await request(server).post(`${BASE}/${ok.id}/merge`).set('Cookie', me.cookie).send({ keepPublicationId: b.id, extra: 1 })).body.error.code).toBe('VALIDATION_ERROR');
    const resolved = await merge(done.id, a.id);
    expect(resolved.body.error).toMatchObject({ code: 'CANDIDATE_NOT_OPEN', details: { currentStatus: 'DISMISSED' } });
    expect(await snapshot()).toEqual(before);
  });

  it('a relationship removed before the merge takes the candidate out of scope (404, nothing changed)', async () => {
    const { merge, dismiss, me } = await world();
    const { keep, remove, c } = await mergeWorld(me.prof.id);
    await prisma.professorPublication.deleteMany({ where: { professorId: me.prof.id } });
    const before = await snapshot();
    expect((await merge(c.id, keep.id)).body.error.code).toBe('CANDIDATE_NOT_FOUND');
    expect((await dismiss(c.id)).body.error.code).toBe('CANDIDATE_NOT_FOUND');
    expect(await snapshot()).toEqual(before);
    expect(await prisma.publication.findUnique({ where: { id: remove.id } })).not.toBeNull();
  });

  it('a failure part-way through rolls the whole merge back', async () => {
    const { merge, me } = await world();
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { keep, remove, c } = await mergeWorld(me.prof.id);
    await candidate(remove.id, (await publication({ title: 'X' })).id);
    const before = await snapshot();
    await withTrigger('publications', 'BEFORE DELETE', `RAISE EXCEPTION 'phase13b test: delete blocked';`, async () => {
      const res = await merge(c.id, keep.id);
      expect(res.status).toBe(500);
      expect(JSON.stringify(res.body)).not.toContain('phase13b');
    });
    expect(await snapshot()).toEqual(before);
  });
});

describe('preprints and conflicting type families are resolvable like any other candidate (#149)', () => {
  const PAIRS = [
    ['PREPRINT', 'JOURNAL'],
    ['PREPRINT', 'CONFERENCE'],
    ['CONFERENCE', 'JOURNAL'],
    ['BOOK_CHAPTER', 'BOOK'],
    ['JOURNAL', 'OTHER'],
  ] as const;

  it('merges each pair keeping either side, with no restriction', async () => {
    const { merge, me } = await world();
    for (const [typeA, typeB] of PAIRS) {
      for (const keepSide of ['A', 'B'] as const) {
        const a = await publication({ title: `Typed ${typeA} ${typeB} ${keepSide}`, type: typeA, records: [{ source: 'OPENALEX' }] });
        const b = await publication({ title: `Typed ${typeA} ${typeB} ${keepSide}`, type: typeB, records: [{ source: 'DBLP' }] });
        await link(me.prof.id, keepSide === 'A' ? b.id : a.id, 'PENDING'); // linked only to the side that is merged away
        const c = await candidate(a.id, b.id, 'OPEN', `Exact title match blocked: ${typeA} vs ${typeB}`);
        const [keep, remove] = keepSide === 'A' ? [a, b] : [b, a];
        const res = await merge(c.id, keep.id);
        expect(res.status, `${typeA}/${typeB} keep ${keepSide}`).toBe(200);
        expect(res.body.merge).toMatchObject({ removedPublicationId: remove.id, sourceRecordsMoved: 1, relationshipsMoved: 1 });
        expect(await prisma.publication.findUnique({ where: { id: remove.id } })).toBeNull();
        expect((await prisma.publicationSourceRecord.findMany({ where: { publicationId: keep.id } })).map((r) => r.typeFamily).sort()).toEqual([typeA, typeB].sort());
        expect(await prisma.duplicateCandidate.findUniqueOrThrow({ where: { id: c.id } })).toMatchObject({ status: 'MERGED', resolvedByUserId: me.user.id });
        expect(await prisma.professorPublication.findFirstOrThrow({ where: { professorId: me.prof.id } })).toMatchObject({ publicationId: keep.id, status: 'PENDING' });
        await prisma.professorPublication.deleteMany({ where: { professorId: me.prof.id } });
      }
    }
  });

  it('dismisses each pair, keeping both publications', async () => {
    const { dismiss, list, me } = await world();
    const candidates: string[] = [];
    for (const [typeA, typeB] of PAIRS) {
      const a = await publication({ title: `Kept ${typeA} ${typeB}`, type: typeA });
      const b = await publication({ title: `Kept ${typeA} ${typeB}`, type: typeB });
      await link(me.prof.id, a.id, 'APPROVED');
      candidates.push((await candidate(a.id, b.id)).id);
    }
    expect(ids((await list()).body).sort()).toEqual([...candidates].sort());
    for (const id of candidates) {
      const res = await dismiss(id);
      expect(res.status, id).toBe(200);
      expect(res.body.candidate).toMatchObject({ status: 'DISMISSED' });
    }
    expect(await prisma.publication.count()).toBe(PAIRS.length * 2);
    expect(await prisma.duplicateCandidate.count({ where: { status: 'DISMISSED', resolvedByUserId: me.user.id } })).toBe(PAIRS.length);
    expect((await list()).body.total).toBe(0);
  });
});

describe('concurrent resolution: the first resolution wins', () => {
  async function shared() {
    const w = await world();
    const other = await professorSession(w.server, 'other@example.org');
    const keep = await publication({ title: 'Race', records: [{ source: 'OPENALEX' }] });
    const remove = await publication({ title: 'Race', records: [{ source: 'DBLP' }] });
    await link(w.me.prof.id, keep.id, 'APPROVED');
    await link(other.prof.id, remove.id, 'PENDING');
    return { ...w, other, keep, remove, c: await candidate(keep.id, remove.id) };
  }

  it('two professors merging the same candidate: exactly one succeeds', async () => {
    const { merge, other, keep, remove, c } = await shared();
    const results = await Promise.all([merge(c.id, keep.id), merge(c.id, remove.id, other.cookie)]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(results.find((r) => r.status === 409)!.body.error.code).toBe('CANDIDATE_NOT_OPEN');
    expect(await prisma.publication.count()).toBe(1);
    expect(await prisma.publicationSourceRecord.count()).toBe(2);
    expect(await prisma.professorPublication.count()).toBe(2);
  });

  it('a merge and a dismissal of the same candidate: exactly one takes effect, with no partial change', async () => {
    const { merge, dismiss, other, keep, c } = await shared();
    const [merged, dismissed] = await Promise.all([merge(c.id, keep.id), dismiss(c.id, other.cookie)]);
    expect([merged.status, dismissed.status].sort()).toEqual([200, 409]);
    const final = await prisma.duplicateCandidate.findUniqueOrThrow({ where: { id: c.id } });
    if (merged.status === 200) {
      expect(final.status).toBe('MERGED');
      expect(await prisma.publication.count()).toBe(1);
    } else {
      expect(final.status).toBe('DISMISSED');
      expect(await prisma.publication.count()).toBe(2);
      expect(await prisma.publicationSourceRecord.findMany({ select: { matchDetail: true } })).not.toContainEqual({ matchDetail: expect.stringContaining('moved by duplicate candidate') });
    }
  });
});

describe('coordination with synchronization (#91)', () => {
  it('a merge is refused with 409 while a run executes, then succeeds after it; dismissal is unaffected', async () => {
    const prof = await professor('Prof Sync');
    await prisma.externalIdentity.create({ data: { professorId: prof.id, source: 'OPENALEX', externalId: PRIEM } });
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const sync = syncService({ [AUTHOR_URL]: async () => (await gate, toResponse(loadFixture('openalex', 'author-valid'))) });
    const { server, admin, merge, dismiss, me } = await world(sync);
    const a = await publication({ title: 'Same' });
    const b = await publication({ title: 'Same', records: [{ source: 'ORCID' }, { source: 'MANUAL' }] });
    await link(me.prof.id, a.id, 'APPROVED');
    const c = await candidate(a.id, b.id);
    const other = await candidate(a.id, (await publication({ title: 'Other' })).id);

    await request(server).post('/api/admin/sync').set('Cookie', admin).expect(202);
    const before = await snapshot();
    const refused = await merge(c.id, a.id);
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe('SYNC_ALREADY_RUNNING');
    expect(await snapshot()).toEqual(before);
    expect((await dismiss(other.id)).status).toBe(200);

    release();
    await sync.idle();
    expect((await merge(c.id, a.id)).status).toBe(200);
  });

  it('a RUNNING run recorded in the database also blocks a merge', async () => {
    const { merge, me } = await world();
    const a = await publication({ title: 'Same' });
    const b = await publication({ title: 'Same' });
    await link(me.prof.id, b.id, 'PENDING');
    const c = await candidate(a.id, b.id);
    await prisma.syncRun.create({ data: { trigger: 'SCHEDULED', status: 'RUNNING' } });
    expect((await merge(c.id, a.id)).body.error.code).toBe('SYNC_ALREADY_RUNNING');
    expect(await prisma.publication.count()).toBe(2);
  });
});

describe('merges and concurrent manual entries (#96)', () => {
  const KEY = 4242;

  /** Holds a transaction-level advisory lock on another connection until released. */
  async function holdAdvisoryLock() {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let acquired!: () => void;
    const held = new Promise<void>((r) => (acquired = r));
    const done = prisma.$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(${KEY})`;
        acquired();
        await gate;
      },
      { timeout: 30_000 },
    );
    await held;
    return { release, done };
  }

  async function waitUntil(condition: () => Promise<boolean>, what: string) {
    for (let i = 0; i < 200; i++) {
      if (await condition()) return;
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error(`Timed out waiting for: ${what}`);
  }
  const manualBlocked = async () =>
    (await prisma.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory' AND NOT granted`)[0].n > 0;

  /** The manual entry's source-record insert waits on the advisory lock inside its transaction (after matching). */
  async function withBlockedManualInsert(run: () => Promise<void>) {
    await withTrigger('publication_source_records', 'BEFORE INSERT', `IF NEW.source = 'MANUAL' THEN PERFORM pg_advisory_xact_lock(${KEY}); END IF; RETURN NEW;`, run);
  }

  /** The manual entry is made by the resolving professor themself. */
  async function manualWorld() {
    const w = await world();
    const keep = await publication({ title: 'Model checking', doi: null, records: [{ source: 'OPENALEX' }] });
    const remove = await publication({ title: 'Model checking of programs', doi: '10.1000/remove', records: [{ source: 'DBLP', doi: '10.1000/remove' }] });
    await link(w.me.prof.id, keep.id, 'APPROVED');
    return { ...w, keep, remove, c: await candidate(keep.id, remove.id) };
  }

  it('a merge waits for a manual entry matching the removed publication by title; both complete', async () => {
    const { merge, me, keep, remove, c } = await manualWorld();
    const other = await createUser({ email: 'manual@example.org', professor: 'active' });
    const otherProf = await prisma.professor.findUniqueOrThrow({ where: { userId: other.id } });
    await withBlockedManualInsert(async () => {
      const lock = await holdAdvisoryLock();
      const manual = addManualPublication(otherProf.id, other.id, { title: 'Model checking of programs', typeFamily: 'JOURNAL', year: 2020, ...INDEPENDENT_ENTRY }, new Date(NOW));
      await waitUntil(manualBlocked, 'manual entry inside its transaction');

      const merging = merge(c.id, keep.id).then((r) => r);
      // The merge cannot proceed while the manual entry holds the title.
      await new Promise((r) => setTimeout(r, 300));
      expect((await prisma.duplicateCandidate.findUniqueOrThrow({ where: { id: c.id } })).status).toBe('OPEN');
      expect(await prisma.publication.findUnique({ where: { id: remove.id } })).not.toBeNull();

      lock.release();
      await lock.done;
      expect((await manual).match).toMatchObject({ outcome: 'MATCHED_TITLE_YEAR', relationship: 'CREATED' });
      const res = await merging;
      expect(res.status).toBe(200);
      expect(res.body.merge).toMatchObject({ sourceRecordsMoved: 2, relationshipsMoved: 1 });
    });
    expect(await prisma.publicationSourceRecord.findFirstOrThrow({ where: { source: 'MANUAL' } })).toMatchObject({ publicationId: keep.id });
    expect(await prisma.professorPublication.findMany({ where: { professorId: otherProf.id } })).toEqual([
      expect.objectContaining({ publicationId: keep.id, status: 'APPROVED', origin: 'MANUAL' }),
    ]);
    expect(await prisma.professorPublication.findMany({ where: { professorId: me.prof.id } })).toEqual([expect.objectContaining({ publicationId: keep.id, status: 'APPROVED' })]);
    expect(await prisma.publication.count()).toBe(1);
  });

  it('a manual entry matching the removed publication by DOI is re-matched to the survivor instead of failing', async () => {
    const { merge, keep, remove, c } = await manualWorld();
    const other = await createUser({ email: 'manual@example.org', professor: 'active' });
    const otherProf = await prisma.professor.findUniqueOrThrow({ where: { userId: other.id } });
    await withBlockedManualInsert(async () => {
      const lock = await holdAdvisoryLock();
      const manual = addManualPublication(otherProf.id, other.id, { title: 'Model checking of programs: an extended study', typeFamily: 'JOURNAL', year: 2020, doi: '10.1000/REMOVE', ...INDEPENDENT_ENTRY }, new Date(NOW)).then(
        (value) => ({ value }),
        (error: unknown) => ({ error }),
      );
      await waitUntil(manualBlocked, 'manual entry inside its transaction');

      const res = await merge(c.id, keep.id);
      expect(res.status).toBe(200);
      expect(await prisma.publication.findUnique({ where: { id: remove.id } })).toBeNull();

      lock.release();
      await lock.done;
      const outcome = await manual;
      expect(outcome).not.toHaveProperty('error');
      expect((outcome as { value: { match: unknown } }).value.match).toMatchObject({ outcome: 'MATCHED_DOI', relationship: 'CREATED' });
    });
    expect(await prisma.publicationSourceRecord.findFirstOrThrow({ where: { source: 'MANUAL' } })).toMatchObject({ publicationId: keep.id, matchMethod: 'DOI' });
  });

  it('a title that appears after the locks were chosen makes the merge refuse with 409 MERGE_CONFLICT and change nothing', async () => {
    const { merge, keep, remove, c } = await manualWorld();
    const before = await snapshot();
    await withTrigger(
      'duplicate_candidates',
      'BEFORE UPDATE',
      `UPDATE publication_source_records SET normalized_title = 'retitled meanwhile' WHERE publication_id = '${remove.id}'; RETURN NEW;`,
      async () => {
        const res = await merge(c.id, keep.id);
        expect(res.status).toBe(409);
        expect(res.body.error.code).toBe('MERGE_CONFLICT');
      },
    );
    expect(await snapshot()).toEqual(before);
  });
});
