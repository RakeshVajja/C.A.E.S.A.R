import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../../src/app';
import { prisma } from '../../src/config/database';
import { DblpClient } from '../../src/integrations/dblp/client';
import { OpenAlexClient } from '../../src/integrations/openalex/client';
import { OrcidClient } from '../../src/integrations/orcid/client';
import { startIdentitySync, type IdentityClients } from '../../src/services/identities/identities';
import { coverageSnapshot, parseCoverageSnapshot } from '../../src/services/sync/runOutcome';
import { recoverInterruptedRuns, SyncService } from '../../src/services/sync/syncService';
import { cookiePair, createUser, PASSWORD, testClock } from '../auth/helpers';
import { resetDatabase } from '../helpers/database';
import { loadFixture, noSleep, replayFetch, Route, toResponse } from '../helpers/fixtures';
import { allProvidersPresent, noLicensedProviders } from '../helpers/providers';
import { AUTHOR_URL, link, NOW, PRIEM, professorSession, publication } from '../publications/helpers';
import { adminCookie, replayIdentityClients } from './helpers';

/*
 * Professor self-service identities (decision #171): /api/me/identities — session-derived
 * ownership, redaction, preview tokens, manual Scopus / Web of Science registration, rate limits —
 * and identity-scoped synchronization: started at once, queued while a run is active (one follow-up
 * run for every queued identity, each once), stale queued work excluded, startup drain, retry by
 * full runs only, status, admin attribution and sync history, coverage-snapshot compatibility.
 * Synthetic and recorded responses only; no network. Scopus / Web of Science are not configured,
 * as in the test environment.
 */

const BASE = '/api/me/identities';
const MERGED = 'A1234567890'; // OpenAlex ID merged into PRIEM (recorded preview)
const VARDI_DBLP = 'v/MosheYVardi';
const VARDI_ORCID = '0000-0002-0661-5773';
const CARBERRY_ORCID = '0000-0002-1825-0097';

