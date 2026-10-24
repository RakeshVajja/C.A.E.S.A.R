import { Prisma, PublicationSource, TypeFamily, VerificationStatus } from '@prisma/client';
import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../../src/app';
import { prisma } from '../../src/config/database';
import { OpenAlexClient } from '../../src/integrations/openalex/client';
import { DblpClient } from '../../src/integrations/dblp/client';
import { ORCID_API_BASE_URL, OrcidClient } from '../../src/integrations/orcid/client';
import { approvedPerProfessor, overview, publicationsByYear, sourceStatistics, syncStatistics } from '../../src/services/analytics/analytics';
import { SyncService } from '../../src/services/sync/syncService';
import { cookiePair, createUser, PASSWORD, testClock } from '../auth/helpers';
import { resetDatabase } from '../helpers/database';
import { loadFixture, noSleep, replayFetch, Route } from '../helpers/fixtures';
import { adminCookie, tableCounts } from '../professors/helpers';

/* Administrator analytics (Project_plan.md §16; Phase 13, decisions #86–#89). Real test database, no network. */

vi.setConfig({ testTimeout: 60_000 });

beforeEach(async () => {
  await resetDatabase();
});

afterAll(async () => {
  await resetDatabase();
  await prisma.$disconnect();
});

const ENDPOINTS = ['/overview', '/professors', '/years', '/sources', '/sync'].map((p) => `/api/admin/analytics${p}`);

let seq = 0;
async function publication(options: { year: number | null; type?: TypeFamily; sources?: PublicationSource[]; status?: 'ACTIVE' | 'SUPPRESSED' }) {
  const n = ++seq;
  const typeFamily = options.type ?? 'JOURNAL';
  return prisma.publication.create({
    data: {
      title: `Paper ${n}`,
      normalizedTitle: `paper ${n}`,
      year: options.year,
      typeFamily,
      doi: `10.1000/a${n}`,
      status: options.status ?? 'ACTIVE',
      sourceRecords: {
        create: (options.sources ?? ['DBLP']).map((source, i) => ({
          source,
          externalId: `${source}-${n}-${i}`,
          title: `Paper ${n}`,
          normalizedTitle: `paper ${n}`,
          year: options.year,
          typeFamily,
          matchMethod: i === 0 ? 'NEW_PUBLICATION' : 'DOI',
          rawMetadata: { marker: 'raw-metadata-never-returned' },
        })),
      },
    },
  });
}

async function link(professorId: string, publicationId: string, status: VerificationStatus) {
  await prisma.professorPublication.create({ data: { professorId, publicationId, status, origin: 'DISCOVERED' } });
}

/**
 * Professors A, B, D (active, D without publications) and C (inactive). Counted: p1 (A+B, three
 * sources), p2 (A, two OpenAlex records of one paper), p5 (B, OTHER, no year), p8 (only the
 * inactive C), p9 (A + inactive C).
 */
async function world() {
  const [a, b, c, d] = await Promise.all(
    [
      { name: 'Prof A' },
      { name: 'Prof B' },
      { name: 'Prof C', isActive: false },
      { name: 'Prof D' },
    ].map((data) => prisma.professor.create({ data })),
  );
  const p1 = await publication({ year: 2020, sources: ['OPENALEX', 'DBLP', 'ORCID'] });
  const p2 = await publication({ year: 2021, type: 'CONFERENCE', sources: ['OPENALEX', 'OPENALEX'] });
  const p3 = await publication({ year: 2021, type: 'PREPRINT', sources: ['OPENALEX'] });
  const p4 = await publication({ year: 2019, status: 'SUPPRESSED', sources: ['ORCID'] });
  const p5 = await publication({ year: null, type: 'OTHER', sources: ['MANUAL'] });
  const p6 = await publication({ year: 2020 });
  const p7 = await publication({ year: 2022 });
  const p8 = await publication({ year: 2018 });
  const p9 = await publication({ year: 2020 });

  await link(a.id, p1.id, 'APPROVED');
  await link(b.id, p1.id, 'APPROVED');
  await link(a.id, p2.id, 'APPROVED');
  await link(a.id, p3.id, 'APPROVED'); // preprint: not counted
  await link(b.id, p3.id, 'PENDING'); // preprint pending: still awaits a decision
  await link(a.id, p4.id, 'APPROVED'); // suppressed: not counted
  await link(b.id, p4.id, 'PENDING'); // suppressed: hidden, not pending
  await link(b.id, p5.id, 'APPROVED');
  await link(a.id, p6.id, 'PENDING');
  await link(a.id, p7.id, 'REJECTED');
  await link(c.id, p8.id, 'APPROVED'); // inactive professor only: still counted (#86)
  await link(c.id, p6.id, 'PENDING'); // inactive professor: still pending (#88)
  await link(c.id, p9.id, 'APPROVED');
  await link(a.id, p9.id, 'APPROVED');
  return { a, b, c, d, p1, p2, p5, p8, p9 };
}

