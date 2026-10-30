import request from 'supertest';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { prisma } from '../../src/config/database';
import { createApp } from '../../src/app';
import { identityQuery, sparqlUrl } from '../../src/integrations/dblp/client';
import { OPENALEX_BASE_URL, OpenAlexClient } from '../../src/integrations/openalex/client';
import { ORCID_API_BASE_URL } from '../../src/integrations/orcid/client';
import { Prisma } from '@prisma/client';
import { signSessionToken } from '../../src/services/auth/tokens';
import { deleteIdentity, setIdentityActive } from '../../src/services/identities/identities';
import { testClock } from '../auth/helpers';
import { resetDatabase } from '../helpers/database';
import { noSleep, Route } from '../helpers/fixtures';
import { adminApp, adminCookie, replayIdentityClients, tableCounts } from './helpers';

/* External identity preview, save and §12.4 cleanup (Project_plan.md §6.3, §12.4; Phase 9). */

beforeEach(async () => {
  await resetDatabase();
});

let warnings: string[] = [];
beforeEach(() => {
  warnings = [];
  vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => void warnings.push(args.map(String).join(' ')));
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await resetDatabase();
  await prisma.$disconnect();
});

const DBLP_NOT_A_PERSON =
  'This DBLP PID does not identify a single person (for example, it is a disambiguation page); use the PID of the specific person';
const authorUrl = (id: string) => `${OPENALEX_BASE_URL}/authors/${id}?select=id,display_name,orcid,works_count`;
const json = (body: unknown, status = 200) => () => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

async function setup(options: { overrides?: Record<string, Route>; now?: () => Date } = {}) {
  const { server, calls } = adminApp(options);
  const cookie = await adminCookie(server);
  const professor = await prisma.professor.create({ data: { name: 'Moshe Y. Vardi', department: 'CSE' } });
  const other = await prisma.professor.create({ data: { name: 'Other Professor' } });
  const base = `/api/admin/professors/${professor.id}/identities`;
  return {
    server,
    calls,
    professor,
    other,
    preview: (source: string, externalId: string, professorId = professor.id) =>
      request(server).post(`/api/admin/professors/${professorId}/identities/preview`).set('Cookie', cookie).send({ source, externalId }),
    save: (previewToken: string, professorId = professor.id) =>
      request(server).post(`/api/admin/professors/${professorId}/identities`).set('Cookie', cookie).send({ previewToken }),
    setActive: (identityId: string, isActive: boolean, professorId = professor.id) =>
      request(server).patch(`/api/admin/professors/${professorId}/identities/${identityId}`).set('Cookie', cookie).send({ isActive }),
    remove: (identityId: string, professorId = professor.id) =>
      request(server).delete(`/api/admin/professors/${professorId}/identities/${identityId}`).set('Cookie', cookie),
    base,
  };
}

