// Automated tests must never call live external APIs (Project_plan.md §18, CLAUDE.md).
// Any code path that falls back to the global fetch fails loudly; tests inject recorded fixtures.
globalThis.fetch = (async (input: string | URL | Request) => {
  throw new Error(`Live network access is disabled in tests (attempted: ${String(input)})`);
}) as typeof fetch;
