import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '../../src/config/database';
import { queryResultsCsv, QUERY_EXPORT_COLUMNS } from '../../src/services/publicationQuery/export';
import { cookiePair, createUser, PASSWORD } from '../auth/helpers';
import { resetDatabase } from '../helpers/database';
import { link, professor, professorSession, publication, setup } from '../publications/helpers';

/*
 * POST /api/admin/publication-queries/export (decision #168, amending §24 D14): the administrator's
 * matching publications as CSV — exactly the search's set, in its sort order, the table's columns,
 * canonical metadata only (no analytics, no citation data), formula-safe, admin-only.
 * Synthetic rows only; no network.
 */

const BASE = '/api/admin/publication-queries';

beforeEach(async () => {
  await resetDatabase();
});

afterAll(async () => {
  await resetDatabase();
  await prisma.$disconnect();
});

const cond = (field: string, operator: string, value?: unknown) => ({ field, operator, ...(value !== undefined && { value }) });
const and = (...children: unknown[]) => ({ combinator: 'AND', children });
const ALL = { mode: 'ALL_PUBLICATIONS', statuses: ['APPROVED'] };

/** Minimal RFC 4180 reader for the export (every field quoted, CRLF). */
function parseCsv(text: string): string[][] {
  expect(text.startsWith('﻿')).toBe(true);
  const body = text.slice(1);
  expect(body.endsWith('\r\n')).toBe(true);
  return body
    .slice(0, -2)
    .split('\r\n')
    .map((line) => [...line.matchAll(/"((?:[^"]|"")*)"(?:,|$)/g)].map((m) => m[1].replace(/""/g, '"')));
}

async function world() {
  const { server, admin } = await setup();
  const [p1, p2, p3] = [await professor('Prof One'), await professor('Prof Two'), await professor('Prof Three', false)];
  const a = await publication({ title: 'Alpha joint', year: 2024, type: 'JOURNAL', records: [{ source: 'OPENALEX' }, { source: 'SCOPUS' }] });
  const b = await publication({ title: 'Beta conference', year: 2022, type: 'CONFERENCE', doi: null, records: [{ source: 'DBLP' }] });
  const c = await publication({ title: '=HYPERLINK("http://x") "quoted"', year: 2021, type: 'JOURNAL', records: [{ source: 'ORCID' }] });
  const e = await publication({ title: 'Epsilon suppressed', year: 2020, type: 'JOURNAL', status: 'SUPPRESSED', isCurated: true, records: [{ source: 'SCOPUS' }] });
  const g = await publication({ title: 'Eta unlinked', year: null, type: 'PREPRINT', records: [{ source: 'MANUAL' }] });
  await prisma.publication.update({ where: { id: a.id }, data: { venue: 'Journal of Graphs', authorNamesDisplay: 'A. One; B. Two' } });
  await link(p1.id, a.id, 'APPROVED');
  await link(p2.id, a.id, 'APPROVED');
  await link(p1.id, b.id, 'APPROVED');
  await link(p2.id, b.id, 'PENDING');
  await link(p3.id, c.id, 'APPROVED');
  await link(p2.id, e.id, 'APPROVED');
  const post = (path: string, body: unknown, cookie = admin) => request(server).post(`${BASE}/${path}`).set('Cookie', cookie).send(body as object);
  return { server, admin, p1, p2, p3, a, b, c, e, g, post };
}

describe('access', () => {
  it('admin only: no session 401, professors FORBIDDEN, temporary password refused, foreign Origin refused; no professor export route', async () => {
    const { server, admin } = await setup();
    const prof = await professorSession(server, 'prof@example.org');
    await createUser({ email: 'temp-admin@example.org', role: 'ADMIN', mustChangePassword: true });
    const temp = cookiePair(await request(server).post('/api/auth/login').send({ email: 'temp-admin@example.org', password: PASSWORD }), 'cse_session');
    const path = `${BASE}/export`;
    const body = { link: ALL };
    expect((await request(server).post(path).send(body)).status).toBe(401);
    expect((await request(server).post(path).set('Cookie', prof.cookie).send(body)).body.error.code).toBe('FORBIDDEN');
    expect((await request(server).post(path).set('Cookie', temp).send(body)).body.error.code).toBe('PASSWORD_CHANGE_REQUIRED');
    expect((await request(server).post(path).set('Cookie', admin).set('Origin', 'https://evil.example').send(body)).body.error.code).toBe('ORIGIN_NOT_ALLOWED');
    const ok = await request(server).post(path).set('Cookie', admin).send(body);
    expect(ok.status).toBe(200);
    expect(ok.headers['content-type']).toBe('text/csv; charset=utf-8');
    expect(ok.headers['content-disposition']).toMatch(/^attachment; filename="publication-query-\d{4}-\d{2}-\d{2}\.csv"$/);
    expect(ok.headers['cache-control']).toContain('no-store');
    expect((await request(server).post('/api/me/publication-queries/export').set('Cookie', prof.cookie).send({})).status).toBe(404);
  });
});

