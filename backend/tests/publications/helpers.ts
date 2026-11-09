import { PublicationSource, TypeFamily, VerificationStatus } from '@prisma/client';
import request from 'supertest';
import { expect } from 'vitest';
import { createApp } from '../../src/app';
import { prisma } from '../../src/config/database';
import { DblpClient } from '../../src/integrations/dblp/client';
import { OPENALEX_BASE_URL, OpenAlexClient } from '../../src/integrations/openalex/client';
import { OrcidClient } from '../../src/integrations/orcid/client';
import { SyncService } from '../../src/services/sync/syncService';
import { cookiePair, createUser, PASSWORD, testClock } from '../auth/helpers';
import { loadFixture, noSleep, replayFetch, Route } from '../helpers/fixtures';
import { allProvidersPresent } from '../helpers/providers';
import { adminCookie } from '../professors/helpers';

/* Shared fixtures of the publication-management and duplicate-resolution tests (synthetic rows, no network). */

export const NOW = '2026-10-26T09:00:00.000Z';
export const PRIEM = 'A5023888391';
export const AUTHOR_URL = `${OPENALEX_BASE_URL}/authors/${PRIEM}?select=id,display_name,orcid,works_count`;

export function syncService(overrides: Record<string, Route> = {}) {
  const recorded = [loadFixture('openalex', 'author-valid'), ...['works-page-1', 'works-page-2', 'works-page-3'].map((n) => loadFixture('openalex', n))];
  const deps = { fetchImpl: replayFetch(recorded, overrides).fetchImpl, sleep: noSleep };
  return new SyncService({
    clients: {
      openAlex: new OpenAlexClient({ perPage: 25, deps, http: { maxRetries: 0 } }),
      dblp: new DblpClient({ deps, http: { maxRetries: 0 } }),
      orcid: new OrcidClient({ deps, http: { maxRetries: 0 } }),
    },
    now: testClock(NOW).now,
    providers: allProvidersPresent(),
  });
}

export async function setup(sync = syncService()) {
  const server = createApp({ mailer: null, sync, now: testClock(NOW).now });
  const admin = await adminCookie(server);
  const adminUser = await prisma.user.findUniqueOrThrow({ where: { email: 'admin@example.org' } });
  return { server, admin, adminUser, sync };
}

let seq = 0;
interface RecordSpec {
  source: PublicationSource;
  doi?: string | null;
  venue?: string | null;
  title?: string;
  year?: number | null;
}
export async function publication(options: { title?: string; year?: number | null; type?: TypeFamily; doi?: string | null; status?: 'ACTIVE' | 'SUPPRESSED'; isCurated?: boolean; records?: RecordSpec[] } = {}) {
  const n = ++seq;
  const title = options.title ?? `Paper ${n}`;
  const typeFamily = options.type ?? 'JOURNAL';
  const records = options.records ?? [{ source: 'DBLP' }];
  return prisma.publication.create({
    data: {
      title,
      normalizedTitle: title.toLowerCase(),
      year: options.year === undefined ? 2020 : options.year,
      typeFamily,
      doi: options.doi === undefined ? `10.1000/p${n}` : options.doi,
      status: options.status ?? 'ACTIVE',
      isCurated: options.isCurated ?? false,
      sourceRecords: {
        create: records.map((r, i) => ({
          source: r.source,
          externalId: `${r.source}-${n}-${i}`,
          title: r.title ?? title,
          normalizedTitle: (r.title ?? title).toLowerCase(),
          doi: r.doi === undefined ? null : r.doi,
          year: r.year === undefined ? (options.year === undefined ? 2020 : options.year) : r.year,
          venue: r.venue ?? null,
          typeFamily,
          matchMethod: i === 0 ? 'NEW_PUBLICATION' : 'DOI',
          matchDetail: i === 0 ? 'No matching publication' : 'Matched on DOI',
          firstSeenAt: new Date(Date.UTC(2026, 0, 1 + i)),
          rawMetadata: { marker: 'raw-metadata-never-returned' },
        })),
      },
    },
  });
}

export async function professor(name: string, isActive = true) {
  return prisma.professor.create({ data: { name, isActive } });
}

export async function link(professorId: string, publicationId: string, status: VerificationStatus, extra: { decidedAt?: Date; decidedByUserId?: string } = {}) {
  return prisma.professorPublication.create({ data: { professorId, publicationId, status, origin: 'DISCOVERED', ...extra } });
}

export async function candidate(x: string, y: string, status: 'OPEN' | 'DISMISSED' | 'MERGED' = 'OPEN', reason = 'Exact title match blocked: test') {
  const [publicationAId, publicationBId] = x < y ? [x, y] : [y, x];
  return prisma.duplicateCandidate.create({ data: { publicationAId, publicationBId, status, reason } });
}

/** Every row of the tables merge/detach touch, for "nothing changed" checks. */
export async function snapshot() {
  return {
    publications: await prisma.publication.findMany({ orderBy: { id: 'asc' } }),
    records: await prisma.publicationSourceRecord.findMany({ orderBy: { id: 'asc' } }),
    relationships: await prisma.professorPublication.findMany({ orderBy: { id: 'asc' } }),
    candidates: await prisma.duplicateCandidate.findMany({ orderBy: { id: 'asc' } }),
  };
}

export async function withTrigger(table: string, timing: string, body: string, run: () => Promise<void>) {
  const name = 'phase13b_test_trigger';
  const [{ current_database: db }] = await prisma.$queryRaw<{ current_database: string }[]>`SELECT current_database()`;
  expect(db.endsWith('_test')).toBe(true);
  const drop = async () => {
    await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS ${name} ON ${table}`);
    await prisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS ${name}()`);
  };
  await drop();
  try {
    await prisma.$executeRawUnsafe(`CREATE FUNCTION ${name}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN ${body} END $$`);
    await prisma.$executeRawUnsafe(`CREATE TRIGGER ${name} ${timing} ON ${table} FOR EACH ROW EXECUTE FUNCTION ${name}()`);
    await run();
  } finally {
    await drop();
  }
}

/** A professor with a login account and a session cookie (the professor comes from the session). */
export async function professorSession(server: ReturnType<typeof createApp>, email: string) {
  const user = await createUser({ email, professor: 'active' });
  const prof = await prisma.professor.findUniqueOrThrow({ where: { userId: user.id } });
  const cookie = cookiePair(await request(server).post('/api/auth/login').send({ email, password: PASSWORD }), 'cse_session');
  return { user, prof, cookie };
}
