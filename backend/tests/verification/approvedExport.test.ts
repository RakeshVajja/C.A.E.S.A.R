import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '../../src/config/database';
import { csvField } from '../../src/services/verification/approvedExport';
import { cookiePair, createUser, PASSWORD } from '../auth/helpers';
import { resetDatabase } from '../helpers/database';
import { link, NOW, professor, professorSession, publication, setup } from '../publications/helpers';

/* The professor's approved-publications CSV (decision #153): own APPROVED links to ACTIVE publications, canonical metadata only. */

beforeEach(async () => {
  await resetDatabase();
});

afterAll(async () => {
  await resetDatabase();
  await prisma.$disconnect();
});

const PATH = '/api/me/publications/export';

/** Parses the RFC 4180 output (every field quoted) into rows of strings. */
function parse(csv: string): string[][] {
  expect(csv.startsWith('﻿')).toBe(true);
  const rows: string[][] = [];
  let row: string[] = [];
  let i = 1;
  while (i < csv.length) {
    expect(csv[i]).toBe('"');
    let field = '';
    i++;
    for (;;) {
      if (csv[i] === '"' && csv[i + 1] === '"') {
        field += '"';
        i += 2;
      } else if (csv[i] === '"') {
        i++;
        break;
      } else field += csv[i++];
    }
    row.push(field);
    if (csv[i] === ',') i++;
    else {
      expect(csv.slice(i, i + 2)).toBe('\r\n');
      i += 2;
      rows.push(row);
      row = [];
    }
  }
  return rows;
}

describe('GET /api/me/publications/export', () => {
  it('requires a professor session without a temporary password', async () => {
    const { server, admin } = await setup();
    await createUser({ email: 'temp@example.org', professor: 'active', mustChangePassword: true });
    const temp = cookiePair(await request(server).post('/api/auth/login').send({ email: 'temp@example.org', password: PASSWORD }), 'cse_session');
    expect((await request(server).get(PATH)).status).toBe(401);
    expect((await request(server).get(PATH).set('Cookie', admin)).body.error.code).toBe('FORBIDDEN');
    expect((await request(server).get(PATH).set('Cookie', temp)).body.error.code).toBe('PASSWORD_CHANGE_REQUIRED');
  });

  it('downloads only the professor’s approved, active publications with the canonical columns', async () => {
    const { server } = await setup();
    const me = await professorSession(server, 'me@example.org');
    const other = await professor('Prof Other');
    const newer = await publication({ title: 'Newer paper', year: 2024, type: 'CONFERENCE', records: [{ source: 'DBLP' }, { source: 'OPENALEX' }, { source: 'SCOPUS' }] });
    await prisma.publication.update({ where: { id: newer.id }, data: { venue: 'Test Conf, "Main track"', authorNamesDisplay: 'A. Author; B. Author', doi: '10.5555/newer' } });
    const older = await publication({ title: 'Older paper', year: 2019, doi: null, records: [{ source: 'MANUAL' }] });
    const undated = await publication({ title: '=HYPERLINK("x") multi\nline', year: null, doi: null, records: [{ source: 'WOS' }] });
    await link(me.prof.id, newer.id, 'APPROVED');
    await link(me.prof.id, older.id, 'APPROVED');
    await link(me.prof.id, undated.id, 'APPROVED');
    const pending = await publication({ title: 'Pending paper' });
    await link(me.prof.id, pending.id, 'PENDING');
    const rejected = await publication({ title: 'Rejected paper' });
    await link(me.prof.id, rejected.id, 'REJECTED');
    const suppressed = await publication({ title: 'Suppressed paper', status: 'SUPPRESSED' });
    await link(me.prof.id, suppressed.id, 'APPROVED');
    const others = await publication({ title: 'Someone else paper' });
    await link(other.id, others.id, 'APPROVED');
    // Provider data that must never appear: citation counts and raw metadata.
    const scopus = await prisma.publicationSourceRecord.findFirstOrThrow({ where: { publicationId: newer.id, source: 'SCOPUS' } });
    await prisma.citationObservation.create({ data: { sourceRecordId: scopus.id, provider: 'SCOPUS', count: 4242, observedAt: new Date(NOW) } });

    const res = await request(server).get(PATH).set('Cookie', me.cookie);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('text/csv; charset=utf-8');
    expect(res.headers['content-disposition']).toBe(`attachment; filename="my-approved-publications-${NOW.slice(0, 10)}.csv"`);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.text).not.toMatch(/4242|raw-metadata-never-returned|Pending paper|Rejected paper|Suppressed paper|Someone else/);

    expect(parse(res.text)).toEqual([
      ['Title', 'Year', 'Type', 'Venue', 'Authors', 'DOI', 'Sources'],
      ['Newer paper', '2024', 'Conference paper', 'Test Conf, "Main track"', 'A. Author; B. Author', '10.5555/newer', 'OpenAlex; DBLP; Scopus'],
      ['Older paper', '2019', 'Journal article', '', '', '', 'Manual entry'],
      ["'=HYPERLINK(\"x\") multi\nline", '', 'Journal article', '', '', '', 'Web of Science'], // formula neutralized; unknown year last
    ]);
  });

  it('an empty list is the header row only', async () => {
    const { server } = await setup();
    const me = await professorSession(server, 'me@example.org');
    expect(parse((await request(server).get(PATH).set('Cookie', me.cookie)).text)).toEqual([['Title', 'Year', 'Type', 'Venue', 'Authors', 'DOI', 'Sources']]);
  });

  it('neutralizes every spreadsheet formula prefix and doubles quotes', () => {
    for (const prefix of ['=', '+', '-', '@', '\t', '\r']) expect(csvField(`${prefix}1+1`)).toBe(`"'${prefix}1+1"`);
    expect(csvField('say "hi"')).toBe('"say ""hi"""');
    expect(csvField(null)).toBe('""');
    expect(csvField(2024)).toBe('"2024"');
  });
});