describe('empty database', () => {
  it('every statistic is zero, empty or null', async () => {
    expect(await overview()).toEqual({
      professors: { total: 0, active: 0 },
      uniquePublications: 0,
      uniquePublicationsByType: ['JOURNAL', 'CONFERENCE', 'BOOK_CHAPTER', 'BOOK', 'OTHER'].map((typeFamily) => ({ typeFamily, publications: 0 })),
      pendingVerifications: 0,
      lastSync: null,
      syncRunning: false,
    });
    expect(await approvedPerProfessor()).toEqual({ professors: [] });
    expect(await publicationsByYear()).toEqual({ years: [], unknownYear: 0, total: 0 });
    const sources = await sourceStatistics();
    expect(sources.counted).toEqual({
      sources: ['OPENALEX', 'DBLP', 'ORCID', 'MANUAL'].map((source) => ({ source, sourceRecords: 0, publications: 0 })),
      sourceRecords: 0,
      uniquePublications: 0,
    });
    expect(sources.stored).toMatchObject({ sourceRecords: 0, publications: 0 });
    expect(await syncStatistics()).toEqual({
      runs: { total: 0, success: 0, partialSuccess: 0, failed: 0, running: 0 },
      tasks: { success: 0, failed: 0 },
      records: { fetched: 0, added: 0, updated: 0, linksCreated: 0, candidatesCreated: 0 },
      lastRun: null,
      lastSuccessfulRun: null,
    });
  });
});

