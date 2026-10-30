/**
 * Developer/demo runner for the publication discovery pipeline (development database only).
 *
 * It calls the existing discovery services unchanged (discoverOpenAlexIdentity / discoverDblpIdentity /
 * discoverOrcidIdentity → Phase 3 matching engine) and then only READS the database to explain the
 * result. It contains no matching logic of its own.
 *
 *   npm run demo -- --list
 *   npm run demo -- --add "Moshe Y. Vardi" --openalex A5000059818 --dblp v/MosheYVardi --orcid 0000-0002-0661-5773
 *   npm run demo -- --professor "Moshe Y. Vardi"            # run discovery for all its identities, then report
 *   npm run demo -- --professor "Moshe Y. Vardi" --report   # report only (no API calls)
 *   npm run demo -- --identity <identity-id>                # run one identity, then report its professor
 *   options: --limit <n> (cross-source examples shown, default 10), --all (list every publication)
 *
 * Live runs call the real public APIs and write to the development database; automated tests never run this.
 */
import type { ExternalIdentity, IdentitySource } from '@prisma/client';
import { prisma } from '../src/config/database';
import { env } from '../src/config/env';
import { FetchError } from '../src/integrations/http/httpClient';
import { discoverDblpIdentity } from '../src/services/discovery/dblpDiscovery';
import type { DiscoverySummary } from '../src/services/discovery/ingestDiscoveredRecords';
import { discoverOpenAlexIdentity } from '../src/services/discovery/openAlexDiscovery';
import { discoverOrcidIdentity } from '../src/services/discovery/orcidDiscovery';

type Args = Map<string, string | true>;

function parseArgs(argv: string[]): Args {
  const args: Args = new Map();
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) continue;
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) {
      args.set(argv[i].slice(2), next);
      i++;
    } else {
      args.set(argv[i].slice(2), true);
    }
  }
  return args;
}

const str = (args: Args, key: string) => (typeof args.get(key) === 'string' ? (args.get(key) as string) : undefined);

const DISCOVER: Record<IdentitySource, (identityId: string) => Promise<DiscoverySummary>> = {
  OPENALEX: (id) => discoverOpenAlexIdentity(id),
  DBLP: (id) => discoverDblpIdentity(id),
  ORCID: (id) => discoverOrcidIdentity(id),
  // Scopus and Web of Science discovery arrive in Phase 15.3/15.4.
  SCOPUS: () => Promise.reject(new Error('Scopus discovery is not available yet (Phase 15.3)')),
  WOS: () => Promise.reject(new Error('Web of Science discovery is not available yet (Phase 15.4)')),
};

const METHOD_LABEL: Record<string, string> = {
  NEW_PUBLICATION: 'first record (created the publication)',
  DOI: 'matched by DOI',
  TITLE_YEAR: 'matched by exact title + year',
  ADMIN: 'attached by admin',
};

function line(char = '─', width = 78): string {
  return char.repeat(width);
}

async function listProfessors(): Promise<void> {
  const professors = await prisma.professor.findMany({ include: { identities: true }, orderBy: { name: 'asc' } });
  if (professors.length === 0) console.log('No professors yet. Add one with --add (see the header of this script).');
  for (const p of professors) {
    console.log(`${p.name}${p.isActive ? '' : ' (inactive)'}`);
    for (const i of p.identities) {
      console.log(`   ${i.source.padEnd(8)} ${i.externalId.padEnd(22)} identity ${i.id}${i.isActive ? '' : ' (inactive)'}`);
    }
  }
}

async function addProfessor(args: Args): Promise<void> {
  const name = str(args, 'add');
  if (!name) throw new Error('--add needs a professor name');
  const identities: Array<[IdentitySource, string | undefined]> = [
    ['OPENALEX', str(args, 'openalex')],
    ['DBLP', str(args, 'dblp')],
    ['ORCID', str(args, 'orcid')],
  ];
  const professor =
    (await prisma.professor.findFirst({ where: { name } })) ?? (await prisma.professor.create({ data: { name, department: 'CSE' } }));
  for (const [source, externalId] of identities) {
    if (!externalId) continue;
    const existing = await prisma.externalIdentity.findUnique({ where: { source_externalId: { source, externalId } } });
    if (existing && existing.professorId !== professor.id) {
      throw new Error(`${source} ${externalId} already belongs to another professor`);
    }
    if (!existing) {
      await prisma.externalIdentity.create({ data: { professorId: professor.id, source, externalId, verifiedAt: new Date() } });
    }
  }
  console.log(`Professor "${name}" ready (id ${professor.id}).`);
  await listProfessors();
}

