import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { PublicationSource } from '@prisma/client';
import { createApp } from '../../src/app';
import { prisma } from '../../src/config/database';
import { scopusCitations, scopusLinks } from '../../src/services/citations/scopusCitations';
import { ingestPublication } from '../../src/services/matching/engine';
import { buildNormalizedPublication } from '../../src/services/normalization/normalizedPublication';
import { providerConfiguration } from '../../src/services/providers/providerStatus';
import { SyncService } from '../../src/services/sync/syncService';
import { cookiePair, createUser, PASSWORD } from '../auth/helpers';
import { resetDatabase } from '../helpers/database';
import { adminCookie, replayIdentityClients } from '../professors/helpers';

/*
 * Citation display and analytics (stage 15.7; decisions #112, #114): Scopus counts are shown with
 * attribution links; Web of Science Times Cited and JCR metrics never leave the database.
 * Synthetic records only.
 */

const T1 = new Date('2026-11-01T02:00:00.000Z');
const T2 = new Date('2026-12-01T02:00:00.000Z');
const RECORD = 'https://www.scopus.com/inward/record.uri?partnerID=SYNTH&scp=85000000001&origin=inward';
const CITED_BY = 'https://www.scopus.com/inward/citedby.uri?partnerID=SYNTH&scp=85000000001&origin=inward';
/** Distinctive Web of Science counts that must never appear in any response. */
const WOS_COUNT = 777_001;

beforeEach(async () => {
  await resetDatabase();
});

afterAll(async () => {
  await resetDatabase();
  await prisma.$disconnect();
});

async function record(source: PublicationSource, externalId: string, title: string, options: { doi?: string; typeFamily?: 'JOURNAL' | 'PREPRINT'; rawMetadata?: unknown } = {}) {
  return ingestPublication(
    buildNormalizedPublication({
      source,
      externalId,
      title,
      dois: options.doi ? [options.doi] : [],
      year: 2021,
      typeFamily: options.typeFamily ?? 'JOURNAL',
      rawMetadata: options.rawMetadata ?? { synthetic: true },
    }),
  );
}

async function observe(sourceRecordId: string, provider: 'SCOPUS' | 'WOS', count: number, observedAt: Date) {
  await prisma.citationObservation.create({ data: { sourceRecordId, provider, count, observedAt, ...(provider === 'WOS' ? { database: 'WOS' } : {}) } });
}

const scopusRaw = { link: [{ '@ref': 'self', '@href': 'https://api.elsevier.com/content/abstract/scopus_id/85000000001' }, { '@ref': 'scopus', '@href': RECORD }, { '@ref': 'scopus-citedby', '@href': CITED_BY }] };

/** A paper with a Scopus record (two observations) and a WoS record (one); a second paper with WoS only. */
async function world() {
  const scopus = await record('SCOPUS', '2-s2.0-85000000001', 'Synthetic cited paper', { doi: '10.5555/cite.1', rawMetadata: scopusRaw });
  const wos = await record('WOS', 'WOS:000000000000001', 'Synthetic cited paper', { doi: '10.5555/cite.1' });
  expect(wos.publicationId).toBe(scopus.publicationId);
  await observe(scopus.sourceRecordId, 'SCOPUS', 5, T1);
  await observe(scopus.sourceRecordId, 'SCOPUS', 9, T2);
  await observe(wos.sourceRecordId, 'WOS', WOS_COUNT, T2);
  const wosOnly = await record('WOS', 'WOS:000000000000002', 'Synthetic paper counted by WoS only');
  await observe(wosOnly.sourceRecordId, 'WOS', WOS_COUNT + 1, T2);
  return { paper: scopus.publicationId, wosOnly: wosOnly.publicationId };
}