describe('the default policy (APPROVED relationships to ACTIVE, non-preprint publications)', () => {
  it('overview: professors, unique publications by type, pending verifications', async () => {
    await world();
    const o = await overview();
    expect(o.professors).toEqual({ total: 4, active: 3 });
    // p1 (two approving professors, three source records) and p9 (two professors) count once each;
    // p8, approved only by the inactive professor C, counts too.
    expect(o.uniquePublications).toBe(5);
    expect(o.uniquePublicationsByType).toEqual([
      { typeFamily: 'JOURNAL', publications: 3 },
      { typeFamily: 'CONFERENCE', publications: 1 },
      { typeFamily: 'BOOK_CHAPTER', publications: 0 },
      { typeFamily: 'BOOK', publications: 0 },
      { typeFamily: 'OTHER', publications: 1 },
    ]);
    // p3 (preprint) by B, p6 by A and p6 by the inactive C; not the suppressed p4.
    expect(o.pendingVerifications).toBe(3);
  });

  it('per professor: relationship counts of every professor (with isActive), zero rows included, most first', async () => {
    const { a, b, c, d } = await world();
    const { professors } = await approvedPerProfessor();
    expect(professors.map((p) => [p.id, p.approvedPublications, p.isActive])).toEqual([
      [a.id, 3, true], // p1, p2, p9 — not the preprint p3, suppressed p4, pending p6 or rejected p7
      [b.id, 2, true], // p1, p5 (OTHER) — not the pending preprint
      [c.id, 2, false], // p8, p9
      [d.id, 0, true],
    ]);
    expect(professors[0]).toEqual({ id: a.id, name: 'Prof A', department: null, designation: null, isActive: true, approvedPublications: 3 });
    // Co-authored p1 and p9 are counted for each professor, so relationships exceed unique publications.
    expect(professors.reduce((n, p) => n + p.approvedPublications, 0)).toBe(7);
    expect((await overview()).uniquePublications).toBe(5);
  });

  it('per year: distinct publications, unknown year reported separately, totals consistent', async () => {
    await world();
    expect(await publicationsByYear()).toEqual({
      years: [
        { year: 2018, publications: 1 }, // p8 — approved only by an inactive professor
        { year: 2020, publications: 2 }, // p1, p9 — p6 is only pending
        { year: 2021, publications: 1 }, // p2 — p3 is a preprint
      ],
      unknownYear: 1, // p5
      total: 5,
    });
  });

  it('sources: records of counted publications against unique publications, and everything stored', async () => {
    await world();
    const s = await sourceStatistics();
    expect(s.counted).toEqual({
      sources: [
        { source: 'OPENALEX', sourceRecords: 3, publications: 2 }, // p1, and p2 twice from OpenAlex
        { source: 'DBLP', sourceRecords: 3, publications: 3 }, // p1, p8, p9
        { source: 'ORCID', sourceRecords: 1, publications: 1 }, // p1
        { source: 'MANUAL', sourceRecords: 1, publications: 1 }, // p5
      ],
      sourceRecords: 8,
      uniquePublications: 5,
    });
    expect(s.stored).toEqual({
      sources: [
        { source: 'OPENALEX', sourceRecords: 4 },
        { source: 'DBLP', sourceRecords: 5 },
        { source: 'ORCID', sourceRecords: 2 },
        { source: 'MANUAL', sourceRecords: 1 },
      ],
      sourceRecords: 12,
      publications: 9,
    });
  });

  it('changes follow the data: suppression and professor decisions; deactivation changes only the active-professor count', async () => {
    const { a, b, c, p1, p9 } = await world();
    await prisma.publication.update({ where: { id: p1.id }, data: { status: 'SUPPRESSED' } });
    expect((await overview()).uniquePublications).toBe(4);
    await prisma.professorPublication.update({ where: { professorId_publicationId: { professorId: a.id, publicationId: p9.id } }, data: { status: 'REJECTED' } });
    // p9 stays approved by the inactive professor C, so it still counts.
    expect((await publicationsByYear()).years).toEqual([
      { year: 2018, publications: 1 },
      { year: 2020, publications: 1 },
      { year: 2021, publications: 1 },
    ]);
    await prisma.professorPublication.update({ where: { professorId_publicationId: { professorId: c.id, publicationId: p9.id } }, data: { status: 'REJECTED' } });
    expect((await overview()).uniquePublications).toBe(3); // no APPROVED relationship left for p9

    // Regression (#86): deactivating a professor does not remove their approved publications from
    // the publication totals, nor (#88) their PENDING relationships from the backlog; only the
    // active-professor count changes.
    const before = { years: await publicationsByYear(), sources: await sourceStatistics(), perProfessor: await approvedPerProfessor() };
    expect((await overview()).pendingVerifications).toBe(3); // p3 by B, p6 by A and by C
    await prisma.professor.update({ where: { id: b.id }, data: { isActive: false } });
    const o = await overview();
    expect(o).toMatchObject({ professors: { total: 4, active: 2 }, uniquePublications: 3, pendingVerifications: 3 });
    expect(await publicationsByYear()).toEqual(before.years);
    expect(await sourceStatistics()).toEqual(before.sources);
    const after = await approvedPerProfessor();
    expect(after.professors.map((p) => [p.name, p.approvedPublications])).toEqual(before.perProfessor.professors.map((p) => [p.name, p.approvedPublications]));
    expect(after.professors.find((p) => p.id === b.id)).toMatchObject({ isActive: false, approvedPublications: 1 }); // p5
  });
});

describe('inactive professors (#86: the frozen §16 rule has no professor-activity condition)', () => {
  it('a publication approved only by an inactive professor counts in every publication figure, once', async () => {
    const active = await prisma.professor.create({ data: { name: 'Active' } });
    const inactive = await prisma.professor.create({ data: { name: 'Inactive', isActive: false } });
    const only = await publication({ year: 2015, sources: ['ORCID', 'DBLP'] });
    const shared = await publication({ year: 2016 });
    await link(inactive.id, only.id, 'APPROVED');
    await link(inactive.id, shared.id, 'APPROVED');
    await link(active.id, shared.id, 'APPROVED');

    expect(await overview()).toMatchObject({ professors: { total: 2, active: 1 }, uniquePublications: 2, pendingVerifications: 0 });
    expect(await publicationsByYear()).toEqual({ years: [{ year: 2015, publications: 1 }, { year: 2016, publications: 1 }], unknownYear: 0, total: 2 });
    expect((await sourceStatistics()).counted).toMatchObject({ sourceRecords: 3, uniquePublications: 2 });
    expect((await approvedPerProfessor()).professors.map((p) => [p.name, p.isActive, p.approvedPublications])).toEqual([
      ['Inactive', false, 2],
      ['Active', true, 1],
    ]);
  });

  it('regression (#88): an inactive professor\'s PENDING relationship stays in the verification backlog', async () => {
    const inactive = await prisma.professor.create({ data: { name: 'Inactive', isActive: false } });
    const active = await prisma.professor.create({ data: { name: 'Active' } });
    const journal = await publication({ year: 2017 });
    const preprint = await publication({ year: 2017, type: 'PREPRINT' });
    const suppressed = await publication({ year: 2017, status: 'SUPPRESSED' });
    await link(inactive.id, journal.id, 'PENDING');
    await link(inactive.id, preprint.id, 'PENDING'); // preprints are not excluded from the backlog
    await link(inactive.id, suppressed.id, 'PENDING'); // suppressed: hidden, not counted
    expect((await overview()).pendingVerifications).toBe(2);

    // Deactivating a professor with pending items leaves the backlog unchanged.
    await link(active.id, journal.id, 'PENDING');
    expect((await overview()).pendingVerifications).toBe(3);
    await prisma.professor.update({ where: { id: active.id }, data: { isActive: false } });
    expect(await overview()).toMatchObject({ professors: { total: 2, active: 0 }, pendingVerifications: 3, uniquePublications: 0 });
  });
});