async function runDiscovery(identities: ExternalIdentity[]): Promise<void> {
  console.log(line('═'));
  console.log('DISCOVERY (existing pipeline: validate → fetch → normalize → match → write)');
  console.log(line('═'));
  // OpenAlex first, then DBLP, then ORCID — the order does not change the final canonical metadata (§9).
  const order: IdentitySource[] = ['OPENALEX', 'DBLP', 'ORCID'];
  for (const identity of [...identities].sort((a, b) => order.indexOf(a.source) - order.indexOf(b.source))) {
    const started = Date.now();
    process.stdout.write(`${identity.source.padEnd(8)} ${identity.externalId.padEnd(22)} … `);
    try {
      const s = await DISCOVER[identity.source](identity.id);
      console.log(
        `ok in ${((Date.now() - started) / 1000).toFixed(1)}s — fetched ${s.recordsFetched}, new source records ${s.recordsNew}, ` +
          `updated ${s.recordsUpdated}, skipped ${s.recordsSkipped}, new links ${s.linksCreated}, new duplicate candidates ${s.candidatesCreated}`,
      );
      for (const warning of s.warnings.slice(0, 3)) console.log(`         warning: ${warning}`);
      if (s.warnings.length > 3) console.log(`         … ${s.warnings.length - 3} more warnings`);
    } catch (error) {
      if (error instanceof FetchError) {
        console.log(`FAILED (${error.kind}) — nothing written: ${error.message}`);
      } else {
        console.log(`FAILED — ${(error as Error).message}`);
      }
    }
  }
}

