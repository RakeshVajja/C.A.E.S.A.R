import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '../../src/config/database';
import { cookiePair, createUser, PASSWORD } from '../auth/helpers';
import { resetDatabase } from '../helpers/database';
import { candidate, link, professor, professorSession, publication, setup } from '../publications/helpers';

/*
 * DELETE /api/admin/professors/:professorId (decision #170): permanent deletion of an inactive
 * professor's record — account, identities, every relationship and the publications no other
 * professor is linked to (with their source records and citation observations) — in one
 * transaction under the synchronization guard. Synthetic rows only; no network.
 */

beforeEach(async () => {
  await resetDatabase();
});

afterAll(async () => {
  await resetDatabase();
  await prisma.$disconnect();
});

/**
 * Target T (inactive, with a login account and two identities); co-author C (active).
 *   sole1   T APPROVED only, OpenAlex + Scopus record with a citation observation
 *   sole2   T REJECTED only (rejected papers are T's too), MANUAL record
 *   shared  T APPROVED + C APPROVED — kept
 *   pending T PENDING + C REJECTED — kept (C has a relationship of some status)
 *   other   C only — untouched
 * Candidates: OPEN (sole1, other) → closed; MERGED (sole2, shared) → kept; OPEN (shared, other) → untouched.
 */
async function world() {
  const { server, admin, adminUser } = await setup();
  const user = await createUser({ email: 'target@example.org', professor: 'active' });
  const target = await prisma.professor.findUniqueOrThrow({ where: { userId: user.id } });
  const coauthor = await professor('Co Author');
  const idA = await prisma.externalIdentity.create({ data: { professorId: target.id, source: 'OPENALEX', externalId: 'A5000000001' } });
  await prisma.externalIdentity.create({ data: { professorId: target.id, source: 'DBLP', externalId: 'pid/1' } });
  const run = await prisma.syncRun.create({ data: { trigger: 'MANUAL', status: 'SUCCESS', finishedAt: new Date() } });
  const task = await prisma.syncTask.create({ data: { syncRunId: run.id, identityId: idA.id, source: 'OPENALEX', status: 'SUCCESS' } });

  const sole1 = await publication({ title: 'Sole approved', records: [{ source: 'OPENALEX' }, { source: 'SCOPUS' }] });
  const sole2 = await publication({ title: 'Sole rejected', records: [{ source: 'MANUAL' }] });
  const shared = await publication({ title: 'Shared paper' });
  const pending = await publication({ title: 'Pending with co-author rejection' });
  const other = await publication({ title: 'Co-author only' });
  await link(target.id, sole1.id, 'APPROVED');
  await link(target.id, sole2.id, 'REJECTED');
  await link(target.id, shared.id, 'APPROVED');
  await link(coauthor.id, shared.id, 'APPROVED', { decidedAt: new Date('2026-05-01T00:00:00Z') });
  await link(target.id, pending.id, 'PENDING');
  await link(coauthor.id, pending.id, 'REJECTED');
  await link(coauthor.id, other.id, 'APPROVED');
  await prisma.professorPublication.updateMany({ where: { professorId: target.id, publicationId: sole1.id }, data: { discoveredViaIdentityId: idA.id } });
  const scopus = await prisma.publicationSourceRecord.findFirstOrThrow({ where: { publicationId: sole1.id, source: 'SCOPUS' } });
  await prisma.citationObservation.create({ data: { sourceRecordId: scopus.id, provider: 'SCOPUS', count: 5, observedAt: new Date('2026-06-01T00:00:00Z'), syncTaskId: task.id } });
  const openGone = await candidate(sole1.id, other.id, 'OPEN', 'Exact title match blocked: test');
  const merged = await candidate(sole2.id, shared.id, 'MERGED');
  const openKept = await candidate(shared.id, other.id, 'OPEN');
  await prisma.professor.update({ where: { id: target.id }, data: { isActive: false } });

  const del = (id: string, confirmName: unknown, cookie = admin) => request(server).delete(`/api/admin/professors/${id}`).set('Cookie', cookie).send({ confirmName });
  return { server, admin, adminUser, user, target, coauthor, sole1, sole2, shared, pending, other, task, openGone, merged, openKept, del };
}