describe('synchronization statistics', () => {
  async function run(status: 'SUCCESS' | 'PARTIAL_SUCCESS' | 'FAILED' | 'RUNNING', startedAt: string, counters: Partial<Prisma.SyncRunCreateInput>, tasks: ('SUCCESS' | 'FAILED' | 'PENDING' | 'RUNNING')[]) {
    return prisma.syncRun.create({
      data: {
        trigger: 'SCHEDULED',
        status,
        startedAt: new Date(startedAt),
        finishedAt: status === 'RUNNING' ? null : new Date(startedAt),
        tasksTotal: tasks.length,
        ...counters,
        tasks: { create: tasks.map((s) => ({ source: 'ORCID' as const, status: s })) },
      },
    });
  }

  it('counts runs by outcome and sums finished runs only; partial and failed runs keep their completed tasks', async () => {
    const ok = await run('SUCCESS', '2026-08-01T02:00:00Z', { recordsFetched: 100, recordsNew: 60, recordsUpdated: 40, linksCreated: 50, candidatesCreated: 2 }, ['SUCCESS', 'SUCCESS']);
    const partial = await run('PARTIAL_SUCCESS', '2026-09-01T02:00:00Z', { recordsFetched: 80, recordsNew: 5, recordsUpdated: 75, linksCreated: 3 }, ['SUCCESS', 'FAILED']);
    const failed = await run('FAILED', '2026-10-01T02:00:00Z', {}, ['FAILED', 'FAILED']);
    await run('RUNNING', '2026-11-01T02:00:00Z', { recordsFetched: 999 }, ['SUCCESS', 'RUNNING', 'PENDING']);

    const s = await syncStatistics();
    expect(s.runs).toEqual({ total: 4, success: 1, partialSuccess: 1, failed: 1, running: 1 });
    expect(s.tasks).toEqual({ success: 3, failed: 3 });
    expect(s.records).toEqual({ fetched: 180, added: 65, updated: 115, linksCreated: 53, candidatesCreated: 2 });
    expect(s.lastRun).toMatchObject({ id: failed.id, status: 'FAILED' });
    expect(s.lastSuccessfulRun).toMatchObject({ id: ok.id, status: 'SUCCESS' });
    expect(partial.status).toBe('PARTIAL_SUCCESS');

    const o = await overview();
    expect(o.lastSync).toEqual({ id: failed.id, trigger: 'SCHEDULED', status: 'FAILED', startedAt: new Date('2026-10-01T02:00:00Z'), finishedAt: new Date('2026-10-01T02:00:00Z') });
    expect(o.syncRunning).toBe(true);
  });
});