beforeEach(async () => {
  await resetDatabase();
  vi.restoreAllMocks();
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterAll(async () => {
  await resetDatabase();
  await prisma.$disconnect();
});

/** A synchronization engine replaying the recorded OpenAlex author and works (others are not recorded and fail). */
function engine(overrides: Record<string, Route> = {}, options: { providers?: ReturnType<typeof noLicensedProviders> } = {}) {
  const recorded = [loadFixture('openalex', 'author-valid'), ...['works-page-1', 'works-page-2', 'works-page-3'].map((n) => loadFixture('openalex', n))];
  const deps = { fetchImpl: replayFetch(recorded, overrides).fetchImpl, sleep: noSleep };
  return new SyncService({
    clients: {
      openAlex: new OpenAlexClient({ perPage: 25, deps, http: { maxRetries: 0 } }),
      dblp: new DblpClient({ deps, http: { maxRetries: 0 } }),
      orcid: new OrcidClient({ deps, http: { maxRetries: 0 } }),
    },
    // A real clock: each run gets its own start time, which orders an identity's tasks (latest first).
    now: () => new Date(),
    providers: options.providers ?? noLicensedProviders(),
  });
}

async function world(options: { sync?: SyncService; identityClients?: IdentityClients } = {}) {
  const sync = options.sync ?? engine();
  const server = createApp({ mailer: null, identityClients: options.identityClients ?? replayIdentityClients().clients, sync, now: testClock(NOW).now });
  const admin = await adminCookie(server);
  const me = await professorSession(server, 'me@example.org');
  const other = await professorSession(server, 'other@example.org');
  const as = (cookie: string) => ({
    get: (path = '') => request(server).get(`${BASE}${path}`).set('Cookie', cookie),
    post: (path: string, body: object) => request(server).post(`${BASE}${path}`).set('Cookie', cookie).send(body),
    patch: (path: string, body: object) => request(server).patch(`${BASE}${path}`).set('Cookie', cookie).send(body),
    del: (path: string) => request(server).delete(`${BASE}${path}`).set('Cookie', cookie),
  });
  /** Preview then save; returns the save response. */
  const add = async (cookie: string, source: string, externalId: string) => {
    const preview = await as(cookie).post('/preview', { source, externalId });
    expect(preview.status, JSON.stringify(preview.body)).toBe(200);
    return as(cookie).post('', { previewToken: preview.body.previewToken });
  };
  return { server, sync, admin, me, other, as, add };
}

/** An identity row as a professor (or admin, or nobody) would have added it. */
async function identityRow(professorId: string, source: 'OPENALEX' | 'DBLP' | 'ORCID' | 'SCOPUS' | 'WOS', externalId: string, verifiedByUserId: string | null) {
  return prisma.externalIdentity.create({ data: { professorId, source, externalId, verifiedByUserId, verificationMethod: verifiedByUserId ? 'API_PREVIEW' : 'PRE_PHASE15' } });
}

const scopeOf = async (runId: string) => parseCoverageSnapshot((await prisma.syncRun.findUniqueOrThrow({ where: { id: runId } })).providerCoverage)?.scope;

describe('access, ownership and privacy', () => {
  it('needs a professor session: 401, administrators FORBIDDEN, temporary password refused, foreign Origin refused, strict bodies', async () => {
    const w = await world();
    await createUser({ email: 'temp@example.org', professor: 'active', mustChangePassword: true });
    const temp = cookiePair(await request(w.server).post('/api/auth/login').send({ email: 'temp@example.org', password: PASSWORD }), 'cse_session');
    const id = '00000000-0000-4000-8000-000000000001';
    for (const [method, path, body] of [
      ['get', BASE, undefined],
      ['post', `${BASE}/preview`, { source: 'OPENALEX', externalId: PRIEM }],
      ['post', BASE, { previewToken: 'x' }],
      ['post', `${BASE}/manual`, { source: 'SCOPUS', externalId: '1', evidenceUrl: 'x', checkedProfile: true }],
      ['patch', `${BASE}/${id}`, { isActive: false }],
      ['delete', `${BASE}/${id}`, undefined],
    ] as const) {
      expect((await request(w.server)[method](path).send(body)).status, path).toBe(401);
      expect((await request(w.server)[method](path).set('Cookie', w.admin).send(body)).body.error.code, path).toBe('FORBIDDEN');
      expect((await request(w.server)[method](path).set('Cookie', temp).send(body)).body.error.code, path).toBe('PASSWORD_CHANGE_REQUIRED');
    }
    expect((await request(w.server).post(`${BASE}/preview`).set('Cookie', w.me.cookie).set('Origin', 'https://evil.example').send({ source: 'OPENALEX', externalId: PRIEM })).body.error.code).toBe('ORIGIN_NOT_ALLOWED');
    expect((await w.as(w.me.cookie).post('/preview', { source: 'OPENALEX', externalId: PRIEM, professorId: w.other.prof.id })).body.error.code).toBe('VALIDATION_ERROR');
    expect((await w.as(w.me.cookie).post('', { previewToken: 'x', professorId: w.other.prof.id })).body.error.code).toBe('VALIDATION_ERROR');
  });

  it("another professor's identities are never listed, changed or removed (404), and their ownership is not disclosed", async () => {
    const w = await world();
    const theirs = await identityRow(w.other.prof.id, 'OPENALEX', PRIEM, null);
    expect((await w.as(w.me.cookie).get()).body.identities).toEqual([]);
    expect((await w.as(w.me.cookie).patch(`/${theirs.id}`, { isActive: false })).status).toBe(404);
    expect((await w.as(w.me.cookie).del(`/${theirs.id}`)).status).toBe(404);
    expect((await w.as(w.me.cookie).del('/not-a-uuid')).status).toBe(404);
    expect(await prisma.externalIdentity.findUniqueOrThrow({ where: { id: theirs.id } })).toMatchObject({ isActive: true });

    const preview = await w.as(w.me.cookie).post('/preview', { source: 'OPENALEX', externalId: PRIEM });
    expect(preview.status).toBe(200);
    expect(preview.body.preview.displayName).toBeTruthy(); // the provider-reported researcher name
    expect(preview.body.alreadyAssigned).toBe('ANOTHER_PROFESSOR');
    const text = JSON.stringify(preview.body);
    for (const secret of [w.other.prof.id, theirs.id, w.other.prof.name]) expect(text).not.toContain(secret);
    const save = await w.as(w.me.cookie).post('', { previewToken: preview.body.previewToken });
    expect([save.status, save.body.error.code]).toEqual([409, 'IDENTITY_IN_USE']);
    expect(JSON.stringify(save.body)).not.toContain(w.other.prof.id);
  });

  it('a preview token is bound to the professor who previewed', async () => {
    const w = await world();
    const preview = await w.as(w.me.cookie).post('/preview', { source: 'OPENALEX', externalId: PRIEM });
    const stolen = await w.as(w.other.cookie).post('', { previewToken: preview.body.previewToken });
    expect([stolen.status, stolen.body.error.code]).toEqual([400, 'INVALID_PREVIEW']);
    expect(await prisma.externalIdentity.count()).toBe(0);
  });

  it('rate limits: 10 previews per 10 minutes and 5 additions per hour, per professor', async () => {
    const w = await world();
    for (let i = 0; i < 10; i++) expect((await w.as(w.me.cookie).post('/preview', { source: 'OPENALEX', externalId: PRIEM })).status).toBe(200);
    const limited = await w.as(w.me.cookie).post('/preview', { source: 'OPENALEX', externalId: PRIEM });
    expect([limited.status, limited.body.error.code]).toEqual([429, 'RATE_LIMITED']);
    expect(limited.headers['retry-after']).toBeDefined();
    expect((await w.as(w.other.cookie).post('/preview', { source: 'OPENALEX', externalId: PRIEM })).status).toBe(200); // per professor
    for (let i = 0; i < 5; i++) expect((await w.as(w.me.cookie).post('', { previewToken: `bad-${i}` })).body.error.code).toBe('INVALID_PREVIEW');
    expect((await w.as(w.me.cookie).post('', { previewToken: 'bad' })).status).toBe(429);
    expect((await w.as(w.me.cookie).post('/manual', { source: 'SCOPUS', externalId: '7004212771', evidenceUrl: 'https://www.scopus.com/authid/detail.uri?authorId=7004212771', checkedProfile: true })).status).toBe(429);
  });
});

describe('adding, changing and removing own identities', () => {
  it('a previewed identity is active at once, attributed to the professor, and synchronized on its own (STARTED)', async () => {
    const w = await world();
    const adminOwned = await identityRow(w.other.prof.id, 'DBLP', VARDI_DBLP, null); // must not be synchronized
    const res = await w.add(w.me.cookie, 'OPENALEX', PRIEM);
    expect(res.status).toBe(201);
    expect(res.body.identity).toMatchObject({ source: 'OPENALEX', externalId: PRIEM, isActive: true, addedBy: { kind: 'PROFESSOR', name: w.me.prof.name } });
    expect(res.body.sync).toEqual({ status: 'STARTED', runId: expect.any(String) });
    expect(await prisma.externalIdentity.findUniqueOrThrow({ where: { id: res.body.identity.id } })).toMatchObject({ verifiedByUserId: w.me.user.id, verificationMethod: 'API_PREVIEW' });

    await w.sync.idle();
    const run = await prisma.syncRun.findUniqueOrThrow({ where: { id: res.body.sync.runId }, include: { tasks: true } });
    expect(run).toMatchObject({ trigger: 'MANUAL', triggeredByUserId: w.me.user.id, tasksTotal: 1 });
    expect(run.tasks.map((t) => t.identityId)).toEqual([res.body.identity.id]);
    expect(await scopeOf(run.id)).toEqual({ kind: 'IDENTITIES', identityIds: [res.body.identity.id], queued: false });
    expect(await prisma.syncTask.count({ where: { identityId: adminOwned.id } })).toBe(0);
    expect(await prisma.syncRun.count()).toBe(1);
    // Discovered publications await the professor's verification.
    expect(await prisma.professorPublication.count({ where: { professorId: w.me.prof.id, status: 'PENDING' } })).toBeGreaterThan(0);
    const listed = (await w.as(w.me.cookie).get()).body.identities;
    expect(listed).toEqual([expect.objectContaining({ id: res.body.identity.id, syncStatus: expect.objectContaining({ state: 'SYNCHRONIZED' }) })]);
  });

  it('manual Scopus registration needs the checked-profile confirmation and valid evidence; it is active and NOT_STARTED while Scopus is not configured', async () => {
    const w = await world();
    const url = 'https://www.scopus.com/authid/detail.uri?authorId=7004212771';
    expect((await w.as(w.me.cookie).post('/manual', { source: 'SCOPUS', externalId: '7004212771', evidenceUrl: url })).body.error.code).toBe('VALIDATION_ERROR');
    expect((await w.as(w.me.cookie).post('/manual', { source: 'SCOPUS', externalId: '7004212771', evidenceUrl: url, checkedProfile: false })).body.error.code).toBe('VALIDATION_ERROR');
    expect((await w.as(w.me.cookie).post('/manual', { source: 'OPENALEX', externalId: PRIEM, evidenceUrl: url, checkedProfile: true })).body.error.code).toBe('VALIDATION_ERROR');
    expect((await w.as(w.me.cookie).post('/manual', { source: 'SCOPUS', externalId: '7004212772', evidenceUrl: url, checkedProfile: true })).body.error.code).toBe('EVIDENCE_MISMATCH');
    const res = await w.as(w.me.cookie).post('/manual', { source: 'SCOPUS', externalId: '7004212771', evidenceUrl: url, checkedProfile: true });
    expect(res.status).toBe(201);
    expect(res.body.identity).toMatchObject({ source: 'SCOPUS', isActive: true, verificationMethod: 'MANUAL_PROFILE', addedBy: { kind: 'PROFESSOR' }, syncStatus: { state: 'WAITING_FOR_PROVIDER' } });
    expect(res.body.sync).toMatchObject({ status: 'NOT_STARTED', reason: expect.stringContaining('not configured') });
    expect(await prisma.syncRun.count()).toBe(0);
    // With a previewable provider the manual path is refused.
    await resetDatabase();
    const previewing = await world({ identityClients: { ...replayIdentityClients().clients, scopus: {} as never } });
    expect((await previewing.as(previewing.me.cookie).post('/manual', { source: 'SCOPUS', externalId: '7004212771', evidenceUrl: url, checkedProfile: true })).body.error.code).toBe('PREVIEW_AVAILABLE');
  });

  it('deactivation and removal of own identities remove only their PENDING discoveries', async () => {
    const w = await world();
    const mine = await identityRow(w.me.prof.id, 'DBLP', VARDI_DBLP, w.me.user.id);
    const pending = await publication({ title: 'Pending' });
    const approved = await publication({ title: 'Approved' });
    await link(w.me.prof.id, pending.id, 'PENDING');
    await link(w.me.prof.id, approved.id, 'APPROVED');
    await prisma.professorPublication.updateMany({ where: { professorId: w.me.prof.id }, data: { discoveredViaIdentityId: mine.id } });
    const off = await w.as(w.me.cookie).patch(`/${mine.id}`, { isActive: false });
    expect(off.body).toMatchObject({ identity: { id: mine.id, isActive: false }, pendingLinksRemoved: 1 });
    expect(await prisma.professorPublication.count({ where: { professorId: w.me.prof.id } })).toBe(1);
    expect((await w.as(w.me.cookie).patch(`/${mine.id}`, { isActive: true })).body.identity.isActive).toBe(true);
    expect((await w.as(w.me.cookie).del(`/${mine.id}`)).body).toEqual({ pendingLinksRemoved: 0 });
    expect(await prisma.externalIdentity.count()).toBe(0);
    expect(await prisma.professorPublication.findFirstOrThrow({ where: { professorId: w.me.prof.id } })).toMatchObject({ status: 'APPROVED', discoveredViaIdentityId: null });
  });
});

describe('identity queue', () => {
  it('additions during a run are QUEUED and synchronized together in exactly one follow-up run, each once', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const sync = engine({ [AUTHOR_URL]: async () => (await gate, toResponse(loadFixture('openalex', 'author-valid'))) });
    const w = await world({ sync });
    await identityRow(w.other.prof.id, 'OPENALEX', PRIEM, null); // admin-added: keeps the full run busy
    await request(w.server).post('/api/admin/sync').set('Cookie', w.admin).expect(202);

    const added = [];
    for (const [source, id] of [['ORCID', CARBERRY_ORCID], ['DBLP', VARDI_DBLP], ['ORCID', VARDI_ORCID]] as const) {
      const res = await w.add(w.me.cookie, source, id);
      expect(res.status).toBe(201);
      expect(res.body.sync).toEqual({ status: 'QUEUED' });
      expect(res.body.identity.syncStatus).toEqual({ state: 'QUEUED' });
      added.push(res.body.identity.id as string);
    }
    expect(await prisma.syncRun.count()).toBe(1);
    release();
    await sync.idle();

    const runs = await prisma.syncRun.findMany({ orderBy: { startedAt: 'asc' }, include: { tasks: true } });
    expect(runs).toHaveLength(2);
    const followUp = runs[1];
    expect(followUp).toMatchObject({ trigger: 'MANUAL', triggeredByUserId: null, tasksTotal: 3 });
    expect(followUp.tasks.map((t) => t.identityId).sort()).toEqual([...added].sort());
    expect(await scopeOf(followUp.id)).toEqual({ kind: 'IDENTITIES', identityIds: expect.arrayContaining(added), queued: true });
    // Nothing further is queued: draining again starts nothing.
    expect(await sync.drainIdentityQueue()).toBeNull();
    expect(await prisma.syncRun.count()).toBe(2);
  });

  it('a deactivated, deleted or inactive-professor identity is excluded when the queue drains', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const sync = engine({ [AUTHOR_URL]: async () => (await gate, toResponse(loadFixture('openalex', 'author-valid'))) });
    const w = await world({ sync });
    const third = await professorSession(w.server, 'third@example.org');
    await identityRow(w.other.prof.id, 'OPENALEX', PRIEM, null);
    await request(w.server).post('/api/admin/sync').set('Cookie', w.admin).expect(202);
    const keep = await identityRow(w.me.prof.id, 'DBLP', VARDI_DBLP, w.me.user.id);
    const deactivated = await identityRow(w.me.prof.id, 'ORCID', VARDI_ORCID, w.me.user.id);
    const deleted = await identityRow(w.me.prof.id, 'OPENALEX', MERGED, w.me.user.id);
    const inactiveProfessor = await identityRow(third.prof.id, 'OPENALEX', 'A1000000005', third.user.id);
    await prisma.externalIdentity.update({ where: { id: deactivated.id }, data: { isActive: false } });
    await prisma.externalIdentity.delete({ where: { id: deleted.id } });
    await prisma.professor.update({ where: { id: third.prof.id }, data: { isActive: false } });
    release();
    await sync.idle();
    const followUp = await prisma.syncRun.findFirstOrThrow({ where: { triggeredByUserId: null }, include: { tasks: true } });
    expect(followUp.tasks.map((t) => t.identityId)).toEqual([keep.id]);
    expect(await prisma.syncTask.count({ where: { identityId: { in: [deactivated.id, inactiveProfessor.id] } } })).toBe(0);
  });

  it('a failed identity-only task is not retried by the queue; the next full run retries it', async () => {
    let attempts = 0;
    const sync = engine({
      [AUTHOR_URL]: async () => {
        if (attempts++ === 0) throw new Error('OpenAlex unreachable');
        return toResponse(loadFixture('openalex', 'author-valid'));
      },
    });
    const w = await world({ sync });
    const res = await w.add(w.me.cookie, 'OPENALEX', PRIEM);
    expect(res.body.sync.status).toBe('STARTED');
    await sync.idle();
    const [status] = (await w.as(w.me.cookie).get()).body.identities.map((i: { syncStatus: unknown }) => i.syncStatus);
    expect(status).toMatchObject({ state: 'FAILED', message: expect.any(String) });
    // Saved and still active; not queued again, whatever triggers a drain.
    expect(await prisma.externalIdentity.findUniqueOrThrow({ where: { id: res.body.identity.id } })).toMatchObject({ isActive: true });
    expect(await sync.drainIdentityQueue()).toBeNull();
    expect(await prisma.syncRun.count()).toBe(1);
    // A full manual run retries it with the existing pipeline.
    await request(w.server).post('/api/admin/sync').set('Cookie', w.admin).expect(202);
    await sync.idle();
    expect(await prisma.syncRun.count()).toBe(2);
    expect(await prisma.syncTask.count({ where: { identityId: res.body.identity.id } })).toBe(2);
    expect((await w.as(w.me.cookie).get()).body.identities[0].syncStatus).toMatchObject({ state: 'SYNCHRONIZED' });
  });

  it('startup: never-attempted identities are drained once; interrupted ones are not requeued; repeated startups create no duplicate runs', async () => {
    const sync = engine();
    const w = await world({ sync });
    const saved = await identityRow(w.me.prof.id, 'OPENALEX', PRIEM, w.me.user.id); // saved, then the process stopped
    const interrupted = await identityRow(w.other.prof.id, 'DBLP', VARDI_DBLP, w.other.user.id);
    await prisma.syncRun.create({ data: { trigger: 'MANUAL', status: 'RUNNING', tasksTotal: 1, tasks: { create: [{ identityId: interrupted.id, source: 'DBLP', status: 'RUNNING' }] } } });

    expect(await recoverInterruptedRuns(new Date(NOW))).toBe(1);
    const first = await sync.drainIdentityQueue();
    expect(first).toMatchObject({ identities: 1 });
    await sync.idle();
    const drained = await prisma.syncRun.findUniqueOrThrow({ where: { id: first!.runId }, include: { tasks: true } });
    expect(drained.tasks.map((t) => t.identityId)).toEqual([saved.id]);
    expect(await prisma.syncTask.findFirstOrThrow({ where: { identityId: interrupted.id } })).toMatchObject({ status: 'FAILED' });

    // A second startup: recovery finds nothing and the queue is empty.
    expect(await recoverInterruptedRuns(new Date(NOW))).toBe(0);
    expect(await sync.drainIdentityQueue()).toBeNull();
    expect(await prisma.syncRun.count()).toBe(2);
  });

  it('admin-added and unrecorded identities are never queued; full runs still synchronize every active identity without a scope', async () => {
    const sync = engine();
    const w = await world({ sync });
    const adminUser = await prisma.user.findFirstOrThrow({ where: { role: 'ADMIN' } });
    await identityRow(w.me.prof.id, 'OPENALEX', PRIEM, adminUser.id);
    await identityRow(w.other.prof.id, 'DBLP', VARDI_DBLP, null);
    expect(await sync.drainIdentityQueue()).toBeNull();
    const run = await request(w.server).post('/api/admin/sync').set('Cookie', w.admin).expect(202);
    await sync.idle();
    const full = await prisma.syncRun.findUniqueOrThrow({ where: { id: run.body.run.id } });
    expect(full.tasksTotal).toBe(2);
    expect(await scopeOf(full.id)).toBeUndefined();
    expect(run.body.run).toMatchObject({ scope: null, startedBy: { role: 'ADMIN' } });
    expect(await prisma.syncRun.count()).toBe(1);
  });
});

