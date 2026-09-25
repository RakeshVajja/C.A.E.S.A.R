# CSE_Research_Hub — Project Progress

> Execution-status file. Architecture and requirements: `Project_plan.md` (authoritative). Implementation rules: `CLAUDE.md`.

## Current Phase

```text
Phase 2 — Minimal Database Foundation
STATUS: COMPLETE (schema verified and approved)

Next phase: Phase 3 — Matching & Deduplication Engine (NOT STARTED)
```

## Current Architecture Status

```text
Architecture:   FROZEN
Implementation: IN PROGRESS (Phases 1–2 done)
```

## Phase 2 Report

**Implemented**

* `backend/prisma/schema.prisma`: exactly the 9 core tables of `Project_plan.md` §6 with 12 enums, including `ProfessorPublication.discovered_via_identity_id` (nullable FK → `ExternalIdentity`, `ON DELETE SET NULL`).
* Physical conventions (decision #19): native `uuid` keys, `timestamptz(3)` timestamps, snake_case tables/columns.
* Constraints: unique `users.email`, `professors.user_id`, `external_identities(source, external_id)`, `publications.doi` (NULLs allowed), `publication_source_records(source, external_id)`, `professor_publications(professor_id, publication_id)`, `duplicate_candidates(publication_a_id, publication_b_id)`; hand-written CHECK `publication_a_id < publication_b_id`.
* Delete behaviour per plan §6.10 (Restrict for professors/publications, SET NULL for identity/user references, Cascade SyncRun → SyncTask).
* Indexes: normalized titles, year, source-record DOI, `(professor_id, status)`, all FK lookup columns, duplicate status, sync run start time.
* Migration `20260925102606_init_domain_schema` applied to the dev database; no drift (`prisma migrate diff` clean).
* Test database `cse_research_hub_test` (derived from `DATABASE_URL` + `_test`, created/migrated by `prisma migrate deploy` in Vitest global setup); helpers refuse to truncate any database not ending in `_test`.
* Idempotent development seed (`npm run db:seed`): 2 demo professors, 3 identities, 3 publications (one shared across OpenAlex/DBLP/ORCID, one preprint kept separate, one manual), 5 source records, 4 relationships (APPROVED/PENDING, DISCOVERED/MANUAL), 1 duplicate candidate. Refuses to run in production. No admin account (needs Phase 8 hashing).

**Validation**

* `typecheck` ✅, `build` ✅, `test` 33/33 ✅ (22 new schema tests against the real test database: uniqueness, multiple identities per source, NULL DOIs, shared canonical publication across 4 sources, in-source duplicates, per-professor statuses, `discovered_via_identity_id` SET NULL, Restrict deletes, candidate ordering CHECK, candidate survives merge, SyncRun cascade, task history kept).
* Seed run 3× with identical counts (idempotent) ✅; `prisma migrate status` up to date ✅.

**Known limitations / open items**

* `match_method` enum values (`DOI`, `TITLE_YEAR`, `NEW_PUBLICATION`, `ADMIN`) are an initial set; Phase 3 may extend them via migration.
* Test database tests run files sequentially (`fileParallelism: false`) because they share one database.

## Phase 1 Report

**Implemented**

* Backend
  * Express upgraded 4 → 5 (now consistent with `@types/express` 5).
  * App/server split: `src/app.ts` (`createApp`, testable) and `src/index.ts` (listen, graceful shutdown).
  * Zod-validated environment (`src/config/env.ts`): fails fast on missing/invalid `DATABASE_URL`, `PORT`, `NODE_ENV`, `CORS_ORIGIN`.
  * Standard error shape `{ error: { code, message, details? } }` for 404, 4xx (e.g. malformed JSON) and 500; `x-powered-by` disabled.
  * `/api/health` returns 503 when the database is unreachable and exposes raw DB errors only in development.
  * Prisma query logging reduced to warn/error.
  * Testing foundation: Vitest + Supertest, `tests/` directory, 11 tests.
  * Scripts: `dev`, `build` (via `tsconfig.build.json`), `start`, `typecheck`, `test`, `test:watch`; `engines.node >= 20.9`.
  * Placeholder `SystemHealth` model and its migration removed; `schema.prisma` now contains only generator/datasource.
* Frontend
  * Placeholder page with stale claims ("Phase 1 Complete", "14 phases") replaced by a minimal page + backend-status client component.
  * `NEXT_PUBLIC_API_URL` read through `src/lib/config.ts`; layout uses theme tokens; unused create-next-app assets and README removed/replaced.
  * `typecheck` script and `engines.node >= 20.9` added.
* Repository
  * Root `README.md` (setup and checks), `.gitignore` updated, `.claude/launch.json` (dev servers), Git repository initialized (nothing committed).

**Validation**

* Backend: `typecheck` ✅, `test` 11/11 ✅, `build` ✅; real run against local PostgreSQL: `/api/health` 200, unknown route 404 in the error shape, SIGINT shutdown clean; invalid env exits with a readable message ✅.
* Frontend: `lint` ✅, `typecheck` ✅, `build` ✅; dev server renders the page; backend CORS allows the frontend origin with credentials ✅.

**Known limitations / open items**

* ~~Old `system_health` table left in the dev database~~ — resolved: dev database reset with user consent; it now has no application tables and no migrations, ready for Phase 2.
* `npm audit` reports a high-severity advisory in `deepmerge-ts`, a transitive dependency of the Prisma 6 **CLI** (dev tool only, not shipped at runtime). No fix exists within Prisma 6; accepted, revisit if Prisma 6 publishes a patch.
* The browser-side health check was verified via server logs and CORS headers, not visually (the in-app browser could not open localhost).
* ~~No separate test database yet~~ — resolved in Phase 2.

## Phase Roadmap

| Phase | Name | Objective | Status |
|---|---|---|---|
| 0 | Requirements & Architecture Freeze | Finalize requirements, scope, architecture, API assumptions, matching rules and schema decisions | **COMPLETE** |
| 1 | Minimal Project Setup | Clean foundation: repo structure, config cleanup, env validation, Express/TypeScript consistency, health, testing foundation | **COMPLETE** (pending review) |
| 2 | Minimal Database Foundation | Implement the 9-table model with relationships, constraints, indexes, migration and dev seed | **COMPLETE** (approved) |
| 3 | Matching & Deduplication Engine | Normalization, type families, preprint detection, deterministic matching, vetoes, DuplicateCandidate, canonical metadata selection | NOT STARTED |
| 4 | OpenAlex Integration | Identity validation, cursor pagination, response validation, mapping into the pipeline | NOT STARTED |
| 5 | DBLP Integration | SPARQL client, mapping, response validation, throttling, failure handling | NOT STARTED |
| 6 | ORCID Integration | v3.0 works retrieval, JSON handling, put-code source records, failure handling | NOT STARTED |
| 7 | Core Pipeline Testing & Audit | Test the full multi-source pipeline against all required cases | NOT STARTED |
| 8 | Authentication | Roles, JWT in HTTP-only cookie, hashing, temporary password, forced change, route protection | NOT STARTED |
| 9 | Professor Management | Professors, profiles, external identities, activation/deactivation | NOT STARTED |
| 10 | Verification Workflow | PENDING/APPROVED/REJECTED, reversible rejection, ownership | NOT STARTED |
| 11 | Manual Publication Addition | Manual entries through the same pipeline, with match/candidate tests | NOT STARTED |
| 12 | Synchronization | SyncRun/SyncTask, node-cron, single-run guard, retries, idempotency, last-seen tracking | NOT STARTED |
| 13 | Analytics | Required admin statistics following the preprint policy | NOT STARTED |
| 14 | Frontend Integration | Admin and professor workflows in the UI | NOT STARTED |
| 15 | Final Testing & Deployment | End-to-end tests, security checks, production config, deployment, demo readiness | NOT STARTED |

## Frozen Decisions (summary)

* **Data model:** exactly 9 core tables — User, Professor, ExternalIdentity, Publication, PublicationSourceRecord, ProfessorPublication, DuplicateCandidate, SyncRun, SyncTask.
* **`ProfessorPublication.discovered_via_identity_id`:** nullable FK to ExternalIdentity, for cleanup of PENDING links from incorrect identities. No `SourceRecordProfessor`.
* **Matching:** deterministic — source+ID → DOI (with contradiction checks) → exact normalized title + year ±1 only when both years are known and the type families are compatible (same known family) → otherwise DuplicateCandidate or new Publication. Vetoes: different DOIs, preprint vs published, incompatible known types, generic/short titles.
* **Type families:** PREPRINT, CONFERENCE, JOURNAL, BOOK_CHAPTER, BOOK, OTHER (OpenAlex type combined with source/venue type).
* **Preprints:** kept separate; not auto-merged with published versions; excluded from default analytics.
* **Metadata priority:** CURATED → OpenAlex → DBLP → ORCID → MANUAL; `is_curated` protects admin edits; no field-level provenance.
* **Manual publications:** same pipeline; type required; never silently duplicated; DuplicateCandidate preferred over unsafe merge.
* **API response validation:** HTTP 200 is not success; HTML/malformed/error/invalid responses are fetch failures, never "zero publications".
* **OpenAlex:** validate the author identity first, cursor pagination, `per-page=100`, `select=`, retry/backoff.
* **DBLP:** SPARQL endpoint only; not pid XML, search API or mirrors; isolated client.
* **ORCID:** public API v3.0 works, JSON via `Accept` header, put-code source records, `self` identifiers only.
* **Sync:** SyncRun → SyncTask per identity; fetch → validate → normalize → match → write; one run at a time (application guard); idempotent; no deletes on missing records; node-cron is only the scheduler.
* **Excluded:** AI/ML/LLM matching, embeddings, `pg_trgm`, Redis/BullMQ, microservices, GraphQL, Author table, citation graph, full paper/PDF/abstract storage, Docker/Kubernetes, OAuth/SSO, refresh tokens, hard professor deletion (initially).

## Deferred Decisions

Kept explicitly deferred (see `Project_plan.md` §20): fuzzy matching; exact DOI-contradiction criteria, generic-title list and minimum title length; advisory locking; startup catch-up sync; exact monthly schedule; analytics treatment of `OTHER`; ORCID client registration; hard professor deletion; deployment provider.

## Progress Rules

1. Only one implementation phase is active at a time.
2. Complete and validate the current phase before starting the next.
3. Do not silently skip phases.
4. Update this file after each completed phase.
5. Do not mark a phase complete without relevant validation/tests.
6. If a genuine blocker requires an architectural change, stop and report it.
7. Deferred decisions must remain explicitly marked as deferred.
8. The phase order should not be changed unless a genuine dependency requires it.

## Decision Log

| # | Date | Decision | Basis |
|---|---|---|---|
| 1 | 2026-09-25 | Stack kept: Next.js + Express + TypeScript + PostgreSQL + Prisma 6; add Zod, Vitest, Supertest, native fetch, Git | Stack audit |
| 2 | 2026-09-25 | 9-table data model frozen; `SourceRecordProfessor` and `Author` discarded | Architecture review |
| 3 | 2026-09-25 | `ProfessorPublication.discovered_via_identity_id` added (nullable FK) | Live evidence of split/misattributed OpenAlex author profiles |
| 4 | 2026-09-25 | `MANUAL` is a source type; manual type family required | Architecture review |
| 5 | 2026-09-25 | Metadata priority CURATED → OpenAlex → DBLP → ORCID → MANUAL | Architecture review; MANUAL as final fallback |
| 6 | 2026-09-25 | Deterministic matching rules and vetoes frozen; fuzzy matching deferred | Architecture review; live data (DOI conflicts common among same-title records) |
| 7 | 2026-09-25 | Type families combine OpenAlex `type` with source/venue type; unknown/OTHER never auto-merges by title | Live evidence: OpenAlex labels conference papers `article` |
| 8 | 2026-09-25 | Preprints kept separate; per-source detection (DBLP Informal/CoRR, OpenAlex preprint/10.48550/repository, ORCID preprint) | Live evidence: DBLP CoRR records lack DOIs and share titles/years with published versions |
| 9 | 2026-09-25 | Rule 3 does not auto-merge when a year is missing (becomes a DuplicateCandidate) | Clarification under "insufficient information → candidate"; confirmed at the pre-Phase-1 consistency gate |
| 10 | 2026-09-25 | HTTP 200 is not success; response validation is mandatory | Live evidence: DBLP bot-protection HTML with 200; OpenAlex empty 200 for nonexistent IDs |
| 11 | 2026-09-25 | DBLP accessed via SPARQL endpoint only | Live evidence: pid XML, search API and mirrors return bot-protection pages |
| 12 | 2026-09-25 | Professors deactivated, not hard-deleted; admin "delete" of publications = suppression | Architecture review |
| 13 | 2026-09-25 | One sync at a time via application guard; advisory lock and Redis/BullMQ not used | Architecture review |
| 14 | 2026-09-25 | Auth: JWT in HTTP-only SameSite=Lax cookie, bcrypt/bcryptjs, admin-created accounts with forced password change; no OAuth/refresh tokens | Architecture review |
| 15 | 2026-09-25 | Final 16-phase order (0–15) adopted; Phase 0 complete | Architecture freeze |
| 16 | 2026-09-25 | Documentation consistency gate passed; wording aligned (both-years-known rule, rejection never reopens, valid-empty vs failed fetch, last-seen after successful processing) — no decision changed | Pre-Phase-1 consistency gate |
| 17 | 2026-09-25 | Phase 1 tooling versions: Express 5, Zod 4, Vitest 5, Supertest 7 (Prisma stays 6.x) | Phase 1 — Express 5 resolves the types mismatch; Vitest 5 resolves a Vitest ≤4 security advisory |
| 18 | 2026-09-25 | Standard API error shape `{ error: { code, message, details? } }` implemented | Project_plan.md §15.3 |
| 19 | 2026-09-25 | Physical schema conventions: UUID keys (`uuid`), `timestamptz`, snake_case DB names (previously deferred) | Decided by the user at the start of Phase 2 |
| 20 | 2026-09-25 | Delete details: Restrict professor/publication deletes; `DuplicateCandidate` FKs SET NULL + ordered-pair CHECK; user references SET NULL | Phase 2 — implements plan §6.10 / §8.5 without new tables; approved after schema-only verification |

Superseded/rejected (kept for history): per-source `SyncJob` table (replaced by SyncRun/SyncTask); `SourceRecordProfessor` table (rejected; replaced by `discovered_via_identity_id`); repository layer (rejected); DBLP pid-XML/search/mirror access (rejected); MANUAL outranking API metadata (rejected); Levenshtein/`pg_trgm` fuzzy thresholds (rejected for now; fuzzy matching deferred); advisory-lock requirement (deferred).