describe('preview: validation through the existing source clients, without writes', () => {
  it('OpenAlex: shows the author from the recorded response and writes nothing', async () => {
    const { preview, calls } = await setup();
    const before = await tableCounts();
    const res = await preview('OPENALEX', 'https://openalex.org/a5023888391');

    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body.preview).toEqual({
      source: 'OPENALEX',
      externalId: 'A5023888391',
      requestedId: 'A5023888391',
      resolvedId: 'A5023888391',
      merged: false,
      displayName: 'Jason R Priem',
      orcid: 'https://orcid.org/0000-0001-6187-6610',
      worksCount: 64,
      profileUrl: 'https://openalex.org/A5023888391',
      warning: null,
    });
    expect(res.body.alreadyAssigned).toBeNull();
    expect(typeof res.body.previewToken).toBe('string');
    expect(await tableCounts()).toEqual(before); // no identity, publication, record, link or sync
    expect(calls.map((c) => c.url)).toEqual([authorUrl('A5023888391')]); // the author check only, no works
  });

  it('OpenAlex merged author: shows requested and resolved IDs with a warning; the submitted ID is what gets stored', async () => {
    const { preview, save } = await setup({
      overrides: { [authorUrl('A1234567890')]: json({ id: 'https://openalex.org/A5023888391', display_name: 'Jason R Priem', orcid: null, works_count: 64 }) },
    });
    const res = await preview('OPENALEX', 'A1234567890');
    expect(res.body.preview).toMatchObject({ externalId: 'A1234567890', requestedId: 'A1234567890', resolvedId: 'A5023888391', merged: true });
    expect(res.body.preview.warning).toMatch(/merged A1234567890 into A5023888391/);

    const saved = await save(res.body.previewToken);
    expect(saved.status).toBe(201);
    expect(saved.body.identity).toMatchObject({ source: 'OPENALEX', externalId: 'A1234567890', isActive: true });
  });

  it('DBLP: person with name; disambiguation page and missing PID are refused', async () => {
    const { preview } = await setup();
    const before = await tableCounts();
    const person = await preview('DBLP', 'https://dblp.org/pid/v/MosheYVardi.html');
    expect(await tableCounts()).toEqual(before); // all nine tables unchanged
    expect(person.body.preview).toEqual({
      source: 'DBLP',
      externalId: 'v/MosheYVardi',
      pid: 'v/MosheYVardi',
      name: 'Moshe Y. Vardi',
      profileUrl: 'https://dblp.org/pid/v/MosheYVardi.html',
    });
    const ambiguous = await preview('DBLP', '00/10049');
    expect(ambiguous.status).toBe(422);
    expect(ambiguous.body).toEqual({ error: { code: 'IDENTITY_INVALID', message: DBLP_NOT_A_PERSON } });
    const missing = await preview('DBLP', '00/0000000');
    expect(missing.body.error.code).toBe('IDENTITY_NOT_FOUND');
  });

  it('DBLP: a creator that is not a person gets the same stable message, without dblp type URIs', async () => {
    const notAPerson = json({
      head: { vars: ['type', 'name'] },
      results: { bindings: [{ type: { type: 'uri', value: 'https://dblp.org/rdf/schema#Creator' }, name: { type: 'literal', value: 'Some Group' } }] },
      meta: { 'result-size-total': 1 },
    });
    const { preview } = await setup({ overrides: { [sparqlUrl(identityQuery('99/9999'))]: notAPerson } });
    const res = await preview('DBLP', '99/9999');
    expect(res.status).toBe(422);
    expect(res.body).toEqual({ error: { code: 'IDENTITY_INVALID', message: DBLP_NOT_A_PERSON } });
    expect(JSON.stringify(res.body)).not.toContain('dblp.org/rdf');
    expect(warnings.join('\n')).toContain('https://dblp.org/rdf/schema#Creator'); // kept for debugging, server-side only
  });

  it('ORCID: public name (credit name, or given + family), works count, recent works and link', async () => {
    const { preview } = await setup();
    const before = await tableCounts();
    const vardi = await preview('ORCID', 'https://orcid.org/0000-0002-0661-5773');
    expect(vardi.body.preview).toMatchObject({
      source: 'ORCID',
      externalId: '0000-0002-0661-5773',
      name: 'Moshe Y. Vardi',
      worksCount: 8,
      profileUrl: 'https://orcid.org/0000-0002-0661-5773',
    });
    const recent = vardi.body.preview.recentWorks as Array<{ title: string; year: number | null }>;
    expect(recent.length).toBeGreaterThan(0);
    expect(recent.length).toBeLessThanOrEqual(5);
    expect(recent.every((w) => typeof w.title === 'string')).toBe(true);
    const years = recent.map((w) => w.year ?? 0);
    expect([...years].sort((a, b) => b - a)).toEqual(years);

    const carberry = await preview('ORCID', '0000-0002-1825-0097');
    expect(carberry.body.preview.name).toBe('Josiah Carberry');
    expect(await tableCounts()).toEqual(before); // all nine tables unchanged
  });

  it('ORCID: checksum, nonexistent, deactivated and deprecated iDs are refused', async () => {
    const { preview, calls } = await setup({
      overrides: {
        [`${ORCID_API_BASE_URL}/0000-0003-1613-5981/works`]: () =>
          new Response('', { status: 301, headers: { location: 'https://orcid.org/0000-0002-1825-0097' } }),
      },
    });
    const checksum = await preview('ORCID', '0000-0002-0661-5774');
    expect(checksum.status).toBe(400);
    expect(checksum.body.error.code).toBe('INVALID_IDENTIFIER');
    expect(calls).toHaveLength(0);

    expect((await preview('ORCID', '0000-0001-2345-6789')).body.error.code).toBe('IDENTITY_NOT_FOUND');
    const deactivated = await preview('ORCID', '0000-0002-0155-3227');
    expect(deactivated.body).toEqual({
      error: { code: 'IDENTITY_INVALID', message: 'This ORCID record is deactivated or locked and cannot be used' },
    });
    // ORCID's own wording and error code stay out of the response; the server log keeps them.
    expect(JSON.stringify(deactivated.body)).not.toMatch(/9044|The ORCID record is deactivated\./);
    expect(warnings.join('\n')).toMatch(/ORCID IDENTITY_INVALID \(HTTP 409\).*9044/);
    const deprecated = await preview('ORCID', '0000-0003-1613-5981');
    expect(deprecated.body).toEqual({
      error: { code: 'IDENTITY_INVALID', message: "This ORCID iD is deprecated (merged into another record); use the record's current iD" },
    });
    expect(warnings.join('\n')).toMatch(/ORCID IDENTITY_INVALID \(HTTP 301\).*merged into 0000-0002-1825-0097/);
  });

  it('OpenAlex nonexistent (recorded 404) and malformed identifiers', async () => {
    const { preview, calls } = await setup();
    expect((await preview('OPENALEX', 'A5999999999')).body.error.code).toBe('IDENTITY_NOT_FOUND');
    expect((await preview('OPENALEX', 'A5092938886')).body.error.code).toBe('IDENTITY_NOT_FOUND'); // documented merged example
    const callsBefore = calls.length;
    for (const [source, value] of [['OPENALEX', 'W123'], ['DBLP', 'not a pid'], ['ORCID', '1234']]) {
      const res = await preview(source, value);
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('INVALID_IDENTIFIER');
    }
    expect(calls.length).toBe(callsBefore);
    expect((await preview('WOS', 'A-1009')).body.error.code).toBe('INVALID_IDENTIFIER'); // WoS accepted since stage 15.4
    expect((await preview('SCOPUS', '57-000-001')).body.error.code).toBe('INVALID_IDENTIFIER'); // Scopus accepted since stage 15.3
  });

  it('source failures (HTML with 200, 5xx, malformed JSON, network error, timeout) answer 502 without upstream text or writes', async () => {
    const failures: Record<string, Route> = {
      [authorUrl('A1000000001')]: () => new Response('<!DOCTYPE html><html>Just a moment... secret-upstream-text</html>', { status: 200, headers: { 'content-type': 'text/html' } }),
      [authorUrl('A1000000002')]: () => new Response('upstream exploded secret-upstream-text', { status: 503 }),
      [authorUrl('A1000000003')]: () => new Response('{"id": "https://openalex.org/A1', { status: 200, headers: { 'content-type': 'application/json' } }),
      [authorUrl('A1000000004')]: () => Promise.reject(new TypeError('fetch failed secret-upstream-text')),
    };
    const { preview } = await setup({ overrides: failures });
    const before = await tableCounts();
    for (const id of ['A1000000001', 'A1000000002', 'A1000000003', 'A1000000004']) {
      const res = await preview('OPENALEX', id);
      expect(res.status, id).toBe(502);
      expect(res.body).toEqual({
        error: { code: 'IDENTITY_SOURCE_UNAVAILABLE', message: 'Could not verify the OpenAlex author ID right now; try again later' },
      });
    }
    expect(await tableCounts()).toEqual(before);
  });

  it('a source that does not answer in time is a 502 (the client aborts the request)', async () => {
    // Like the real fetch: never answers, but rejects when the client's timeout aborts the request.
    const hanging = ((_url: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('The operation was aborted', 'AbortError')));
      })) as typeof fetch;
    const { clients } = replayIdentityClients();
    const server = createApp({
      mailer: null,
      identityClients: { ...clients, openAlex: new OpenAlexClient({ deps: { fetchImpl: hanging, sleep: noSleep }, http: { timeoutMs: 50, maxRetries: 1 } }) },
    });
    const cookie = await adminCookie(server);
    const professor = await prisma.professor.create({ data: { name: 'P Q' } });
    const res = await request(server)
      .post(`/api/admin/professors/${professor.id}/identities/preview`)
      .set('Cookie', cookie)
      .send({ source: 'OPENALEX', externalId: 'A1000000005' });
    expect(res.status).toBe(502);
    expect(res.body.error.code).toBe('IDENTITY_SOURCE_UNAVAILABLE');
  });

  it('refuses an unknown professor before contacting any source; reports an identity already assigned', async () => {
    const { preview, save, other, calls } = await setup();
    const unknown = await preview('DBLP', 'v/MosheYVardi', '00000000-0000-4000-8000-000000000099');
    expect(unknown.body.error.code).toBe('PROFESSOR_NOT_FOUND');
    expect(calls).toHaveLength(0);

    const first = await preview('DBLP', 'v/MosheYVardi');
    await save(first.body.previewToken);
    const forOther = await preview('DBLP', 'v/MosheYVardi', other.id);
    expect(forOther.body.alreadyAssigned).toMatchObject({ sameProfessor: false, isActive: true });
  });
});