describe('administrator visibility', () => {
  it('admins see who added each identity, its active state and latest synchronization; sync history labels identity runs', async () => {
    const w = await world();
    const adminUser = await prisma.user.findFirstOrThrow({ where: { role: 'ADMIN' } });
    await identityRow(w.me.prof.id, 'DBLP', VARDI_DBLP, adminUser.id);
    await identityRow(w.me.prof.id, 'ORCID', VARDI_ORCID, null);
    const added = await w.add(w.me.cookie, 'OPENALEX', PRIEM);
    await w.sync.idle();
    const scopus = await w.as(w.me.cookie).post('/manual', { source: 'SCOPUS', externalId: '7004212771', evidenceUrl: 'https://www.scopus.com/authid/detail.uri?authorId=7004212771', checkedProfile: true });
    expect(scopus.status).toBe(201);

    const detail = (await request(w.server).get(`/api/admin/professors/${w.me.prof.id}`).set('Cookie', w.admin)).body.professor;
    const bySource = Object.fromEntries(detail.identities.map((i: { source: string }) => [i.source, i]));
    expect(bySource.OPENALEX).toMatchObject({ isActive: true, addedBy: { kind: 'PROFESSOR', name: w.me.prof.name }, syncStatus: { state: 'SYNCHRONIZED' } });
    expect(bySource.DBLP).toMatchObject({ addedBy: { kind: 'ADMIN' }, syncStatus: { state: 'NEVER', includedInNextRun: true } });
    expect(bySource.ORCID).toMatchObject({ addedBy: { kind: 'ADMIN_UNRECORDED' }, syncStatus: { state: 'NEVER', includedInNextRun: true } });
    expect(bySource.SCOPUS).toMatchObject({ addedBy: { kind: 'PROFESSOR' }, syncStatus: { state: 'WAITING_FOR_PROVIDER' } });

    const runs = (await request(w.server).get('/api/admin/sync/runs').set('Cookie', w.admin)).body.runs;
    expect(runs).toEqual([expect.objectContaining({ id: added.body.sync.runId, trigger: 'MANUAL', scope: { kind: 'IDENTITIES', identityIds: [added.body.identity.id], queued: false }, startedBy: { role: 'PROFESSOR', name: w.me.prof.name } })]);
    expect(runs[0]).not.toHaveProperty('providerCoverage');
    const one = (await request(w.server).get(`/api/admin/sync/runs/${added.body.sync.runId}`).set('Cookie', w.admin)).body.run;
    expect(one).toMatchObject({ scope: { queued: false }, startedBy: { role: 'PROFESSOR' }, coverage: expect.any(Object) });
    // Existing admin identity operations are unchanged.
    expect((await request(w.server).patch(`/api/admin/professors/${w.me.prof.id}/identities/${added.body.identity.id}`).set('Cookie', w.admin).send({ isActive: false })).status).toBe(200);
  });
});

