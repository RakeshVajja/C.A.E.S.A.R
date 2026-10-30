import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app';
import { prisma } from '../../src/config/database';
import { WosStarterClient } from '../../src/integrations/wos/client';
import { testClock } from '../auth/helpers';
import { resetDatabase } from '../helpers/database';
import { noSleep, replayFetch, Route } from '../helpers/fixtures';
import { adminCookie, replayIdentityClients } from './helpers';
import { API_KEY, documentsPage, OTHER_RID, RID, searchUrl, status, wosDocument } from '../fixtures/wos/synthetic';

/* Web of Science ResearcherID registration and verification (stage 15.4, decision #118) — synthetic responses only. */

const NOW = '2026-11-05T10:00:00.000Z';
const RECORD = `https://www.webofscience.com/wos/author/record/${RID}`;
const CANONICAL = `https://www.webofscience.com/wos/author/rid/${RID}`;
const firstPage = (total = 7, hits = [wosDocument(1), wosDocument(2)]) => documentsPage(RID, 1, 50, total, hits);

beforeEach(async () => {
  await resetDatabase();
});

afterAll(async () => {
  await resetDatabase();
  await prisma.$disconnect();
});

/** The admin app; `wos` routes enable the API preview as if Web of Science credentials were configured. */
async function setup(wos?: { recorded?: ReturnType<typeof firstPage>[]; overrides?: Record<string, Route> }) {
  const { clients } = replayIdentityClients();
  const replay = wos ? replayFetch(wos.recorded ?? [firstPage()], wos.overrides) : null;
  const server = createApp({
    mailer: null,
    now: testClock(NOW).now,
    identityClients: {
      ...clients,
      wos: replay ? new WosStarterClient({ apiKey: API_KEY, http: { maxRetries: 0 }, deps: { fetchImpl: replay.fetchImpl, sleep: noSleep } }) : null,
    },
  });
  const cookie = await adminCookie(server);
  const admin = await prisma.user.findUniqueOrThrow({ where: { email: 'admin@example.org' } });
  const professor = await prisma.professor.create({ data: { name: 'Prof Web of Science' } });
  return { server, cookie, admin, professor, calls: replay?.calls ?? [] };
}

describe('manual ResearcherID verification from the Web of Science author record', () => {
  it('registers the identity with method, canonical evidence URL, administrator and time — without any API request', async () => {
    const { server, cookie, admin, professor, calls } = await setup();
    const res = await request(server)
      .post(`/api/admin/professors/${professor.id}/identities/manual`)
      .set('Cookie', cookie)
      .send({ source: 'WOS', externalId: ' zzz-0001-2020 ', evidenceUrl: RECORD });

    expect(res.status).toBe(201);
    expect(res.body.identity).toMatchObject({
      source: 'WOS',
      externalId: RID,
      isActive: true,
      verifiedAt: NOW,
      verificationMethod: 'MANUAL_PROFILE',
      verificationEvidenceUrl: CANONICAL,
    });
    expect(await prisma.externalIdentity.findFirstOrThrow({ where: { source: 'WOS' } })).toMatchObject({ professorId: professor.id, verifiedByUserId: admin.id });
    expect(calls).toHaveLength(0);

    const detail = await request(server).get(`/api/admin/professors/${professor.id}`).set('Cookie', cookie);
    expect(detail.body.professor.identities[0]).toMatchObject({ source: 'WOS', verificationMethod: 'MANUAL_PROFILE', verificationEvidenceUrl: CANONICAL });
  });

  it('accepts the …/wos/author/rid/ form of the record URL', async () => {
    const { server, cookie, professor } = await setup();
    const res = await request(server)
      .post(`/api/admin/professors/${professor.id}/identities/manual`)
      .set('Cookie', cookie)
      .send({ source: 'WOS', externalId: RID, evidenceUrl: `${CANONICAL}/` });
    expect(res.status).toBe(201);
  });

  it('refuses evidence that is not a Web of Science record of the same ResearcherID, and malformed ResearcherIDs', async () => {
    const { server, cookie, professor } = await setup();
    const post = (body: Record<string, unknown>) => request(server).post(`/api/admin/professors/${professor.id}/identities/manual`).set('Cookie', cookie).send(body);

    expect((await post({ source: 'WOS', externalId: RID, evidenceUrl: `https://www.webofscience.com/wos/author/record/${OTHER_RID}` })).body.error.code).toBe('EVIDENCE_MISMATCH');
    expect((await post({ source: 'WOS', externalId: RID, evidenceUrl: 'https://www.webofscience.com/wos/author/record/1234567' })).body.error.code).toBe('INVALID_EVIDENCE');
    expect((await post({ source: 'WOS', externalId: RID, evidenceUrl: `https://example.org/wos/author/record/${RID}` })).body.error.code).toBe('INVALID_EVIDENCE');
    expect((await post({ source: 'WOS', externalId: RID, evidenceUrl: `https://www.scopus.com/authid/detail.uri?authorId=57000000001` })).body.error.code).toBe('INVALID_EVIDENCE');
    expect((await post({ source: 'WOS', externalId: '57000000001', evidenceUrl: RECORD })).body.error.code).toBe('INVALID_IDENTIFIER');
    expect((await post({ source: 'WOS', externalId: 'A-1009-08', evidenceUrl: RECORD })).body.error.code).toBe('INVALID_IDENTIFIER');
    expect((await post({ source: 'WOS', externalId: RID })).status).toBe(400);
    expect(await prisma.externalIdentity.count()).toBe(0);
  });

  it('never transfers a ResearcherID that another professor already has', async () => {
    const { server, cookie, professor } = await setup();
    const owner = await prisma.professor.create({ data: { name: 'Prof Owner' } });
    await prisma.externalIdentity.create({ data: { professorId: owner.id, source: 'WOS', externalId: RID } });

    const res = await request(server).post(`/api/admin/professors/${professor.id}/identities/manual`).set('Cookie', cookie).send({ source: 'WOS', externalId: RID, evidenceUrl: RECORD });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('IDENTITY_IN_USE');
    expect(await prisma.externalIdentity.findMany({ select: { professorId: true } })).toEqual([{ professorId: owner.id }]);
  });
});