describe('access and preconditions', () => {
  it('admin only: no session 401, professor FORBIDDEN, temporary password refused, foreign Origin refused', async () => {
    const w = await world();
    const prof = await professorSession(w.server, 'prof@example.org');
    await createUser({ email: 'temp-admin@example.org', role: 'ADMIN', mustChangePassword: true });
    const temp = cookiePair(await request(w.server).post('/api/auth/login').send({ email: 'temp-admin@example.org', password: PASSWORD }), 'cse_session');
    const path = `/api/admin/professors/${w.target.id}`;
    const body = { confirmName: w.target.name };
    expect((await request(w.server).delete(path).send(body)).status).toBe(401);
    expect((await request(w.server).delete(path).set('Cookie', prof.cookie).send(body)).body.error.code).toBe('FORBIDDEN');
    expect((await request(w.server).delete(path).set('Cookie', temp).send(body)).body.error.code).toBe('PASSWORD_CHANGE_REQUIRED');
    expect((await request(w.server).delete(path).set('Cookie', w.admin).set('Origin', 'https://evil.example').send(body)).body.error.code).toBe('ORIGIN_NOT_ALLOWED');
    expect(await prisma.professor.count({ where: { id: w.target.id } })).toBe(1);
  });

  it('refuses an active professor, a wrong or missing confirmation, an unknown professor, and a running synchronization — changing nothing', async () => {
    const w = await world();
    const counts = async () => [await prisma.professor.count(), await prisma.publication.count(), await prisma.professorPublication.count(), await prisma.user.count()];
    const before = await counts();
    await prisma.professor.update({ where: { id: w.target.id }, data: { isActive: true } });
    expect((await w.del(w.target.id, w.target.name)).body.error.code).toBe('PROFESSOR_ACTIVE');
    await prisma.professor.update({ where: { id: w.target.id }, data: { isActive: false } });
    expect((await w.del(w.target.id, 'someone else')).body.error.code).toBe('CONFIRMATION_MISMATCH');
    expect((await w.del(w.target.id, undefined)).body.error.code).toBe('VALIDATION_ERROR');
    expect((await request(w.server).delete(`/api/admin/professors/${w.target.id}`).set('Cookie', w.admin).send({ confirmName: w.target.name, cascade: true })).body.error.code).toBe('VALIDATION_ERROR');
    expect((await w.del('00000000-0000-4000-8000-000000000000', 'x')).status).toBe(404);
    expect((await w.del('not-a-uuid', 'x')).status).toBe(404);
    const running = await prisma.syncRun.create({ data: { trigger: 'SCHEDULED', status: 'RUNNING' } });
    expect((await w.del(w.target.id, w.target.name)).body.error.code).toBe('SYNC_ALREADY_RUNNING');
    await prisma.syncRun.delete({ where: { id: running.id } });
    expect(await counts()).toEqual(before);
  });
});

