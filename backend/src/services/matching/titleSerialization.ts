/**
 * One-at-a-time processing per normalized title (decisions #80, #84). Every ingestion path —
 * professor manual entries and synchronization/discovery — runs each record's ingest through
 * `serializeByTitle`, so two records with the same normalized title are matched one after the
 * other: the second sees the first and matches it (or records a DuplicateCandidate) instead of
 * both creating a publication. Records with a DOI are additionally protected by the unique
 * canonical DOI and the engine's retry. Matching rules are unchanged; only ordering is affected.
 *
 * The queue lives in this backend process: several backend instances (not planned) would not
 * share it (§20 keeps PostgreSQL advisory locking deferred).
 */

const queues = new Map<string, Promise<unknown>>();

export async function serializeByTitle<T>(normalizedTitle: string, run: () => Promise<T>): Promise<T> {
  const previous = queues.get(normalizedTitle) ?? Promise.resolve();
  const current = previous.then(run, run);
  const settled = current.then(
    () => undefined,
    () => undefined,
  );
  queues.set(normalizedTitle, settled);
  try {
    return await current;
  } finally {
    if (queues.get(normalizedTitle) === settled) queues.delete(normalizedTitle);
  }
}