describe('coverage snapshot compatibility (version 1)', () => {
  it('parses snapshots without a scope, with a valid scope, and rejects a malformed scope', () => {
    const providers = noLicensedProviders();
    const old = coverageSnapshot(providers, [{ source: 'OPENALEX' }]);
    expect(old).not.toHaveProperty('scope');
    expect(parseCoverageSnapshot(JSON.parse(JSON.stringify(old)))).toEqual(old);
    const id = '00000000-0000-4000-8000-000000000001';
    const scoped = coverageSnapshot(providers, [{ source: 'OPENALEX' }], { scope: { kind: 'IDENTITIES', identityIds: [id], queued: true } });
    expect(parseCoverageSnapshot(JSON.parse(JSON.stringify(scoped)))).toEqual(scoped);
    expect(parseCoverageSnapshot({ ...old, scope: { kind: 'IDENTITIES', identityIds: [id], queued: true, extra: 1 } })).toBeNull();
    expect(parseCoverageSnapshot({ ...old, scope: { kind: 'ALL', identityIds: [id], queued: false } })).toBeNull();
  });
});

/*
 * Review corrections (#171): dashboard metrics of full runs only, the queue race after a start that
 * created no run, deterministic latest-task selection on tied timestamps, QUEUED only while a drain
 * will follow, and the engine's own provider availability for administrators.
 */

