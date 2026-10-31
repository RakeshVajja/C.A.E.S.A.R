import type { PublicationSource } from '@prisma/client';
import { prisma } from '../../src/config/database';
import { JcrClient } from '../../src/integrations/jcr/client';
import { ingestPublication } from '../../src/services/matching/engine';
import { buildNormalizedPublication } from '../../src/services/normalization/normalizedPublication';
import { noSleep, replayFetch, type RecordedResponse, type Route } from '../helpers/fixtures';
import * as jcr from '../fixtures/jcr/synthetic';
import { OPEN_CLARIVATE_GATE } from '../helpers/providers';

/**
 * A synthetic JCR world for stage 15.6 tests: three journals (A with print, electronic and previous
 * ISSNs; B and C sharing one ISSN), an ISSN JCR does not know, and an ISSN whose free-text search
 * returns an unrelated journal.
 */
export const { ISSN } = jcr;

export function jcrResponses(options: { a2021Jif?: string } = {}): RecordedResponse[] {
  return [
    jcr.lastUpdated(),
    jcr.search(ISSN.A_PRINT, ['SYNTH_A']),
    jcr.search(ISSN.A_ONLINE, ['SYNTH_A']),
    jcr.search(ISSN.A_PREVIOUS, ['SYNTH_A']),
    jcr.search(ISSN.B_PRINT, ['SYNTH_B']),
    jcr.search(ISSN.SHARED, ['SYNTH_B', 'SYNTH_C']),
    jcr.search(ISSN.C_PRINT, ['SYNTH_C']),
    jcr.search(ISSN.NOT_IN_JCR, []),
    jcr.search(ISSN.D_PRINT, ['SYNTH_A']), // free-text hit whose ISSNs do not include the searched one
    jcr.journalRecord({ id: 'SYNTH_A', name: 'Synthetic Journal A', issn: ISSN.A_PRINT, eIssn: ISSN.A_ONLINE, previousIssn: [ISSN.A_PREVIOUS], reportYears: [2019, 2020, 2021, 2022] }),
    jcr.history('SYNTH_A', [{ issn: ISSN.A_PRINT, start: 2005, end: 2022 }, { issn: ISSN.A_PREVIOUS, start: 2001, end: 2004 }]),
    jcr.journalRecord({ id: 'SYNTH_B', name: 'Synthetic Journal B', issn: ISSN.B_PRINT, eIssn: ISSN.SHARED }),
    jcr.history('SYNTH_B'),
    jcr.journalRecord({ id: 'SYNTH_C', name: 'Synthetic Journal C', issn: ISSN.C_PRINT, eIssn: ISSN.SHARED }),
    jcr.history('SYNTH_C'),
    ...[2019, 2020, 2021, 2022].map((year) => jcr.report('SYNTH_A', year, year === 2021 && options.a2021Jif ? { jif: options.a2021Jif } : {})),
    ...[2020, 2021, 2022].flatMap((year) => [jcr.report('SYNTH_B', year), jcr.report('SYNTH_C', year)]),
  ];
}

export function jcrClient(recorded: RecordedResponse[] = jcrResponses(), overrides: Record<string, Route> = {}) {
  const replay = replayFetch(recorded, overrides);
  return { client: new JcrClient({ gate: OPEN_CLARIVATE_GATE, apiKey: jcr.API_KEY, http: { maxRetries: 0 }, deps: { fetchImpl: replay.fetchImpl, sleep: noSleep } }), calls: replay.calls };
}

/** A publication from one source record with these ISSNs. */
export async function publication(source: PublicationSource, externalId: string, fields: { title: string; year?: number | null; issns?: string[]; doi?: string; rawMetadata?: unknown }) {
  return ingestPublication(
    buildNormalizedPublication({
      source,
      externalId,
      title: fields.title,
      dois: fields.doi ? [fields.doi] : [],
      year: fields.year === undefined ? 2021 : fields.year,
      typeFamily: 'JOURNAL',
      issns: fields.issns ?? [],
      rawMetadata: fields.rawMetadata ?? { synthetic: true },
    }),
  );
}

/**
 * The publications of the world:
 *   p1 (A print, 2021) and p2 (A electronic, 2020) → journal A
 *   p3 (the shared ISSN) → ambiguous (B and C); p4 (B's and C's print ISSNs on two records) → ambiguous
 *   p5 (an ISSN JCR does not know), p6 (an ISSN whose search hit does not carry it), p7 (no ISSN) → unlinked
 */
export async function publications() {
  const p1 = await publication('OPENALEX', 'W1', { title: 'Synthetic paper one in journal A', year: 2021, issns: [ISSN.A_PRINT] });
  const p2 = await publication('SCOPUS', '2-s2.0-2', { title: 'Synthetic paper two in journal A', year: 2020, issns: [ISSN.A_ONLINE] });
  const p3 = await publication('WOS', 'WOS:000000000000003', { title: 'Synthetic paper three with a shared ISSN', issns: [ISSN.SHARED] });
  const p4 = await publication('OPENALEX', 'W4', { title: 'Synthetic paper four in two journals', issns: [ISSN.B_PRINT], doi: '10.5555/jcr.4' });
  await publication('ORCID', '0009-0000-0000-0017:4', { title: 'Synthetic paper four in two journals', issns: [ISSN.C_PRINT], doi: '10.5555/jcr.4' });
  const p5 = await publication('OPENALEX', 'W5', { title: 'Synthetic paper five outside JCR', issns: [ISSN.NOT_IN_JCR] });
  const p6 = await publication('OPENALEX', 'W6', { title: 'Synthetic paper six with a false search hit', issns: [ISSN.D_PRINT] });
  const p7 = await publication('DBLP', 'journals/x/Seven', { title: 'Synthetic paper seven without ISSN' });
  return { p1, p2, p3, p4, p5, p6, p7 };
}

export async function journalOf(publicationId: string) {
  return (await prisma.publication.findUniqueOrThrow({ where: { id: publicationId }, include: { journal: true } })).journal;
}

/** A JOURNAL_METRICS run and task for a journal, as the engine creates them. */
export async function journalTask(journalId: string) {
  const run = await prisma.syncRun.create({
    data: { kind: 'JOURNAL_METRICS', trigger: 'MANUAL', status: 'RUNNING', tasks: { create: [{ kind: 'JOURNAL_METRICS', journalId, status: 'RUNNING' }] } },
    include: { tasks: true },
  });
  return run.tasks[0].id;
}