describe('consistency with a real synchronized database (recorded fixtures)', () => {
  const PRIEM = 'A5023888391';
  const VARDI_ORCID = '0000-0002-0661-5773';

  function syncService(overrides: Record<string, Route> = {}, start = '2026-11-01T02:00:00.000Z') {
    const recorded = [
      loadFixture('openalex', 'author-valid'),
      ...['works-page-1', 'works-page-2', 'works-page-3'].map((n) => loadFixture('openalex', n)),
      ...['identity-person', 'records-person', 'authors-person'].map((n) => loadFixture('dblp', n)),
      loadFixture('orcid', 'works-vardi'),
    ];
    const deps = { fetchImpl: replayFetch(recorded, overrides).fetchImpl, sleep: noSleep };
    const clients = {
      openAlex: new OpenAlexClient({ perPage: 25, deps, http: { maxRetries: 0 } }),
      dblp: new DblpClient({ deps, http: { maxRetries: 0 } }),
      orcid: new OrcidClient({ deps, http: { maxRetries: 0 } }),
    };
    return new SyncService({ clients, now: testClock(start).now });
  }

  it('analytics equal totals computed independently from the stored rows', async () => {
    const a = await prisma.professor.create({ data: { name: 'Prof A' } });
    const b = await prisma.professor.create({ data: { name: 'Prof B' } });
    await prisma.externalIdentity.create({ data: { professorId: a.id, source: 'OPENALEX', externalId: PRIEM } });
    await prisma.externalIdentity.create({ data: { professorId: a.id, source: 'ORCID', externalId: VARDI_ORCID } });
    await prisma.externalIdentity.create({ data: { professorId: a.id, source: 'DBLP', externalId: 'v/MosheYVardi' } }); // overlaps ORCID
    await prisma.externalIdentity.create({ data: { professorId: b.id, source: 'ORCID', externalId: VARDI_ORCID.replace(/3$/, '0') } }); // unrecorded → fails

    const sync = syncService();
    await sync.start('MANUAL');
    await sync.idle();
    // Second run: ORCID answers HTML with 200 → PARTIAL_SUCCESS, nothing changed.
    const html200: Route = () => new Response('<!DOCTYPE html><html></html>', { status: 200, headers: { 'content-type': 'text/html' } });
    const rerun = syncService({ [`${ORCID_API_BASE_URL}/${VARDI_ORCID}/works`]: html200 }, '2026-12-01T02:00:00.000Z');
    await rerun.start('SCHEDULED');
    await rerun.idle();

    // Professor A approves every second pending link (by id order) and every publication reported
    // by several source records, and rejects one.
    const pending = await prisma.professorPublication.findMany({
      where: { professorId: a.id },
      include: { publication: { select: { _count: { select: { sourceRecords: true } } } } },
      orderBy: { id: 'asc' },
    });
    expect(pending.length).toBeGreaterThan(20);
    for (const [i, l] of pending.entries()) {
      const merged = l.publication._count.sourceRecords > 1;
      const status = i % 2 === 0 || merged ? 'APPROVED' : i === 1 ? 'REJECTED' : 'PENDING';
      await prisma.professorPublication.update({ where: { id: l.id }, data: { status } });
    }

    const before = await tableCounts();
    const [o, per, years, sources, s] = [await overview(), await approvedPerProfessor(), await publicationsByYear(), await sourceStatistics(), await syncStatistics()];
    expect(await tableCounts()).toEqual(before); // read-only

    // Independent computation in JavaScript from the full rows.
    const pubs = await prisma.publication.findMany({ include: { professors: { include: { professor: true } }, sourceRecords: true } });
    const counted = pubs.filter((p) => p.status === 'ACTIVE' && p.typeFamily !== 'PREPRINT' && p.professors.some((l) => l.status === 'APPROVED'));
    expect(counted.length).toBeGreaterThan(5);
    // The recorded data contains approved preprints and publications reported by several records.
    expect(pubs.some((p) => p.typeFamily === 'PREPRINT' && p.professors.some((l) => l.status === 'APPROVED'))).toBe(true);
    expect(counted.some((p) => p.sourceRecords.length > 1)).toBe(true);
    expect(o.uniquePublications).toBe(counted.length);
    expect(years.total).toBe(counted.length);
    expect(years.unknownYear).toBe(counted.filter((p) => p.year === null).length);
    for (const y of years.years) expect(y.publications, String(y.year)).toBe(counted.filter((p) => p.year === y.year).length);
    expect(o.uniquePublicationsByType.reduce((n, t) => n + t.publications, 0)).toBe(counted.length);
    expect(per.professors.find((p) => p.id === a.id)!.approvedPublications).toBe(counted.length);
    expect(per.professors.find((p) => p.id === b.id)!.approvedPublications).toBe(0);
    expect(o.pendingVerifications).toBe(
      pubs.filter((p) => p.status === 'ACTIVE').reduce((n, p) => n + p.professors.filter((l) => l.status === 'PENDING').length, 0),
    );
    expect(sources.counted.sourceRecords).toBe(counted.reduce((n, p) => n + p.sourceRecords.length, 0));
    expect(sources.counted.sourceRecords).toBeGreaterThan(sources.counted.uniquePublications); // merged records
    for (const row of sources.counted.sources) {
      expect(row.publications, row.source).toBe(counted.filter((p) => p.sourceRecords.some((r) => r.source === row.source)).length);
    }
    expect(sources.stored.sourceRecords).toBe(await prisma.publicationSourceRecord.count());
    expect(sources.stored.publications).toBe(pubs.length);

    const runs = await prisma.syncRun.findMany({ orderBy: { startedAt: 'asc' } });
    expect(runs.map((r) => r.status)).toEqual(['PARTIAL_SUCCESS', 'PARTIAL_SUCCESS']);
    expect(s.runs).toEqual({ total: 2, success: 0, partialSuccess: 2, failed: 0, running: 0 });
    expect(s.tasks).toEqual({ success: 5, failed: 3 });
    expect(s.records).toEqual({
      fetched: runs[0].recordsFetched + runs[1].recordsFetched,
      added: runs[0].recordsNew + runs[1].recordsNew,
      updated: runs[0].recordsUpdated + runs[1].recordsUpdated,
      linksCreated: runs[0].linksCreated + runs[1].linksCreated,
      candidatesCreated: runs[0].candidatesCreated + runs[1].candidatesCreated,
    });
    expect(s.records.added).toBe(runs[0].recordsNew); // the rerun added nothing
    expect(s.lastRun?.id).toBe(runs[1].id);
    expect(s.lastSuccessfulRun).toBeNull();
  });
});