describe('dashboard metrics describe full runs only', () => {
  it('a failed full run followed by a successful identity-only run: the dashboard still reports the failed full run; the history lists both', async () => {
    const sync = engine();
    const w = await world({ sync });
    const adminUser = await prisma.user.findFirstOrThrow({ where: { role: 'ADMIN' } });
    // A run from before Phase 15 (no coverage snapshot) still counts as a full run.
    const legacy = await prisma.syncRun.create({
      data: { trigger: 'SCHEDULED', status: 'SUCCESS', startedAt: new Date(Date.now() - 86_400_000), finishedAt: new Date(Date.now() - 86_000_000) },
    });
    // Full run: its only identity is DBLP, whose responses are not recorded, so it FAILS.
    await identityRow(w.other.prof.id, 'DBLP', VARDI_DBLP, adminUser.id);
    const full = (await request(w.server).post('/api/admin/sync').set('Cookie', w.admin).expect(202)).body.run;
    await sync.idle();
    expect(await prisma.syncRun.findUniqueOrThrow({ where: { id: full.id } })).toMatchObject({ status: 'FAILED' });
    // Then a professor's identity-only run succeeds.
    const added = await w.add(w.me.cookie, 'OPENALEX', PRIEM);
    expect(added.body.sync.status).toBe('STARTED');
    await sync.idle();
    // Its OpenAlex task succeeded; the run is PARTIAL_SUCCESS because Scopus and Web of Science are not
    // configured here (coverage rules, #130), as for a full run.
    expect(await prisma.syncRun.findUniqueOrThrow({ where: { id: added.body.sync.runId } })).toMatchObject({ status: 'PARTIAL_SUCCESS', tasksSucceeded: 1 });
    const overviewNow = async () => (await request(w.server).get('/api/admin/analytics/overview').set('Cookie', w.admin).expect(200)).body.overview;
    expect((await overviewNow()).lastSync).toMatchObject({ id: full.id, status: 'FAILED' });
    // With every provider covered the identity-only run would be SUCCESS: it still does not replace the failed full run.
    await prisma.syncRun.update({ where: { id: added.body.sync.runId }, data: { status: 'SUCCESS' } });

    const overview = await overviewNow();
    expect(overview.lastSync).toMatchObject({ id: full.id, status: 'FAILED' });
    expect(overview.syncRunning).toBe(false);
    const stats = (await request(w.server).get('/api/admin/analytics/sync').set('Cookie', w.admin).expect(200)).body;
    expect(stats.lastRun).toMatchObject({ id: full.id, status: 'FAILED' });
    expect(stats.lastSuccessfulRun).toMatchObject({ id: legacy.id });
    expect(stats.runs).toEqual({ total: 2, success: 1, partialSuccess: 0, failed: 1, running: 0 });
    // Task and record figures count the work of every discovery run, the identity-only one included.
    expect(stats.tasks.success).toBe(1);
    expect(stats.records.fetched).toBeGreaterThan(0);

    // The identity-only run stays in the synchronization history with its scope.
    const history = (await request(w.server).get('/api/admin/sync/runs').set('Cookie', w.admin)).body;
    expect(history.total).toBe(3);
    expect(history.runs.map((r: { id: string; scope: unknown }) => [r.id, r.scope === null])).toEqual([
      [added.body.sync.runId, false],
      [full.id, true],
      [legacy.id, true],
    ]);
  });
});