describe('scopusCitations', () => {
  it('the latest Scopus observation with the record and cited-by links Scopus returned; never a WoS count', async () => {
    const { paper, wosOnly } = await world();
    const citations = await scopusCitations([paper, wosOnly]);
    expect(citations.get(paper)).toEqual({ count: 9, observedAt: T2, recordUrl: RECORD, citedByUrl: CITED_BY });
    expect(citations.has(wosOnly)).toBe(false);
  });

  it('several Scopus records of one publication: the highest latest count, never a sum', async () => {
    const a = await record('SCOPUS', '2-s2.0-1', 'Synthetic duplicated Scopus paper', { doi: '10.5555/dup' });
    const b = await record('SCOPUS', '2-s2.0-2', 'Synthetic duplicated Scopus paper', { doi: '10.5555/dup' });
    await observe(a.sourceRecordId, 'SCOPUS', 4, T1);
    await observe(b.sourceRecordId, 'SCOPUS', 6, T1);
    await observe(a.sourceRecordId, 'SCOPUS', 3, T2); // a's latest is 3
    expect((await scopusCitations([a.publicationId])).get(a.publicationId)).toMatchObject({ count: 6 });
  });

  it('only https links on scopus.com are passed on', () => {
    const links = (record: string, citedBy: string) => scopusLinks({ link: [{ '@ref': 'scopus', '@href': record }, { '@ref': 'scopus-citedby', '@href': citedBy }] });
    expect(links('http://www.scopus.com/x', 'https://evil.example/x')).toEqual({ record: null, citedBy: null });
    expect(links('https://www.scopus.com.evil.example/x', 'javascript:alert(1)')).toEqual({ record: null, citedBy: null });
    expect(links('https://scopus.com/inward/record.uri?x=1', 'https://user:pw@www.scopus.com/x')).toEqual({ record: 'https://scopus.com/inward/record.uri?x=1', citedBy: null });
    expect(scopusLinks(null)).toEqual({ record: null, citedBy: null });
    expect(scopusLinks({ link: 'not an array' })).toEqual({ record: null, citedBy: null });
  });
});

describe('publication APIs', () => {
  it('the administrator’s publication detail carries the Scopus citation only', async () => {
    const { paper, wosOnly } = await world();
    const server = createApp({ mailer: null });
    const cookie = await adminCookie(server);
    const detail = await request(server).get(`/api/admin/publications/${paper}`).set('Cookie', cookie);
    expect(detail.body.publication.scopusCitation).toEqual({ count: 9, observedAt: T2.toISOString(), recordUrl: RECORD, citedByUrl: CITED_BY });
    expect(detail.body.publication.sources).toEqual(['SCOPUS', 'WOS']);
    expect(JSON.stringify(detail.body)).not.toContain(String(WOS_COUNT));
    const other = await request(server).get(`/api/admin/publications/${wosOnly}`).set('Cookie', cookie);
    expect(other.body.publication.scopusCitation).toBeNull();
    expect(JSON.stringify(other.body)).not.toContain(String(WOS_COUNT + 1));
  });

  it('a professor sees every source (Scopus and WoS included) and the Scopus count of their own publications', async () => {
    const { paper, wosOnly } = await world();
    const server = createApp({ mailer: null });
    const user = await createUser({ email: 'prof.cite@example.test', professor: 'active' });
    const professor = await prisma.professor.findUniqueOrThrow({ where: { userId: user.id } });
    await prisma.professorPublication.createMany({
      data: [
        { professorId: professor.id, publicationId: paper, status: 'APPROVED', origin: 'DISCOVERED' },
        { professorId: professor.id, publicationId: wosOnly, status: 'PENDING', origin: 'DISCOVERED' },
      ],
    });
    const cookie = cookiePair(await request(server).post('/api/auth/login').send({ email: 'prof.cite@example.test', password: PASSWORD }), 'cse_session');
    const list = await request(server).get('/api/me/publications').set('Cookie', cookie);
    const byId = Object.fromEntries(list.body.items.map((i: { publication: { id: string } }) => [i.publication.id, i.publication]));
    expect(byId[paper]).toMatchObject({ sources: ['SCOPUS', 'WOS'], scopusCitation: { count: 9, recordUrl: RECORD, citedByUrl: CITED_BY } });
    expect(byId[wosOnly]).toMatchObject({ sources: ['WOS'], scopusCitation: null });
    expect(JSON.stringify(list.body)).not.toMatch(new RegExp(`${WOS_COUNT}|${WOS_COUNT + 1}`));
  });
});

