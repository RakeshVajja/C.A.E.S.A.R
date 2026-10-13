import request from 'supertest';
import { createApp } from '../../src/app';
import { prisma } from '../../src/config/database';
import { DblpClient } from '../../src/integrations/dblp/client';
import { OpenAlexClient } from '../../src/integrations/openalex/client';
import { OrcidClient } from '../../src/integrations/orcid/client';
import type { IdentityClients } from '../../src/services/identities/identities';
import { cookiePair, createUser, PASSWORD } from '../auth/helpers';
import { loadFixture, noSleep, replayFetch, Route } from '../helpers/fixtures';

/** Identity-preview clients that replay recorded responses (no network). */
export function replayIdentityClients(overrides: Record<string, Route> = {}) {
  const recorded = [
    ...['author-valid', 'author-not-found', 'author-merged-documented'].map((n) => loadFixture('openalex', n)),
    ...['identity-person', 'identity-ambiguous', 'identity-missing'].map((n) => loadFixture('dblp', n)),
    ...['works-vardi', 'works-carberry', 'works-not-found', 'works-deactivated', 'person-vardi', 'person-carberry', 'person-not-found'].map(
      (n) => loadFixture('orcid', n),
    ),
  ];
  const replay = replayFetch(recorded, overrides);
  const deps = { fetchImpl: replay.fetchImpl, sleep: noSleep };
  const http = { timeoutMs: 1_000, maxRetries: 1 };
  const clients: IdentityClients = {
    openAlex: new OpenAlexClient({ deps, http }),
    dblp: new DblpClient({ deps, http }),
    orcid: new OrcidClient({ deps, http }),
  };
  return { clients, calls: replay.calls };
}

export function adminApp(options: { overrides?: Record<string, Route>; now?: () => Date } = {}) {
  const { clients, calls } = replayIdentityClients(options.overrides);
  return { server: createApp({ mailer: null, identityClients: clients, now: options.now }), calls };
}

/** An administrator session cookie for `server`. */
export async function adminCookie(server: ReturnType<typeof createApp>, email = 'admin@example.org') {
  await createUser({ email, role: 'ADMIN' });
  const res = await request(server).post('/api/auth/login').send({ email, password: PASSWORD });
  return cookiePair(res, 'cse_session');
}

export async function login(server: ReturnType<typeof createApp>, email: string, password: string) {
  return request(server).post('/api/auth/login').send({ email, password });
}

/** Row counts of all nine tables. */
export async function tableCounts() {
  return {
    users: await prisma.user.count(),
    professors: await prisma.professor.count(),
    identities: await prisma.externalIdentity.count(),
    publications: await prisma.publication.count(),
    sourceRecords: await prisma.publicationSourceRecord.count(),
    links: await prisma.professorPublication.count(),
    candidates: await prisma.duplicateCandidate.count(),
    syncRuns: await prisma.syncRun.count(),
    syncTasks: await prisma.syncTask.count(),
  };
}