describe('queue race: a start that creates no run', () => {
  it('two simultaneous additions with no run active: each identity is synchronized exactly once, nothing stays queued', async () => {
    const sync = engine();
    const w = await world({ sync });
    const previews = [];
    for (const [source, id] of [['OPENALEX', PRIEM], ['ORCID', CARBERRY_ORCID]] as const) {
      const preview = await w.as(w.me.cookie).post('/preview', { source, externalId: id });
      expect(preview.status).toBe(200);
      previews.push(preview.body.previewToken as string);
    }
    expect(sync.drainPending).toBe(false);
    const saves = await Promise.all(previews.map((previewToken) => w.as(w.me.cookie).post('', { previewToken })));
    for (const res of saves) {
      expect(res.status).toBe(201);
      expect(['STARTED', 'QUEUED']).toContain(res.body.sync.status);
    }
    expect(saves.some((res) => res.body.sync.status === 'STARTED')).toBe(true);
    await sync.idle();

    const ids = saves.map((res) => res.body.identity.id as string);
    for (const id of ids) expect(await prisma.syncTask.count({ where: { identityId: id } })).toBe(1);
    const runs = await prisma.syncRun.count();
    expect(runs).toBeGreaterThanOrEqual(1);
    expect(runs).toBeLessThanOrEqual(2);
    expect(await sync.drainIdentityQueue()).toBeNull();
    expect(await prisma.syncRun.count()).toBe(runs);
  });

  it('simultaneous starts in one engine: one STARTED, one QUEUED, the queued one drained by exactly one follow-up run', async () => {
    const sync = engine();
    const w = await world({ sync });
    const a = await identityRow(w.me.prof.id, 'OPENALEX', PRIEM, w.me.user.id);
    const b = await identityRow(w.me.prof.id, 'ORCID', CARBERRY_ORCID, w.me.user.id);
    const results = await Promise.all([startIdentitySync(sync, a, w.me.user.id), startIdentitySync(sync, b, w.me.user.id)]);
    expect(results.map((r) => r.status)).toEqual(['STARTED', 'QUEUED']);
    await sync.idle();
    const runs = await prisma.syncRun.findMany({ orderBy: { startedAt: 'asc' }, include: { tasks: true } });
    expect(runs.map((run) => run.tasks.map((t) => t.identityId))).toEqual([[a.id], [b.id]]);
    expect(await scopeOf(runs[1].id)).toEqual({ kind: 'IDENTITIES', identityIds: [b.id], queued: true });
  });

  it('when the winning start fails to create its run, the identity answered QUEUED is still drained — once, without a retry loop', async () => {
    const sync = engine();
    const w = await world({ sync });
    const a = await identityRow(w.me.prof.id, 'OPENALEX', PRIEM, w.me.user.id);
    const b = await identityRow(w.me.prof.id, 'ORCID', CARBERRY_ORCID, w.me.user.id);
    const create = vi.spyOn(prisma.syncRun, 'create').mockRejectedValueOnce(new Error('database unavailable'));
    const results = await Promise.all([startIdentitySync(sync, a, w.me.user.id), startIdentitySync(sync, b, w.me.user.id)]);
    expect(results.map((r) => r.status)).toEqual(['NOT_STARTED', 'QUEUED']);
    expect(results[0]).toMatchObject({ reason: expect.stringContaining('next synchronization run includes it') });
    await sync.idle();
    // The drain after the failed start synchronized both never-attempted identities in one run.
    const runs = await prisma.syncRun.findMany({ include: { tasks: true } });
    expect(runs).toHaveLength(1);
    expect(runs[0].tasks.map((t) => t.identityId).sort()).toEqual([a.id, b.id].sort());
    expect(await scopeOf(runs[0].id)).toMatchObject({ queued: true });
    expect(create).toHaveBeenCalledTimes(2);
  });

  it('a persistent failure does not loop: one drain attempt after the refused start, then nothing until the next run', async () => {
    const sync = engine();
    const w = await world({ sync });
    const a = await identityRow(w.me.prof.id, 'OPENALEX', PRIEM, w.me.user.id);
    const b = await identityRow(w.me.prof.id, 'ORCID', CARBERRY_ORCID, w.me.user.id);
    const create = vi.spyOn(prisma.syncRun, 'create').mockRejectedValue(new Error('database unavailable'));
    const results = await Promise.all([startIdentitySync(sync, a, w.me.user.id), startIdentitySync(sync, b, w.me.user.id)]);
    expect(results.map((r) => r.status)).toEqual(['NOT_STARTED', 'QUEUED']);
    await sync.idle();
    expect(create).toHaveBeenCalledTimes(2);
    expect(sync.drainPending).toBe(false);
    create.mockRestore();
    expect(await prisma.syncRun.count()).toBe(0);
    // Nothing will drain them now: shown as included in the next synchronization run, not as queued.
    const statuses = (await w.as(w.me.cookie).get()).body.identities.map((i: { syncStatus: unknown }) => i.syncStatus);
    expect(statuses).toEqual([
      { state: 'NEVER', includedInNextRun: true },
      { state: 'NEVER', includedInNextRun: true },
    ]);
  });
});