describe('save: only with a valid preview token, no further source request', () => {
  it('stores the normalized submitted identifier with verified_at = preview time', async () => {
    const clock = testClock('2026-10-14T10:00:00.000Z');
    const { preview, save, calls, professor } = await setup({ now: clock.now });
    const res = await preview('ORCID', 'https://orcid.org/0000-0002-0661-5773');
    const callsAfterPreview = calls.length;
    clock.advance(5 * 60_000);

    const saved = await save(res.body.previewToken);
    expect(saved.status).toBe(201);
    expect(saved.body.identity).toMatchObject({ source: 'ORCID', externalId: '0000-0002-0661-5773', isActive: true, verifiedAt: '2026-10-14T10:00:00.000Z' });
    expect(calls.length).toBe(callsAfterPreview);
    expect(await prisma.externalIdentity.count({ where: { professorId: professor.id } })).toBe(1);
  });

  it('refuses expired, tampered, foreign-purpose and other-professor tokens', async () => {
    const clock = testClock('2026-10-14T10:00:00.000Z');
    const { preview, save, other, professor } = await setup({ now: clock.now });
    const token: string = (await preview('DBLP', 'v/MosheYVardi')).body.previewToken;

    expect((await save(token, other.id)).body.error.code).toBe('INVALID_PREVIEW');
    const [head, payload, sig] = token.split('.');
    const forged = JSON.parse(Buffer.from(payload, 'base64url').toString());
    const tampered = `${head}.${Buffer.from(JSON.stringify({ ...forged, xid: 'x/Other' })).toString('base64url')}.${sig}`;
    expect((await save(tampered)).body.error.code).toBe('INVALID_PREVIEW');
    expect((await save(signSessionToken(professor.id, 'hash'))).body.error.code).toBe('INVALID_PREVIEW');

    clock.advance(15 * 60_000 + 1_000);
    expect((await save(token)).body.error.code).toBe('INVALID_PREVIEW');
    expect(await prisma.externalIdentity.count()).toBe(0);
  });

  it('allows several identities from one source; one identity never belongs to two professors (also concurrently)', async () => {
    const { preview, save, other } = await setup({
      overrides: { [authorUrl('A1111111111')]: json({ id: 'https://openalex.org/A1111111111', display_name: 'M. Vardi', orcid: null, works_count: 3 }) },
    });
    expect((await save((await preview('OPENALEX', 'A5023888391')).body.previewToken)).status).toBe(201);
    expect((await save((await preview('OPENALEX', 'A1111111111')).body.previewToken)).status).toBe(201);

    const forMe = (await preview('DBLP', 'v/MosheYVardi')).body.previewToken;
    const forOther = (await preview('DBLP', 'v/MosheYVardi', other.id)).body.previewToken;
    const results = await Promise.all([save(forMe), save(forOther, other.id)]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
    expect(results.find((r) => r.status === 409)!.body.error.code).toBe('IDENTITY_IN_USE');
    expect(await prisma.externalIdentity.count({ where: { source: 'DBLP' } })).toBe(1);
  });
});

describe('deactivation, removal and §12.4 cleanup', () => {
  async function withRelationships() {
    const ctx = await setup();
    const { professor } = ctx;
    const x = await prisma.externalIdentity.create({ data: { professorId: professor.id, source: 'DBLP', externalId: 'v/MosheYVardi' } });
    const y = await prisma.externalIdentity.create({ data: { professorId: professor.id, source: 'ORCID', externalId: '0000-0002-0661-5773' } });
    const pubs = await Promise.all(
      ['p one', 'p two', 'p three', 'p four', 'p five'].map((t) => prisma.publication.create({ data: { title: t, normalizedTitle: t, typeFamily: 'JOURNAL' } })),
    );
    await prisma.publicationSourceRecord.create({
      data: { publicationId: pubs[0].id, source: 'DBLP', externalId: 'conf/x/One', title: 'p one', normalizedTitle: 'p one', typeFamily: 'JOURNAL', matchMethod: 'NEW_PUBLICATION' },
    });
    const link = (i: number, status: 'PENDING' | 'APPROVED' | 'REJECTED', via: string | null, origin: 'DISCOVERED' | 'MANUAL' = 'DISCOVERED') =>
      prisma.professorPublication.create({ data: { professorId: professor.id, publicationId: pubs[i].id, status, origin, discoveredViaIdentityId: via } });
    await link(0, 'PENDING', x.id);
    await link(1, 'APPROVED', x.id);
    await link(2, 'REJECTED', x.id);
    await link(3, 'PENDING', y.id);
    await link(4, 'APPROVED', null, 'MANUAL');
    const run = await prisma.syncRun.create({ data: { trigger: 'MANUAL', status: 'SUCCESS' } });
    await prisma.syncTask.create({ data: { syncRunId: run.id, identityId: x.id, source: 'DBLP', status: 'SUCCESS' } });
    return { ...ctx, x, y, pubs };
  }

  const linkSummary = () =>
    prisma.professorPublication.findMany({ select: { publicationId: true, status: true, discoveredViaIdentityId: true }, orderBy: { status: 'asc' } });

  it('deactivation removes only the PENDING links discovered through that identity; idempotent; reactivation restores nothing', async () => {
    const { setActive, x, y, pubs } = await withRelationships();
    const before = await tableCounts();

    const res = await setActive(x.id, false);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ identity: { id: x.id, isActive: false }, pendingLinksRemoved: 1 });
    const links = await linkSummary();
    expect(links).toHaveLength(4);
    expect(links.find((l) => l.publicationId === pubs[0].id)).toBeUndefined();
    expect(links).toEqual(
      expect.arrayContaining([
        { publicationId: pubs[1].id, status: 'APPROVED', discoveredViaIdentityId: x.id },
        { publicationId: pubs[2].id, status: 'REJECTED', discoveredViaIdentityId: x.id },
        { publicationId: pubs[3].id, status: 'PENDING', discoveredViaIdentityId: y.id },
        { publicationId: pubs[4].id, status: 'APPROVED', discoveredViaIdentityId: null },
      ]),
    );
    const after = await tableCounts();
    expect(after).toEqual({ ...before, links: before.links - 1 }); // publications, records, identities untouched

    expect((await setActive(x.id, false)).body.pendingLinksRemoved).toBe(0);
    const reactivated = await setActive(x.id, true);
    expect(reactivated.body).toMatchObject({ identity: { isActive: true }, pendingLinksRemoved: 0 });
    expect(await prisma.professorPublication.count()).toBe(4);
  });

  it('removal deletes the PENDING links and the identity; APPROVED/REJECTED stay with discovered_via cleared; sync history kept', async () => {
    const { remove, x, y, pubs } = await withRelationships();
    const res = await remove(x.id);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ pendingLinksRemoved: 1 });
    expect(await prisma.externalIdentity.findUnique({ where: { id: x.id } })).toBeNull();
    expect(await linkSummary()).toEqual(
      expect.arrayContaining([
        { publicationId: pubs[1].id, status: 'APPROVED', discoveredViaIdentityId: null },
        { publicationId: pubs[2].id, status: 'REJECTED', discoveredViaIdentityId: null },
        { publicationId: pubs[3].id, status: 'PENDING', discoveredViaIdentityId: y.id },
      ]),
    );
    expect(await prisma.publication.count()).toBe(5);
    expect(await prisma.publicationSourceRecord.count()).toBe(1);
    expect(await prisma.syncTask.findFirst()).toMatchObject({ identityId: null });
    expect((await remove(x.id)).status).toBe(404);
  });

  it('refuses an identity addressed through another professor', async () => {
    const { setActive, remove, x, other } = await withRelationships();
    expect((await setActive(x.id, false, other.id)).body.error.code).toBe('IDENTITY_NOT_FOUND');
    expect((await remove(x.id, other.id)).body.error.code).toBe('IDENTITY_NOT_FOUND');
    expect(await prisma.externalIdentity.findUniqueOrThrow({ where: { id: x.id } })).toMatchObject({ isActive: true });
    expect(await prisma.professorPublication.count()).toBe(5);
  });

  it('answers 404, not 500, when the identity is removed concurrently after the ownership check (I2)', async () => {
    const { professor, x, y } = await withRelationships();
    // Deterministic race: right after the service's ownership check inside its transaction, a
    // concurrent request (another connection) removes the identity.
    const racing = (removeId: string) =>
      withOverride(prisma, '$transaction', (fn: (tx: Prisma.TransactionClient) => Promise<unknown>) =>
        prisma.$transaction((tx) => {
          const identities = new Proxy(tx.externalIdentity, {
            get(target, prop) {
              const value = Reflect.get(target, prop);
              if (prop !== 'findFirst') return typeof value === 'function' ? value.bind(target) : value;
              return async (args: Prisma.ExternalIdentityFindFirstArgs) => {
                const found = await target.findFirst(args);
                await prisma.externalIdentity.delete({ where: { id: removeId } });
                return found;
              };
            },
          });
          return fn(withOverride(tx, 'externalIdentity', identities));
        }),
      );

    await expect(deleteIdentity(professor.id, x.id, racing(x.id))).rejects.toMatchObject({ status: 404, code: 'IDENTITY_NOT_FOUND' });
    await expect(setIdentityActive(professor.id, y.id, false, racing(y.id))).rejects.toMatchObject({ status: 404, code: 'IDENTITY_NOT_FOUND' });
    // The service's own changes were rolled back: y's PENDING link was not removed by it (the
    // concurrent deletion only cleared discovered_via through the foreign key).
    expect(await prisma.professorPublication.count({ where: { status: 'PENDING' } })).toBe(2);
  });

  it('rolls the cleanup back when the identity change fails (real database transaction)', async () => {
    const { remove, x } = await withRelationships();
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const fn = 'phase9_test_block_identity_delete';
    const [{ current_database: db }] = await prisma.$queryRaw<{ current_database: string }[]>`SELECT current_database()`;
    expect(db.endsWith('_test')).toBe(true);
    await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS ${fn} ON external_identities`);
    await prisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS ${fn}()`);
    try {
      await prisma.$executeRawUnsafe(
        `CREATE FUNCTION ${fn}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'phase9 test: delete blocked'; END $$`,
      );
      await prisma.$executeRawUnsafe(`CREATE TRIGGER ${fn} BEFORE DELETE ON external_identities FOR EACH ROW EXECUTE FUNCTION ${fn}()`);
      const res = await remove(x.id);
      expect(res.status).toBe(500);
      expect(await prisma.professorPublication.count()).toBe(5); // the PENDING link removal was rolled back
      expect(await prisma.externalIdentity.findUnique({ where: { id: x.id } })).not.toBeNull();
    } finally {
      await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS ${fn} ON external_identities`);
      await prisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS ${fn}()`);
    }
  });
});

/** A view of a Prisma client (or transaction client) with one property replaced. */
function withOverride<T extends object>(target: T, key: PropertyKey, replacement: unknown): T {
  return new Proxy(target, {
    get(t, prop) {
      if (prop === key) return replacement;
      const value = Reflect.get(t, prop);
      return typeof value === 'function' ? value.bind(t) : value;
    },
  }) as T;
}