describe('deletion', () => {
  it('deletes the account, identities, every relationship and the sole-owner publications; keeps shared publications and other professors’ data', async () => {
    const w = await world();
    const res = await w.del(w.target.id, `  ${w.target.name} `);
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toContain('no-store');
    expect(res.body.deleted).toEqual({
      professor: { id: w.target.id, name: w.target.name },
      account: true,
      identities: 2,
      relationships: 4,
      publications: 2,
      sourceRecords: 3,
      candidatesClosed: 1,
    });

    expect(await prisma.professor.findUnique({ where: { id: w.target.id } })).toBeNull();
    expect(await prisma.user.findUnique({ where: { id: w.user.id } })).toBeNull();
    expect(await prisma.externalIdentity.count({ where: { professorId: w.target.id } })).toBe(0);
    expect(await prisma.professorPublication.count({ where: { professorId: w.target.id } })).toBe(0);
    // Sole-owner publications are gone with their source records and citation observations.
    expect(await prisma.publication.count({ where: { id: { in: [w.sole1.id, w.sole2.id] } } })).toBe(0);
    expect(await prisma.publicationSourceRecord.count({ where: { publicationId: { in: [w.sole1.id, w.sole2.id] } } })).toBe(0);
    expect(await prisma.citationObservation.count()).toBe(0);
    // Shared publications stay, with the co-author's relationships and decisions unchanged.
    expect((await prisma.publication.findMany({ select: { id: true }, orderBy: { title: 'asc' } })).map((p) => p.id).sort()).toEqual([w.shared.id, w.pending.id, w.other.id].sort());
    expect(await prisma.professorPublication.findMany({ where: { professorId: w.coauthor.id }, select: { publicationId: true, status: true, decidedAt: true }, orderBy: { publicationId: 'asc' } })).toEqual(
      [
        { publicationId: w.shared.id, status: 'APPROVED', decidedAt: new Date('2026-05-01T00:00:00Z') },
        { publicationId: w.pending.id, status: 'REJECTED', decidedAt: null },
        { publicationId: w.other.id, status: 'APPROVED', decidedAt: null },
      ].sort((a, b) => a.publicationId.localeCompare(b.publicationId)),
    );
    expect(await prisma.publicationSourceRecord.count({ where: { publicationId: { in: [w.shared.id, w.pending.id, w.other.id] } } })).toBe(3);
    // Candidates: the OPEN one that lost a publication is closed; resolved and unrelated ones keep their status.
    const gone = await prisma.duplicateCandidate.findUniqueOrThrow({ where: { id: w.openGone.id } });
    expect(gone).toMatchObject({ status: 'DISMISSED', resolvedByUserId: w.adminUser.id });
    expect([gone.publicationAId, gone.publicationBId].filter(Boolean)).toEqual([w.other.id]);
    expect(gone.reason).toContain("deleted with its professor's record (#170)");
    const merged = await prisma.duplicateCandidate.findUniqueOrThrow({ where: { id: w.merged.id } });
    expect(merged.status).toBe('MERGED');
    expect([merged.publicationAId, merged.publicationBId].filter(Boolean)).toEqual([w.shared.id]);
    expect(await prisma.duplicateCandidate.findUniqueOrThrow({ where: { id: w.openKept.id } })).toMatchObject({ status: 'OPEN' });
    // Run history stays; the task's identity reference is cleared.
    expect(await prisma.syncTask.findUniqueOrThrow({ where: { id: w.task.id } })).toMatchObject({ identityId: null, status: 'SUCCESS' });
    // The co-author and the administrator are untouched.
    expect(await prisma.professor.count({ where: { id: w.coauthor.id } })).toBe(1);
    expect(await prisma.user.count({ where: { id: w.adminUser.id } })).toBe(1);
    // A second request finds nothing.
    expect((await w.del(w.target.id, w.target.name)).status).toBe(404);
  });

  it('a professor without an account or publications is deleted alone; department analytics drop the deleted professor', async () => {
    const w = await world();
    const lone = await professor('Lone Professor', false);
    const res = await w.del(lone.id, 'Lone Professor');
    expect(res.body.deleted).toEqual({ professor: { id: lone.id, name: 'Lone Professor' }, account: false, identities: 0, relationships: 0, publications: 0, sourceRecords: 0, candidatesClosed: 0 });
    expect(await prisma.publication.count()).toBe(5);
    await w.del(w.target.id, w.target.name);
    const perProfessor = (await request(w.server).get('/api/admin/analytics/professors').set('Cookie', w.admin)).body.professors.map((p: { name: string }) => p.name);
    expect(perProfessor).toEqual(['Co Author']);
    const listed = (await request(w.server).get('/api/admin/professors').set('Cookie', w.admin)).body.professors.map((p: { id: string }) => p.id);
    expect(listed).toEqual([w.coauthor.id]);
  });
});