describe('latest task on tied timestamps', () => {
  it('uses the run and task times, not the id, when run start times are equal', async () => {
    const w = await world();
    const identity = await identityRow(w.me.prof.id, 'OPENALEX', PRIEM, w.me.user.id);
    const at = (ms: number) => new Date(Date.UTC(2026, 10, 1) + ms);
    const HIGH = 'ffffffff-ffff-4fff-bfff-ffffffffffff';
    const LOW = '00000000-0000-4000-8000-000000000001';
    const status = async () => (await w.as(w.me.cookie).get()).body.identities[0].syncStatus;
    const runWithTask = (taskId: string, finishedAt: Date | null, status: 'SUCCESS' | 'FAILED' | 'PENDING', taskFinishedAt: Date | null = finishedAt) =>
      prisma.syncRun.create({
        data: {
          trigger: 'MANUAL',
          status: finishedAt ? 'SUCCESS' : 'RUNNING',
          startedAt: at(0),
          finishedAt,
          tasks: { create: [{ id: taskId, identityId: identity.id, source: 'OPENALEX', status, startedAt: at(0), finishedAt: taskFinishedAt, errorMessage: status === 'FAILED' ? 'Failed' : null }] },
        },
      });

    // Same run start; the later-finishing run is the latest, although its task id sorts lower.
    const older = await runWithTask(HIGH, at(1000), 'SUCCESS');
    const newer = await runWithTask(LOW, at(2000), 'FAILED');
    expect(await status()).toMatchObject({ state: 'FAILED', message: 'Failed' });
    // And the other way round: a later successful run is SYNCHRONIZED, never hidden by an older failure.
    await prisma.syncTask.update({ where: { id: HIGH }, data: { status: 'FAILED', errorMessage: 'Failed' } });
    await prisma.syncTask.update({ where: { id: LOW }, data: { status: 'SUCCESS', errorMessage: null } });
    expect(await status()).toMatchObject({ state: 'SYNCHRONIZED' });

    // Same run start and finish: the task's own finish decides.
    await prisma.syncRun.update({ where: { id: newer.id }, data: { finishedAt: at(1000) } });
    await prisma.syncTask.update({ where: { id: HIGH }, data: { finishedAt: at(500) } });
    await prisma.syncTask.update({ where: { id: LOW }, data: { finishedAt: at(900) } });
    expect(await status()).toMatchObject({ state: 'SYNCHRONIZED' });
    await prisma.syncTask.update({ where: { id: HIGH }, data: { finishedAt: at(950) } });
    expect(await status()).toMatchObject({ state: 'FAILED' });

    // An unfinished run with the same start is the newest of all.
    void older;
    await runWithTask('7fffffff-ffff-4fff-bfff-ffffffffffff', null, 'PENDING');
    expect(await status()).toMatchObject({ state: 'RUNNING' });
  });
});

