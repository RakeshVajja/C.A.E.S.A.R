import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app';
import { prisma } from '../../src/config/database';
import { ingestPublication } from '../../src/services/matching/engine';
import { buildNormalizedPublication, PublicationInput } from '../../src/services/normalization/normalizedPublication';
import { readCuration } from '../../src/services/publications/curation';
import { cookiePair, createUser, PASSWORD, testClock } from '../auth/helpers';
import { INDEPENDENT_ENTRY } from '../helpers/basis';
import { resetDatabase } from '../helpers/database';
import { adminCookie } from '../professors/helpers';

/* Field-level curation with a declared basis, and the basis of manual entries (stage 15.8; §6.4, §9, §12.1; decision #125). */

const NOW = '2026-11-02T09:00:00.000Z';

beforeEach(async () => {
  await resetDatabase();
});

afterAll(async () => {
  await resetDatabase();
  await prisma.$disconnect();
});

const ingest = (input: Omit<PublicationInput, 'typeFamily'> & { typeFamily?: PublicationInput['typeFamily'] }) =>
  ingestPublication(buildNormalizedPublication({ typeFamily: 'JOURNAL', ...input }), { seenAt: new Date(NOW) });

async function setup() {
  const server = createApp({ mailer: null, now: testClock(NOW).now });
  const admin = await adminCookie(server);
  const patch = (id: string, body: object) => request(server).patch(`/api/admin/publications/${id}`).set('Cookie', admin).send(body);
  return { server, admin, patch };
}

/** A publication from DBLP (venue, year) and OpenAlex (title, authors). */
async function twoSourcePublication() {
  const dblp = await ingest({ source: 'DBLP', externalId: 'journals/x/A1', title: 'Field level curation', year: 2020, venue: 'DBLP Venue', dois: ['10.5555/curation'] });
  await ingest({ source: 'OPENALEX', externalId: 'W1', title: 'Field Level Curation', year: 2021, authorNamesDisplay: 'A. Author', dois: ['10.5555/curation'] });
  return dblp.publicationId;
}

describe('administrator edits record a basis per changed field', () => {
  it('records only the fields whose value changes, with basis and evidence; synchronization recomputes the others', async () => {
    const { patch } = await setup();
    const id = await twoSourcePublication();
    expect(await prisma.publication.findUniqueOrThrow({ where: { id } })).toMatchObject({ title: 'Field Level Curation', year: 2021, venue: 'DBLP Venue' });

    // year is unchanged (2021) and so not recorded; venue changes with an independent basis.
    const res = await patch(id, { year: 2021, venue: 'Journal of Curation', basis: 'INDEPENDENT', evidence: ' https://publisher.example.org/article/1 ' });
    expect(res.status).toBe(200);
    expect(res.body.publication).toMatchObject({
      venue: 'Journal of Curation',
      isCurated: true,
      curation: { venue: { basis: 'INDEPENDENT', evidence: 'https://publisher.example.org/article/1' } },
    });
    expect(Object.keys(res.body.publication.curation)).toEqual(['venue']);

    // A provider-derived edit keeps its provider; evidence is optional for it.
    expect((await patch(id, { authorNames: 'A. Author; B. Author', basis: 'SCOPUS' })).body.publication.curation.author_names_display).toEqual({ basis: 'SCOPUS', evidence: null });

    // A later source change recomputes only the uncurated fields.
    await ingest({ source: 'OPENALEX', externalId: 'W1', title: 'Field Level Curation, Revised', year: 2022, venue: 'OpenAlex Venue', authorNamesDisplay: 'Z. Other', dois: ['10.5555/curation'] });
    expect(await prisma.publication.findUniqueOrThrow({ where: { id } })).toMatchObject({
      title: 'Field Level Curation, Revised',
      normalizedTitle: 'field level curation revised',
      year: 2022,
      venue: 'Journal of Curation',
      authorNamesDisplay: 'A. Author; B. Author',
    });
  });

  it('replaces the entry of a re-edited field; an edit that changes nothing writes nothing', async () => {
    const { patch } = await setup();
    const id = await twoSourcePublication();
    await patch(id, { venue: 'V1', basis: 'WOS' }).expect(200);
    await patch(id, { venue: 'V2', ...INDEPENDENT_ENTRY }).expect(200);
    const before = await prisma.publication.findUniqueOrThrow({ where: { id } });
    expect(before.curation).toEqual({ venue: { basis: 'INDEPENDENT', evidence: INDEPENDENT_ENTRY.evidence } });

    const same = await patch(id, { venue: 'V2', year: 2021, basis: 'SCOPUS' });
    expect(same.status).toBe(200);
    expect(await prisma.publication.findUniqueOrThrow({ where: { id } })).toEqual(before);
  });

  it('requires a declared basis, and evidence for an independent value', async () => {
    const { patch } = await setup();
    const id = await twoSourcePublication();
    const before = await prisma.publication.findUniqueOrThrow({ where: { id } });
    expect((await patch(id, { venue: 'X' })).body.error.code).toBe('VALIDATION_ERROR');
    expect((await patch(id, { venue: 'X', basis: 'PRE_PHASE15' })).body.error.code).toBe('VALIDATION_ERROR'); // set by the migration only
    expect((await patch(id, { venue: 'X', basis: 'MANUAL' })).body.error.code).toBe('VALIDATION_ERROR');
    expect((await patch(id, { venue: 'X', basis: 'INDEPENDENT' })).body.error.code).toBe('EVIDENCE_REQUIRED');
    expect((await patch(id, { venue: 'X', basis: 'INDEPENDENT', evidence: '   ' })).body.error.code).toBe('EVIDENCE_REQUIRED');
    expect((await patch(id, { basis: 'INDEPENDENT', evidence: 'note' })).body.error.code).toBe('VALIDATION_ERROR'); // no field
    expect(await prisma.publication.findUniqueOrThrow({ where: { id } })).toEqual(before);
  });

  it('a publication curated as a whole record keeps every field; editing it records the rest as PRE_PHASE15', async () => {
    const { patch } = await setup();
    const id = await twoSourcePublication();
    // Curated after the Phase 15 migration but before basis capture: is_curated without entries.
    await prisma.publication.update({ where: { id }, data: { isCurated: true, title: 'Legacy curated title', normalizedTitle: 'legacy curated title' } });
    await ingest({ source: 'DBLP', externalId: 'journals/x/A1', title: 'Field level curation', year: 2019, venue: 'Changed Venue', dois: ['10.5555/curation'] });
    expect(await prisma.publication.findUniqueOrThrow({ where: { id } })).toMatchObject({ title: 'Legacy curated title', year: 2021, venue: 'DBLP Venue' });

    const res = await patch(id, { year: 2020, basis: 'DBLP' });
    expect(res.body.publication.curation).toEqual({
      title: { basis: 'PRE_PHASE15', evidence: null },
      year: { basis: 'DBLP', evidence: null },
      venue: { basis: 'PRE_PHASE15', evidence: null },
      type_family: { basis: 'PRE_PHASE15', evidence: null },
      author_names_display: { basis: 'PRE_PHASE15', evidence: null },
      doi: { basis: 'PRE_PHASE15', evidence: null },
    });
  });

  it('ignores malformed stored entries, keeping well-formed ones', () => {
    expect(
      readCuration({ isCurated: true, curation: { title: { basis: 'INDEPENDENT', evidence: 'x' }, venue: { basis: 'SOMETHING' }, year: 'bad', doi: { basis: 'WOS', evidence: '  ' } } }),
    ).toEqual({ title: { basis: 'INDEPENDENT', evidence: 'x' }, doi: { basis: 'WOS', evidence: null } });
    expect(readCuration({ isCurated: false, curation: [] })).toEqual({});
  });
});