describe('admin routes', () => {
  it('require an administrator session; professors, anonymous and temporary-password admins are refused', async () => {
    const server = createApp({ mailer: null });
    await createUser({ email: 'prof@example.org', professor: 'active' });
    await createUser({ email: 'temp-admin@example.org', role: 'ADMIN', mustChangePassword: true });
    const prof = cookiePair(await request(server).post('/api/auth/login').send({ email: 'prof@example.org', password: PASSWORD }), 'cse_session');
    const temp = cookiePair(await request(server).post('/api/auth/login').send({ email: 'temp-admin@example.org', password: PASSWORD }), 'cse_session');
    for (const path of ENDPOINTS) {
      expect((await request(server).get(path)).status, path).toBe(401);
      expect((await request(server).get(path).set('Cookie', prof)).body.error.code, path).toBe('FORBIDDEN');
      expect((await request(server).get(path).set('Cookie', temp)).body.error.code, path).toBe('PASSWORD_CHANGE_REQUIRED');
    }
  });

  it('return the statistics to the administrator, reject query parameters and other methods, and expose no private data', async () => {
    const server = createApp({ mailer: null });
    const admin = await adminCookie(server);
    await world();
    await prisma.syncRun.create({ data: { trigger: 'MANUAL', status: 'SUCCESS', finishedAt: new Date(), tasks: { create: [{ source: 'ORCID', status: 'FAILED', errorMessage: 'ORCID internal detail' }] } } });

    const bodies: string[] = [];
    for (const path of ENDPOINTS) {
      const res = await request(server).get(path).set('Cookie', admin);
      expect(res.status, path).toBe(200);
      expect(res.headers['content-type']).toMatch(/application\/json/);
      bodies.push(JSON.stringify(res.body));

      const bad = await request(server).get(`${path}?professorId=x`).set('Cookie', admin);
      expect(bad.status, path).toBe(400);
      expect(bad.body.error).toMatchObject({ code: 'VALIDATION_ERROR' });
      expect(JSON.stringify(bad.body)).not.toContain('"x"');
      expect((await request(server).post(path).set('Cookie', admin).send({})).status, path).toBe(404);
    }
    const res = await request(server).get('/api/admin/analytics/overview').set('Cookie', admin);
    expect(res.body.overview).toMatchObject({ professors: { total: 4, active: 3 }, uniquePublications: 5, pendingVerifications: 3, syncRunning: false });
    expect(res.body.overview.lastSync).toMatchObject({ trigger: 'MANUAL', status: 'SUCCESS' });
    for (const body of bodies) {
      for (const secret of ['raw-metadata-never-returned', 'admin@example.org', 'passwordHash', 'ORCID internal detail', 'triggeredByUserId']) {
        expect(body).not.toContain(secret);
      }
    }
  });
});