describe('citation analytics (internal, administrator only)', () => {
  it('Scopus aggregates over counted publications, once per publication; Web of Science never included', async () => {
    const { paper, wosOnly } = await world();
    // Not counted: a preprint with a Scopus count, and an unapproved paper with one.
    const preprint = await record('SCOPUS', '2-s2.0-3', 'Synthetic preprint with citations', { typeFamily: 'PREPRINT' });
    await observe(preprint.sourceRecordId, 'SCOPUS', 100, T2);
    const pending = await record('SCOPUS', '2-s2.0-4', 'Synthetic pending paper with citations');
    await observe(pending.sourceRecordId, 'SCOPUS', 50, T2);

    const a = await prisma.professor.create({ data: { name: 'Prof A' } });
    const b = await prisma.professor.create({ data: { name: 'Prof B' } });
    await prisma.professorPublication.createMany({
      data: [
        { professorId: a.id, publicationId: paper, status: 'APPROVED', origin: 'DISCOVERED' },
        { professorId: b.id, publicationId: paper, status: 'APPROVED', origin: 'DISCOVERED' }, // co-authored
        { professorId: a.id, publicationId: wosOnly, status: 'APPROVED', origin: 'DISCOVERED' },
        { professorId: a.id, publicationId: preprint.publicationId, status: 'APPROVED', origin: 'DISCOVERED' },
        { professorId: b.id, publicationId: pending.publicationId, status: 'PENDING', origin: 'DISCOVERED' },
      ],
    });

    const server = createApp({ mailer: null });
    const res = await request(server).get('/api/admin/analytics/citations').set('Cookie', await adminCookie(server));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      scopus: {
        countedPublications: 2, // the cited paper and the WoS-only paper
        publicationsWithCount: 1,
        totalCitations: 9, // the co-authored paper once
        latestObservation: T2.toISOString(),
        professors: [
          { id: a.id, name: 'Prof A', isActive: true, publicationsWithCount: 1, citations: 9 },
          { id: b.id, name: 'Prof B', isActive: true, publicationsWithCount: 1, citations: 9 },
        ],
      },
    });
    expect(JSON.stringify(res.body)).not.toMatch(/wos|jcr|777001/i);

    const user = await createUser({ email: 'prof.nope@example.test', professor: 'active' });
    const professorCookie = cookiePair(await request(server).post('/api/auth/login').send({ email: user.email, password: PASSWORD }), 'cse_session');
    expect((await request(server).get('/api/admin/analytics/citations').set('Cookie', professorCookie)).status).toBe(403);
  });
});

describe('provider configuration status', () => {
  it('reports each provider’s credential state for discovery and JCR — never a credential value', async () => {
    const providers = providerConfiguration({
      scopus: null,
      wosStarter: { apiKey: 'synthetic-secret-value-0000' },
      wosJournals: null,
      issues: [{ provider: 'SCOPUS', message: 'SCOPUS_INST_TOKEN is set but SCOPUS_API_KEY is not' }],
    });
    const sync = new SyncService({ clients: replayIdentityClients().clients, now: () => T1, providers });
    const server = createApp({ mailer: null, sync });
    const res = await request(server).get('/api/admin/sync/providers').set('Cookie', await adminCookie(server));
    expect(res.body.providers).toEqual([
      { provider: 'OPENALEX', label: 'OpenAlex', purpose: 'PUBLICATION_DISCOVERY', credentials: 'NOT_REQUIRED', issue: null },
      { provider: 'DBLP', label: 'DBLP', purpose: 'PUBLICATION_DISCOVERY', credentials: 'NOT_REQUIRED', issue: null },
      { provider: 'ORCID', label: 'ORCID', purpose: 'PUBLICATION_DISCOVERY', credentials: 'NOT_REQUIRED', issue: null },
      { provider: 'SCOPUS', label: 'Scopus', purpose: 'PUBLICATION_DISCOVERY', credentials: 'INCOMPLETE', issue: 'SCOPUS_INST_TOKEN is set but SCOPUS_API_KEY is not' },
      { provider: 'WOS', label: 'Web of Science', purpose: 'PUBLICATION_DISCOVERY', credentials: 'PRESENT', issue: null },
      { provider: 'JCR', label: 'Journal Citation Reports', purpose: 'JOURNAL_METRICS', credentials: 'NOT_CONFIGURED', issue: null },
    ]);
    expect(JSON.stringify(res.body)).not.toContain('synthetic-secret-value-0000');
    expect((await request(server).get('/api/admin/sync/providers')).status).toBe(401);
  });
});
