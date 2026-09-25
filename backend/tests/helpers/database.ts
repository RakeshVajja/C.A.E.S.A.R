import { prisma } from '../../src/config/database';

const TABLES = [
  'sync_tasks',
  'sync_runs',
  'duplicate_candidates',
  'professor_publications',
  'publication_source_records',
  'publications',
  'external_identities',
  'professors',
  'users',
];

/** Empties every domain table. Refuses to run outside a *_test database. */
export async function resetDatabase(): Promise<void> {
  const [{ current_database: name }] = await prisma.$queryRaw<{ current_database: string }[]>`SELECT current_database()`;
  if (!name.endsWith('_test')) {
    throw new Error(`Refusing to truncate tables in non-test database "${name}"`);
  }
  await prisma.$executeRawUnsafe(`TRUNCATE ${TABLES.map((t) => `"${t}"`).join(', ')} CASCADE`);
}