describe('manual entries declare their basis and evidence (§12.1)', () => {
  async function professor(server: ReturnType<typeof createApp>) {
    await createUser({ email: 'p@example.org', professor: 'active' });
    return cookiePair(await request(server).post('/api/auth/login').send({ email: 'p@example.org', password: PASSWORD }), 'cse_session');
  }
  const entry = { title: 'A manual paper', typeFamily: 'JOURNAL', year: 2024 };

  it('stores the basis and evidence on the MANUAL source record and shows them to the administrator', async () => {
    const { server, admin } = await setup();
    const cookie = await professor(server);
    const res = await request(server).post('/api/me/publications').set('Cookie', cookie).send({ ...entry, basis: 'WOS', evidence: 'doi:10.5555/Manual' });
    expect(res.status).toBe(201);
    const record = await prisma.publicationSourceRecord.findFirstOrThrow({ where: { source: 'MANUAL' } });
    expect(record).toMatchObject({ entryBasis: 'WOS', entryEvidence: 'doi:10.5555/Manual' });

    const detail = await request(server).get(`/api/admin/publications/${record.publicationId}`).set('Cookie', admin);
    expect(detail.body.publication.sourceRecords[0]).toMatchObject({ source: 'MANUAL', entryBasis: 'WOS', entryEvidence: 'doi:10.5555/Manual' });
    expect(detail.body.publication.curation).toEqual({});
  });

  it('refuses an entry without basis or with evidence that is neither a DOI nor a web link', async () => {
    const { server } = await setup();
    const cookie = await professor(server);
    const post = (body: object) => request(server).post('/api/me/publications').set('Cookie', cookie).send({ ...entry, ...body });
    expect((await post({ evidence: 'https://repo.example.org/1' })).body.error.code).toBe('VALIDATION_ERROR');
    expect((await post({ basis: 'INDEPENDENT' })).body.error.code).toBe('VALIDATION_ERROR');
    expect((await post({ basis: 'PRE_PHASE15', evidence: 'https://repo.example.org/1' })).body.error.code).toBe('VALIDATION_ERROR');
    expect((await post({ basis: 'INDEPENDENT', evidence: 'my memory' })).body.error.code).toBe('INVALID_EVIDENCE');
    expect((await post({ basis: 'INDEPENDENT', evidence: 'ftp://repo.example.org/1' })).body.error.code).toBe('INVALID_EVIDENCE');
    expect((await post({ basis: 'INDEPENDENT', evidence: 'https://localhost/x' })).body.error.code).toBe('INVALID_EVIDENCE');
    expect(await prisma.publicationSourceRecord.count()).toBe(0);
    expect((await post({ basis: 'INDEPENDENT', evidence: 'https://repo.example.org/handle/1' })).status).toBe(201);
  });
});

describe('authenticated responses are never cached', () => {
  it('sends Cache-Control: no-store on /api/me and /api/admin', async () => {
    const { server, admin } = await setup();
    expect((await request(server).get('/api/admin/publications').set('Cookie', admin)).headers['cache-control']).toBe('no-store');
    expect((await request(server).get('/api/me/publications').set('Cookie', admin)).headers['cache-control']).toBe('no-store');
    expect((await request(server).get('/api/admin/publications')).headers['cache-control']).toBe('no-store'); // even when refused
  });
});
