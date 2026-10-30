import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app';
import { prisma } from '../../src/config/database';
import { ScopusClient } from '../../src/integrations/scopus/client';
import { testClock } from '../auth/helpers';
import { resetDatabase } from '../helpers/database';
import { noSleep, replayFetch, Route } from '../helpers/fixtures';
import { adminCookie, replayIdentityClients } from './helpers';
import { API_KEY, AUTHOR, authorFound, authorUrl, OTHER_AUTHOR, status } from '../fixtures/scopus/synthetic';

/* Scopus identity registration and verification (stage 15.3, decision #118) — synthetic responses only. */

const NOW = '2026-11-05T10:00:00.000Z';
const PROFILE = `https://www.scopus.com/authid/detail.uri?authorId=${AUTHOR}`;

beforeEach(async () => {
  await resetDatabase();
});

afterAll(async () => {
  await resetDatabase();
  await prisma.$disconnect();
});

/** The admin app; `scopus` routes enable the API preview as if Scopus credentials were configured. */
async function setup(scopus?: { recorded?: ReturnType<typeof authorFound>[]; overrides?: Record<string, Route> }) {
  const { clients } = replayIdentityClients();
  const replay = scopus ? replayFetch(scopus.recorded ?? [authorFound()], scopus.overrides) : null;
  const server = createApp({
    mailer: null,
    now: testClock(NOW).now,
    identityClients: {
      ...clients,
      scopus: replay ? new ScopusClient({ apiKey: API_KEY, http: { maxRetries: 0 }, deps: { fetchImpl: replay.fetchImpl, sleep: noSleep } }) : null,
    },
  });
  const cookie = await adminCookie(server);
  const admin = await prisma.user.findUniqueOrThrow({ where: { email: 'admin@example.org' } });
  const professor = await prisma.professor.create({ data: { name: 'Prof Scopus' } });
  return { server, cookie, admin, professor, calls: replay?.calls ?? [] };
}

describe('manual Scopus verification from profile evidence', () => {
  it('registers the identity with method, canonical evidence URL, administrator and time — without any API request', async () => {
    const { server, cookie, admin, professor, calls } = await setup();
    const res = await request(server)
      .post(`/api/admin/professors/${professor.id}/identities/manual`)
      .set('Cookie', cookie)
      .send({ source: 'SCOPUS', externalId: ` AUTHOR_ID:${AUTHOR} `, evidenceUrl: `${PROFILE}&origin=resultslist` });

    expect(res.status).toBe(201);
    expect(res.body.identity).toMatchObject({
      source: 'SCOPUS',
      externalId: AUTHOR,
      isActive: true,
      verifiedAt: NOW,
      verificationMethod: 'MANUAL_PROFILE',
      verificationEvidenceUrl: PROFILE,
    });
    const stored = await prisma.externalIdentity.findFirstOrThrow({ where: { source: 'SCOPUS' } });
    expect(stored).toMatchObject({ professorId: professor.id, verifiedByUserId: admin.id, verificationMethod: 'MANUAL_PROFILE' });
    expect(calls).toHaveLength(0);

    const detail = await request(server).get(`/api/admin/professors/${professor.id}`).set('Cookie', cookie);
    expect(detail.body.professor.identities[0]).toMatchObject({ verificationMethod: 'MANUAL_PROFILE', verificationEvidenceUrl: PROFILE });
  });

  it('refuses evidence that is not a Scopus profile of the same Author ID', async () => {
    const { server, cookie, professor } = await setup();
    const post = (body: Record<string, unknown>) => request(server).post(`/api/admin/professors/${professor.id}/identities/manual`).set('Cookie', cookie).send(body);

    expect((await post({ source: 'SCOPUS', externalId: AUTHOR, evidenceUrl: `https://www.scopus.com/authid/detail.uri?authorId=${OTHER_AUTHOR}` })).body.error.code).toBe('EVIDENCE_MISMATCH');
    expect((await post({ source: 'SCOPUS', externalId: AUTHOR, evidenceUrl: `https://example.org/profile?authorId=${AUTHOR}` })).body.error.code).toBe('INVALID_EVIDENCE');
    expect((await post({ source: 'SCOPUS', externalId: AUTHOR, evidenceUrl: 'not a url' })).body.error.code).toBe('INVALID_EVIDENCE');
    expect((await post({ source: 'SCOPUS', externalId: 'A-1009-2008', evidenceUrl: PROFILE })).body.error.code).toBe('INVALID_IDENTIFIER');
    expect((await post({ source: 'ORCID', externalId: '0000-0002-0661-5773', evidenceUrl: PROFILE })).status).toBe(400); // only Scopus, for now
    expect((await post({ source: 'SCOPUS', externalId: AUTHOR })).status).toBe(400);
    expect(await prisma.externalIdentity.count()).toBe(0);
  });

  it('never transfers an identity that another professor already has', async () => {
    const { server, cookie, professor } = await setup();
    const owner = await prisma.professor.create({ data: { name: 'Prof Owner' } });
    await prisma.externalIdentity.create({ data: { professorId: owner.id, source: 'SCOPUS', externalId: AUTHOR } });

    const res = await request(server)
      .post(`/api/admin/professors/${professor.id}/identities/manual`)
      .set('Cookie', cookie)
      .send({ source: 'SCOPUS', externalId: AUTHOR, evidenceUrl: PROFILE });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('IDENTITY_IN_USE');
    expect(await prisma.externalIdentity.findMany({ select: { professorId: true } })).toEqual([{ professorId: owner.id }]);
  });

  it('is refused for an unknown professor and requires an administrator', async () => {
    const { server, cookie } = await setup();
    const unknown = await request(server)
      .post('/api/admin/professors/00000000-0000-4000-8000-000000000099/identities/manual')
      .set('Cookie', cookie)
      .send({ source: 'SCOPUS', externalId: AUTHOR, evidenceUrl: PROFILE });
    expect(unknown.status).toBe(404);
    const anonymous = await request(server).post('/api/admin/professors/00000000-0000-4000-8000-000000000099/identities/manual').send({});
    expect(anonymous.status).toBe(401);
  });
});