describe('content', () => {
  it('contains exactly the matching set in the table order, with the table columns and no citation data', async () => {
    const w = await world();
    // Scopus data exists: the export still carries no count, state or observation.
    const record = await prisma.publicationSourceRecord.findFirstOrThrow({ where: { publicationId: w.a.id, source: 'SCOPUS' } });
    await prisma.citationObservation.create({ data: { sourceRecordId: record.id, provider: 'SCOPUS', count: 42, observedAt: new Date('2026-06-01T00:00:00Z') } });
    const body = { link: ALL, sort: 'title' };
    const res = await w.post('export', body);
    const rows = parseCsv(res.text);
    expect(rows[0]).toEqual([...QUERY_EXPORT_COLUMNS]);
    const search = (await w.post('search', { ...body, limit: 100 })).body;
    expect(rows.slice(1).map((r) => r[0])).toEqual(search.publications.map((p: { title: string }) => p.title.startsWith('=') ? `'${p.title}` : p.title));
    expect(rows.length - 1).toBe(search.total);
    // No citation count, state or observation date in any field.
    for (const field of rows.flat()) {
      expect(field).not.toBe('42');
      expect(field).not.toMatch(/COUNTED|NOT_IN_SCOPUS|NO_COUNT_YET|citation|2026-06-01/i);
    }
    const byTitle = Object.fromEntries(rows.slice(1).map((r) => [r[0], r]));
    expect(byTitle['Alpha joint']).toEqual([
      'Alpha joint',
      '2024',
      'Journal article',
      'Journal of Graphs',
      'A. One; B. Two',
      byTitle['Alpha joint'][5],
      'OpenAlex; Scopus',
      'Active',
      'No',
      'Prof One (Approved, qualifying); Prof Two (Approved, qualifying)',
    ]);
    expect(byTitle['Beta conference'].slice(5)).toEqual(['', 'DBLP', 'Active', 'No', 'Prof One (Approved, qualifying); Prof Two (Pending)']);
    expect(byTitle['Epsilon suppressed'].slice(7)).toEqual(['Suppressed', 'Yes', 'Prof Two (Approved, qualifying)']);
    expect(byTitle['Eta unlinked'].slice(1, 3)).toEqual(['', 'Preprint']);
    expect(byTitle['Eta unlinked'][9]).toBe('');
    // Formula-safe and quote-escaped.
    expect(byTitle[`'=HYPERLINK("http://x") "quoted"`][9]).toBe('Prof Three (Approved, qualifying, inactive)');
  });

  it('follows the query exactly: link scope, conditions, selected and qualifying marks, sort', async () => {
    const w = await world();
    const selected = await w.post('export', { link: { mode: 'SELECTED', statuses: ['APPROVED'], professors: [w.p2.id], match: 'ANY' } });
    const rows = parseCsv(selected.text).slice(1);
    expect(rows.map((r) => r[0])).toEqual(['Alpha joint', 'Epsilon suppressed']); // year order
    expect(rows[0][9]).toBe('Prof Two (Approved, qualifying, selected); Prof One (Approved, qualifying)');
    const filtered = parseCsv((await w.post('export', { link: ALL, root: and(cond('year', 'isEmpty')) })).text);
    expect(filtered.slice(1).map((r) => r[0])).toEqual(['Eta unlinked']);
    const empty = parseCsv((await w.post('export', { link: ALL, root: and(cond('year', 'eq', 1999)) })).text);
    expect(empty).toEqual([[...QUERY_EXPORT_COLUMNS]]);
  });

  it('validates like the search, refuses citation conditions without data, and caps the size', async () => {
    const w = await world();
    for (const body of [{}, { link: { ...ALL, departmentId: 'x' } }, { link: ALL, publicationIds: [w.a.id] }]) {
      const res = await w.post('export', body);
      expect([res.status, res.body.error.code], JSON.stringify(body)).toEqual([400, 'VALIDATION_ERROR']);
    }
    expect((await w.post('export', { link: ALL, root: and(cond('scopusCitations', 'gte', 1)) })).body.error.code).toBe('CITATION_DATA_UNAVAILABLE');
    await expect(queryResultsCsv({ link: ALL }, prisma, { maxRows: 4 })).rejects.toMatchObject({ status: 400, code: 'EXPORT_TOO_LARGE' });
    expect((await queryResultsCsv({ link: ALL }, prisma, { maxRows: 5 })).rows).toBe(5);
  });
});