async function report(professorId: string, limit: number, showAll: boolean): Promise<void> {
  const professor = await prisma.professor.findUniqueOrThrow({ where: { id: professorId }, include: { identities: true } });
  const links = await prisma.professorPublication.findMany({
    where: { professorId },
    include: {
      publication: {
        include: { sourceRecords: { orderBy: [{ source: 'asc' }, { externalId: 'asc' }] } },
      },
    },
  });
  const publications = links.map((l) => ({ ...l.publication, linkStatus: l.status }));
  const records = publications.flatMap((p) => p.sourceRecords);

  const bySource = new Map<string, number>();
  for (const r of records) bySource.set(r.source, (bySource.get(r.source) ?? 0) + 1);
  const byMethod = new Map<string, number>();
  for (const r of records) byMethod.set(r.matchMethod, (byMethod.get(r.matchMethod) ?? 0) + 1);
  const sourcesOf = (p: (typeof publications)[number]) => [...new Set(p.sourceRecords.map((r) => r.source))];
  const crossSource = publications.filter((p) => sourcesOf(p).length > 1);
  const sourceCombos = new Map<string, number>();
  for (const p of crossSource) {
    const key = sourcesOf(p).sort().join(' + ');
    sourceCombos.set(key, (sourceCombos.get(key) ?? 0) + 1);
  }
  const families = new Map<string, number>();
  for (const p of publications) families.set(p.typeFamily, (families.get(p.typeFamily) ?? 0) + 1);

  console.log(line('═'));
  console.log(`REPORT — ${professor.name}`);
  console.log(line('═'));
  console.log(`Identities: ${professor.identities.map((i) => `${i.source} ${i.externalId}`).join(' | ') || 'none'}`);
  console.log(`Source records (as reported by each source): ${records.length}`);
  for (const [source, n] of [...bySource].sort()) console.log(`   ${source.padEnd(8)} ${n}`);
  console.log(`Canonical publications linked to the professor: ${publications.length}`);
  console.log(`   found in 2+ sources (cross-source matches): ${crossSource.length}`);
  for (const [combo, n] of [...sourceCombos].sort((a, b) => b[1] - a[1])) console.log(`      ${combo.padEnd(26)} ${n}`);
  console.log(`   by type family: ${[...families].sort((a, b) => b[1] - a[1]).map(([f, n]) => `${f} ${n}`).join(', ')}`);
  console.log(`How source records were attached:`);
  for (const method of ['NEW_PUBLICATION', 'DOI', 'TITLE_YEAR', 'ADMIN']) {
    if (byMethod.get(method)) console.log(`   ${String(byMethod.get(method)).padStart(5)}  ${METHOD_LABEL[method]}`);
  }
  const statuses = new Map<string, number>();
  for (const l of links) statuses.set(l.status, (statuses.get(l.status) ?? 0) + 1);
  console.log(`Professor verification: ${[...statuses].map(([s, n]) => `${s} ${n}`).join(', ')}`);

  const printPublication = (p: (typeof publications)[number]) => {
    console.log(line());
    console.log(`${p.title}`);
    console.log(
      `   year ${p.year ?? '—'} | DOI ${p.doi ?? '—'} | ${p.typeFamily} | sources: ${sourcesOf(p).join(', ')}` +
        `${p.status === 'SUPPRESSED' ? ' | SUPPRESSED' : ''} | professor link: ${p.linkStatus}`,
    );
    for (const r of p.sourceRecords) {
      console.log(
        `   • ${r.source.padEnd(8)} ${r.externalId.slice(0, 40).padEnd(40)} ${r.year ?? '—'}  ${r.typeFamily.padEnd(12)} ` +
          `${METHOD_LABEL[r.matchMethod] ?? r.matchMethod}${r.matchMethod === 'NEW_PUBLICATION' ? '' : ` — ${r.matchDetail ?? ''}`}`,
      );
    }
  };

  console.log(line('═'));
  const shown = showAll ? publications : crossSource;
  console.log(showAll ? `ALL PUBLICATIONS (${publications.length})` : `CROSS-SOURCE MATCHES (showing ${Math.min(limit, crossSource.length)} of ${crossSource.length})`);
  // Show a mix: title/year matches first (the interesting ones), then DOI matches.
  const rank = (p: (typeof publications)[number]) => (p.sourceRecords.some((r) => r.matchMethod === 'TITLE_YEAR') ? 0 : 1);
  for (const p of [...shown].sort((a, b) => rank(a) - rank(b) || (b.year ?? 0) - (a.year ?? 0)).slice(0, showAll ? undefined : limit)) {
    printPublication(p);
  }

  const ids = publications.map((p) => p.id);
  const candidates = await prisma.duplicateCandidate.findMany({
    where: { status: 'OPEN', OR: [{ publicationAId: { in: ids } }, { publicationBId: { in: ids } }] },
    include: {
      publicationA: { include: { sourceRecords: true } },
      publicationB: { include: { sourceRecords: true } },
    },
  });
  console.log(line('═'));
  console.log(`DUPLICATE CANDIDATES — possible matches that were NOT merged automatically (${candidates.length} open)`);
  const describe = (p: (typeof candidates)[number]['publicationA']) =>
    p ? `"${p.title.slice(0, 60)}" (${p.year ?? '—'}, ${p.typeFamily}, ${[...new Set(p.sourceRecords.map((r) => r.source))].join('+')})` : '(removed)';
  for (const c of candidates.slice(0, limit)) {
    console.log(line());
    console.log(`   A: ${describe(c.publicationA)}`);
    console.log(`   B: ${describe(c.publicationB)}`);
    console.log(`   why not merged: ${c.reason}`);
  }
  if (candidates.length > limit) console.log(`   … ${candidates.length - limit} more (use --limit)`);
  console.log(line('═'));
}

async function main(): Promise<void> {
  if (env.nodeEnv === 'production') throw new Error('The demo runner is for the development database only');
  const args = parseArgs(process.argv.slice(2));
  const limit = Number(str(args, 'limit') ?? 10);
  const showAll = args.has('all');

  if (args.has('list')) return listProfessors();
  if (args.has('add')) return addProfessor(args);

  let professorId: string;
  let identities: ExternalIdentity[];
  const identityId = str(args, 'identity');
  const professorName = str(args, 'professor');
  if (identityId) {
    const identity = await prisma.externalIdentity.findUniqueOrThrow({ where: { id: identityId } });
    professorId = identity.professorId;
    identities = [identity];
  } else if (professorName) {
    const professor = await prisma.professor.findFirst({ where: { name: professorName }, include: { identities: true } });
    if (!professor) throw new Error(`No professor named "${professorName}" (see --list)`);
    professorId = professor.id;
    identities = professor.identities.filter((i) => i.isActive);
  } else {
    console.log('Usage: see the header of scripts/demo-discovery.ts (e.g. npm run demo -- --list)');
    return;
  }

  if (!args.has('report')) await runDiscovery(identities);
  await report(professorId, limit, showAll);
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