describe('Scopus API preview', () => {
  it('without Scopus credentials the preview explains that manual verification is needed', async () => {
    const { server, cookie, professor } = await setup();
    const res = await request(server).post(`/api/admin/professors/${professor.id}/identities/preview`).set('Cookie', cookie).send({ source: 'SCOPUS', externalId: AUTHOR });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('PROVIDER_NOT_CONFIGURED');
  });

  it('with credentials it previews the author, writes nothing, and saving records API_PREVIEW and the administrator', async () => {
    const { server, cookie, admin, professor } = await setup({});
    const preview = await request(server).post(`/api/admin/professors/${professor.id}/identities/preview`).set('Cookie', cookie).send({ source: 'SCOPUS', externalId: PROFILE });
    expect(preview.status).toBe(200);
    expect(preview.body.preview).toEqual({
      source: 'SCOPUS',
      externalId: AUTHOR,
      authorId: AUTHOR,
      name: 'Asha Verma',
      documentCount: 3,
      profileUrl: PROFILE,
    });
    expect(await prisma.externalIdentity.count()).toBe(0);

    const saved = await request(server).post(`/api/admin/professors/${professor.id}/identities`).set('Cookie', cookie).send({ previewToken: preview.body.previewToken });
    expect(saved.status).toBe(201);
    expect(saved.body.identity).toMatchObject({ source: 'SCOPUS', externalId: AUTHOR, verificationMethod: 'API_PREVIEW', verificationEvidenceUrl: null });
    expect(await prisma.externalIdentity.findFirstOrThrow()).toMatchObject({ verifiedByUserId: admin.id });
  });

  it('maps Scopus failures to fixed messages without credentials or provider text', async () => {
    const cases: [Route, number, string][] = [
      [status(404), 422, 'IDENTITY_NOT_FOUND'],
      [status(301, { location: `https://api.elsevier.com/content/author/author_id/${OTHER_AUTHOR}` }), 422, 'IDENTITY_INVALID'],
      [status(401), 502, 'PROVIDER_AUTH_FAILED'],
      [status(403), 502, 'PROVIDER_NOT_ENTITLED'],
      [status(429, { 'X-ELS-Status': 'QUOTA_EXCEEDED - Quota Exceeded' }), 503, 'PROVIDER_QUOTA_EXCEEDED'],
    ];
    for (const [route, code, errorCode] of cases) {
      await resetDatabase();
      const { server, cookie, professor } = await setup({ recorded: [], overrides: { [authorUrl()]: route } });
      const res = await request(server).post(`/api/admin/professors/${professor.id}/identities/preview`).set('Cookie', cookie).send({ source: 'SCOPUS', externalId: AUTHOR });
      expect(res.status, errorCode).toBe(code);
      expect(res.body.error.code).toBe(errorCode);
      expect(JSON.stringify(res.body)).not.toContain(API_KEY);
    }
  });
});