describe('status reflects what will actually happen', () => {
  it('QUEUED only while a drain will follow; a reactivated never-synchronized identity is included in the next run, or drained after the current one', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const sync = engine({ [AUTHOR_URL]: async () => (await gate, toResponse(loadFixture('openalex', 'author-valid'))) });
    const w = await world({ sync });
    const own = await identityRow(w.me.prof.id, 'DBLP', VARDI_DBLP, w.me.user.id);
    const mine = () => w.as(w.me.cookie).get().then((res) => res.body.identities[0].syncStatus);

    // Never attempted, nothing running: not "queued".
    expect(await mine()).toEqual({ state: 'NEVER', includedInNextRun: true });
    // Deactivated: not included.
    await w.as(w.me.cookie).patch(`/${own.id}`, { isActive: false }).expect(200);
    expect(await mine()).toEqual({ state: 'NEVER', includedInNextRun: false });
    // Reactivated while nothing runs: included in the next run.
    const reactivated = await w.as(w.me.cookie).patch(`/${own.id}`, { isActive: true }).expect(200);
    expect(reactivated.body.identity.syncStatus).toEqual({ state: 'NEVER', includedInNextRun: true });

    // While a run executes, the drain after it will pick it up: QUEUED — and it does.
    await identityRow(w.other.prof.id, 'OPENALEX', PRIEM, null);
    await w.as(w.me.cookie).patch(`/${own.id}`, { isActive: false }).expect(200);
    await request(w.server).post('/api/admin/sync').set('Cookie', w.admin).expect(202);
    const during = await w.as(w.me.cookie).patch(`/${own.id}`, { isActive: true }).expect(200);
    expect(during.body.identity.syncStatus).toEqual({ state: 'QUEUED' });
    const adminView = (await request(w.server).get(`/api/admin/professors/${w.me.prof.id}`).set('Cookie', w.admin)).body.professor.identities[0];
    expect(adminView.syncStatus).toEqual({ state: 'QUEUED' });
    release();
    await sync.idle();
    const followUp = await prisma.syncRun.findFirstOrThrow({ where: { triggeredByUserId: null }, include: { tasks: true } });
    expect(followUp.tasks.map((t) => t.identityId)).toEqual([own.id]);
    expect((await mine()).state).not.toBe('QUEUED');
  });

  it('administrators and professors see the engine’s own provider availability and Clarivate gate', async () => {
    // Scopus and Web of Science credentials present in the engine (not in the environment); the gate stays closed.
    const sync = engine({}, { providers: allProvidersPresent() });
    const w = await world({ sync });
    await identityRow(w.me.prof.id, 'SCOPUS', '7004212771', w.me.user.id);
    await identityRow(w.me.prof.id, 'WOS', 'A-1234-2008', w.me.user.id);
    const expected = { SCOPUS: { state: 'NEVER', includedInNextRun: true }, WOS: { state: 'WAITING_FOR_PROVIDER' } };
    const bySource = (identities: { source: string; syncStatus: unknown }[]) => Object.fromEntries(identities.map((i) => [i.source, i.syncStatus]));
    const admin = (await request(w.server).get(`/api/admin/professors/${w.me.prof.id}`).set('Cookie', w.admin)).body.professor.identities;
    expect(bySource(admin)).toEqual(expected);
    expect(bySource((await w.as(w.me.cookie).get()).body.identities)).toEqual(expected);
    expect(sync.canSyncSource('SCOPUS')).toBe(true);
    expect(sync.canSyncSource('WOS')).toBe(false);
  });
});
