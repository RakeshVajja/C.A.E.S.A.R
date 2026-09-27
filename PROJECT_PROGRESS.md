# CSE_Research_Hub — Project Progress

> Execution-status file. Architecture and requirements: `Project_plan.md` (authoritative). Implementation rules: `CLAUDE.md`.

## Current Phase

```text
Phase 3 — Matching & Deduplication Engine
STATUS: COMPLETE (verified and approved)

Next phase: Phase 4 — OpenAlex Integration (NOT STARTED)
```

## Current Architecture Status

```text
Architecture:   FROZEN
Implementation: IN PROGRESS (Phases 1–3 done)
```

## Phase 3 Report

**Implemented** (`backend/src`)

* `services/normalization/` — shared DOI normalization (§7.1), title normalization (§7.2), raw-metadata sanitizer (drops abstracts, references, full text at any depth), `NormalizedPublication` builder (§7) used by all future mappers and manual entry.
* `integrations/{openalex,dblp,orcid}/typeFamily.ts` — per-source type-family mapping and preprint detection (§7.3/§7.4); pure functions only, no HTTP (Phases 4–6 add clients and mappers).
* `services/matching/`
  * `titleEligibility.ts` — generic-title list, prefixes, minimum length (decision #23).
  * `rules.ts` — pure rule-2 contradiction checks (decision #22) and rule-3 title/year/type/DOI vetoes.
  * `canonical.ts` — canonical metadata selection CURATED → OpenAlex → DBLP → ORCID → MANUAL (§9, decision #26).
  * `engine.ts` — transactional `ingestPublication()`: rule 1 update-in-place, rule 2 DOI (canonical-owner precedence, decision #27), rule 3 exact title + year ±1, rule 4 new publication + `DuplicateCandidate`s; records `match_method`/`match_detail`; never moves a source record on DOI change; never reopens a dismissed candidate; curated publications never recomputed. All DOIs of a record are stored in `raw_metadata._normalizedDois` and secondary DOIs are searched (§6.5, decision #28). SUPPRESSED publications absorb matching records as provenance only; `IngestResult.publicationStatus` lets later phases skip professor links for them (decision #30). Does not create professor relationships (Phase 4 / Phase 11).
* Schema correction (decision #21): nullable `publication_source_records.author_names_display` (migration `add_source_record_author_names`). No new table; still exactly 9 tables.
* Seed: source records now carry author names.

**Tests** — 155 new (188 total, all passing)

* `tests/normalization/` (71): DOI variants/invalid values/URL-decoding/trailing punctuation; titles incl. real OpenAlex literal `\n`, DBLP trailing period, Büchi, HTML entities, MathML/sub/sup tags; builder validation; raw-metadata stripping; type-family mapping for all three sources (incl. OpenAlex "article" + conference source, deferred repository case).
* `tests/matching/` unit (39): generic-title list and prefix coverage, 9/10-character and 1/2-word boundaries; DOI contradiction criteria; every rule-3 veto; canonical priority, OTHER handling, DOI ownership skip, in-source tie-break.
* `tests/matching/engine.test.ts` (45, real test DB): secondary DOIs (stored list, match via secondary DOI, contradiction checks, canonical-owner precedence, DOI-change detection, payload preservation); SUPPRESSED absorption by DOI and title without new publication or professor link; same DOI across 3 sources; DOI despite type/year disagreement; in-source duplicates; source-record-only DOI; incorrect DOI split + candidate; canonical-owner precedence; preprint-vs-published DOI split; ambiguous DOI and title matches; title variations; year ±1 / ±2 / missing; conference vs journal; CoRR preprint vs published; preprint + preprint merge; OTHER; generic titles; DOI change without moving; dismissed candidate not reopened; canonical priority (OpenAlex replaces DBLP, MANUAL last); curated untouched; suppressed still matched; manual entry by DOI / title, later API discovery, uncertain manual → candidate; idempotent reruns.

**Validation**

* `typecheck` ✅, `test` 178/178 ✅, `build` ✅, `db:seed` ✅, `prisma migrate status` up to date and `migrate diff` clean ✅.
* Mutation checks: year tolerance 1 → 2 makes 2 tests fail; removing the secondary-DOI lookup makes 3 tests fail (both restored).

**Dependencies:** none added or changed.

**Known limitations**

* No fuzzy matching (deferred): a DOI match whose titles differ only by a typo, and an exact-title pair with a typo, both become `DuplicateCandidate`s rather than merges.
* Titles differing only in characters outside a–z/0–9 that NFKD does not decompose (e.g. Greek letters, `ß`) normalize differently from their transliterations.
* The OpenAlex repository preprint rule is deferred to Phase 4 (decision #25).
* Type-family mappings are initial; Phases 4–6 refine them with recorded fixtures (§7.3).

## Open Documentation / Roadmap Issues

* **Duplicate-candidate resolution has no assigned phase** (decision #29). `Project_plan.md` §8.5 defines admin *dismiss*, *merge B into A* and *detach source record*, and §17 lists an admin "duplicate candidates" page, but no phase in §19 includes implementing them. Phase 3 only creates candidates. Awaiting the architect's assignment.

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
| 3 | Matching & Deduplication Engine | Normalization, type families, preprint detection, deterministic matching, vetoes, DuplicateCandidate, canonical metadata selection | **COMPLETE** (approved) |
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

Kept explicitly deferred (see `Project_plan.md` §20): fuzzy matching; OpenAlex repository preprint rule (Phase 4); advisory locking; startup catch-up sync; exact monthly schedule; analytics treatment of `OTHER`; ORCID client registration; hard professor deletion; deployment provider.

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
| 8 | 2026-09-25 | Preprints kept separate; per-source detection (DBLP Informal/CoRR, OpenAlex preprint/10.48550/repository — repository part deferred by #25, ORCID preprint) | Live evidence: DBLP CoRR records lack DOIs and share titles/years with published versions |
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
| 21 | 2026-09-27 | Schema correction: nullable `PublicationSourceRecord.author_names_display` (migration `add_source_record_author_names`) | Genuine inconsistency: §6.4/§9 derive canonical author names from source records, but §6.5 had no field for them. Approved by architect (option A); no new table |
| 22 | 2026-09-27 | DOI contradiction criteria: only preprint-vs-published or unrelated titles (not equal, no whole-word containment) block a DOI match; type/year differences never do | Resolves the deferred §20 item in Phase 3; approved |
| 23 | 2026-09-27 | Generic/too-short titles: < 10 normalized chars, < 2 words, fixed generic list, or generic prefix → ineligible for title auto-merge | Resolves the deferred §20 item in Phase 3; approved; list in `titleEligibility.ts` |
| 24 | 2026-09-27 | Every blocked exact-title match (generic titles included) creates a `DuplicateCandidate`; ambiguous DOI/title matches create candidates, never a merge | §8.1 rule 4 as written; approved |
| 25 | 2026-09-27 | OpenAlex "repository where applicable" preprint rule DEFERRED to Phase 4; Phase 3 applies only type=preprint and 10.48550/ DOIs | "Where applicable" is undefined in the plan and decision #8 recorded the rule unconditionally; architect chose to defer |
| 26 | 2026-09-27 | Canonical selection: OTHER does not outrank a known type family; within one source the oldest record wins | §7.3 defines OTHER as insufficient information; approved |
| 27 | 2026-09-27 | DOI ownership precedence: canonical DOI owner before source-record-only DOI carriers | Phase 3 implementation decision (not frozen); approved |
| 28 | 2026-09-27 | ~~Known limitation: secondary DOIs of stored records not searched~~ **Superseded:** all normalized DOIs are kept in `raw_metadata._normalizedDois` and searched during matching | Architect review: the limitation conflicted with §6.5; implemented without schema change |
| 29 | 2026-09-27 | Roadmap gap recorded: §8.5 duplicate-candidate resolution has no implementation phase in §19 | Verified in Phase 3; not implemented; awaiting assignment |
| 30 | 2026-09-27 | SUPPRESSED publications stay in matching and absorb matching source records (provenance only); no professor links are ever created for them automatically; ingest result reports `publicationStatus` | Architect review of §6.4/§14; excluding them would recreate the suppressed paper as a new publication |

Superseded/rejected (kept for history): per-source `SyncJob` table (replaced by SyncRun/SyncTask); `SourceRecordProfessor` table (rejected; replaced by `discovered_via_identity_id`); repository layer (rejected); DBLP pid-XML/search/mirror access (rejected); MANUAL outranking API metadata (rejected); Levenshtein/`pg_trgm` fuzzy thresholds (rejected for now; fuzzy matching deferred); advisory-lock requirement (deferred).