describe('Web of Science API preview', () => {
  it('without credentials the preview explains that manual verification is needed', async () => {
    const { server, cookie, professor } = await setup();
    const res = await request(server).post(`/api/admin/professors/${professor.id}/identities/preview`).set('Cookie', cookie).send({ source: 'WOS', externalId: RID });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('PROVIDER_NOT_CONFIGURED');
    expect(res.body.error.message).toContain('verify it manually from the author\'s Web of Science record');
  });

  it('with credentials it previews the author found by AI=, writes nothing, and saving records API_PREVIEW and the administrator', async () => {
    const { server, cookie, admin, professor, calls } = await setup({});
    const preview = await request(server).post(`/api/admin/professors/${professor.id}/identities/preview`).set('Cookie', cookie).send({ source: 'WOS', externalId: RECORD });
    expect(preview.status).toBe(200);
    expect(preview.body.preview).toMatchObject({ source: 'WOS', externalId: RID, researcherId: RID, name: 'Verma, A', documentCount: 7, profileUrl: CANONICAL });
    expect(preview.body.preview.warning).toContain('may not be every publication of the researcher');
    expect(JSON.stringify(preview.body)).not.toMatch(/citations|Times Cited|"count"/); // no Times Cited is shown (§13.10)
    expect(calls.map((c) => c.url)).toEqual([searchUrl(RID, 1, 50)]);
    expect(await prisma.externalIdentity.count()).toBe(0);

    const saved = await request(server).post(`/api/admin/professors/${professor.id}/identities`).set('Cookie', cookie).send({ previewToken: preview.body.previewToken });
    expect(saved.status).toBe(201);
    expect(saved.body.identity).toMatchObject({ source: 'WOS', externalId: RID, verificationMethod: 'API_PREVIEW', verificationEvidenceUrl: null });
    expect(await prisma.externalIdentity.findFirstOrThrow()).toMatchObject({ verifiedByUserId: admin.id });
  });

  it('maps Web of Science failures to fixed messages without credentials or provider text', async () => {
    const LEAK = 'SYNTHETIC-PROVIDER-TEXT-7f3a';
    const cases: [Route, number, string][] = [
      [status(200, {}, firstPage(0, []).body), 422, 'IDENTITY_NOT_FOUND'],
      [status(200, {}, firstPage(2, [wosDocument(1, {}, OTHER_RID), wosDocument(2, {}, OTHER_RID)]).body), 422, 'IDENTITY_INVALID'],
      [status(401, {}, { error_description: LEAK, error: 'invalid_request' }), 502, 'PROVIDER_AUTH_FAILED'],
      [status(403, {}, { error: { details: LEAK } }), 502, 'PROVIDER_NOT_ENTITLED'],
      [status(429, {}, { error: { details: LEAK } }), 503, 'PROVIDER_QUOTA_EXCEEDED'],
      [status(500, {}, { error: { details: LEAK } }), 502, 'IDENTITY_SOURCE_UNAVAILABLE'],
    ];
    for (const [route, code, errorCode] of cases) {
      await resetDatabase();
      const { server, cookie, professor } = await setup({ recorded: [], overrides: { [searchUrl(RID, 1, 50)]: route } });
      const res = await request(server).post(`/api/admin/professors/${professor.id}/identities/preview`).set('Cookie', cookie).send({ source: 'WOS', externalId: RID });
      expect(res.status, errorCode).toBe(code);
      expect(res.body.error.code).toBe(errorCode);
      expect(JSON.stringify(res.body)).not.toContain(API_KEY);
      expect(JSON.stringify(res.body)).not.toContain(LEAK);
    }
  });

  it('an invalid ResearcherID is refused before any request', async () => {
    const { server, cookie, professor, calls } = await setup({});
    const res = await request(server).post(`/api/admin/professors/${professor.id}/identities/preview`).set('Cookie', cookie).send({ source: 'WOS', externalId: 'A-1009' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_IDENTIFIER');
    expect(calls).toHaveLength(0);
  });
});
