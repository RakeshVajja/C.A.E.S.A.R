# Professor Research Publication Management System (CSE_Research_Hub)

> **Status:** Architecture FROZEN · Phase 0 COMPLETE · Implementation NOT STARTED (Phase 1 not started).
> This document is the **authoritative** source for requirements and architecture.
> Implementation rules live in `CLAUDE.md`. Execution status lives in `PROJECT_PROGRESS.md`.
> Any change to a decision in this document must be approved and recorded in the Decision Log in `PROJECT_PROGRESS.md`.

---

# 1. Project Overview

## 1.1 Problem Statement

Develop a centralized system for organizing and managing research publication **metadata** belonging exclusively to professors of a department.

The system aggregates publication metadata from:

* OpenAlex
* DBLP
* ORCID

Each professor has an individual profile containing their verified publications.

The system must handle inconsistencies between sources, build the union of publications across sources, avoid duplicate publications, synchronize periodically, and require professor verification before newly discovered publications appear on their profile.

The system must **not** store research paper PDFs or full paper content. Only metadata is stored and displayed.

## 1.2 Core Problem

> How to aggregate inconsistent publication metadata from multiple scholarly sources, resolve duplicates into canonical publication records, preserve source provenance, and maintain a reliable professor-verified departmental publication database over time.

## 1.3 Guiding Priority

```text
Correctness > Completeness > Convenience
```

* It is better to leave a publication PENDING than to assign it to the wrong professor.
* It is better to create a `DuplicateCandidate` than to perform an unsafe automatic merge.
* It is better to record a failed fetch than to interpret it as "no publications".

---

# 2. Core Objectives

The system must:

1. Maintain profiles for professors of the department.
2. Store admin-verified external scholarly identities for each professor.
3. Fetch publication metadata from OpenAlex, DBLP and ORCID.
4. Normalize data from all sources into a common internal format.
5. Build the union of publications across sources.
6. Detect and avoid duplicate publications deterministically.
7. Maintain one canonical record per real-world publication.
8. Preserve all source identifiers and provenance.
9. Synchronize periodically (monthly) and on demand.
10. Require professor verification of newly discovered publications.
11. Allow professors to manually add missing publications.
12. Match manual publications with later API discoveries without silent duplication.
13. Give one administrator full management capabilities.
14. Provide departmental publication analytics.
15. Use only free/open-source technologies and free API access.

---

# 3. Scope

## 3.1 In Scope

* **Users:** Administrator, Professor
* **Professor management:** create, edit, deactivate; manage external identities
* **Publication management:** automatic discovery, manual addition, verification, rejection, metadata updates, duplicate prevention, multi-source aggregation, admin suppression, admin resolution of duplicate candidates
* **Sources:** OpenAlex, DBLP, ORCID
* **Synchronization:** manual trigger, monthly schedule, history, error tracking
* **Analytics:** totals, per-professor counts, by-year counts, by-source statistics, pending statistics, sync statistics

## 3.2 Out of Scope

Must NOT be implemented unless explicitly approved later:

* Storing PDFs, full papers, abstracts or downloading papers
* Paper summarization, AI chatbot, recommendation system
* Citation graph / reference storage
* Author/co-author entity tables
* AI/ML/LLM-based matching, embeddings, vector databases, semantic search, `pg_trgm`
* Student publication management
* Email notification infrastructure
* Social or collaboration features
* Queue infrastructure (Redis, BullMQ), microservices, GraphQL
* OAuth/SSO, refresh-token infrastructure, complex RBAC
* Docker/Kubernetes
* Hard deletion of professors (initially)

---

# 4. Technology Stack (Final)

| Layer | Technology |
|---|---|
| Frontend | Next.js (App Router), React, TypeScript, Tailwind CSS |
| Backend | Node.js, Express, TypeScript |
| Database | PostgreSQL (local for development; any standard PostgreSQL later) |
| ORM / migrations | Prisma 6 |
| Validation | Zod |
| HTTP client | Native Node `fetch` wrapped in one shared helper (no Axios) |
| Authentication | JWT in an HTTP-only cookie; bcrypt/bcryptjs password hashing |
| Scheduler | node-cron (scheduler only) |
| Testing | Vitest, Supertest |
| Version control | Git |

The application must not depend on any specific PostgreSQL hosting provider. The deployment provider is **deferred** to Phase 15.

---

# 5. High-Level Architecture

```text
Next.js Frontend
      │  HTTP / REST (JSON)
      ▼
Express Backend
  ├── Auth & authorization middleware
  ├── Route handlers (auth / me / admin)
  ├── Domain services (professors, publications, verification, analytics)
  ├── Publication pipeline
  │     normalize → match → canonicalize → link
  ├── Sync engine (SyncRun / SyncTask)   ◄── node-cron (scheduler only)
  └── Integrations (isolated per source)
        ├── openalex/  client + mapper
        ├── dblp/      SPARQL client + mapper
        └── orcid/     client + mapper
      │
      ▼
PostgreSQL (via Prisma)
```

Architectural rules:

1. **Canonical internal model.** External records never become the primary publication model directly.
2. **Source isolation.** Source-specific API handling and parsing live only inside that source's integration module. After mapping, everything is source-independent.
3. **No source is absolute truth.** The system builds the union and resolves duplicates.
4. **Provenance is always preserved** through source records.
5. **Services call Prisma directly.** There is no separate repository abstraction layer.
6. **The sync engine is independent of the scheduler.** Manual and scheduled syncs call the same engine.

---

# 6. Data Model (Final — exactly 9 core tables)

The following tables are frozen. No other domain tables may be added without approval (explicitly excluded: `SourceRecordProfessor`, `Author`, citation tables, embedding/ML tables, queue tables, audit/history tables).

**Physical conventions (decided at the start of Phase 2):** UUID primary keys (native `uuid`), `timestamptz` timestamps, snake_case table and column names in PostgreSQL (camelCase in TypeScript via Prisma `@map`/`@@map`). The implemented schema is `backend/prisma/schema.prisma`.

## 6.1 User

Authentication and authorization.

```text
User
  id
  email                  UNIQUE
  password_hash
  role                   ADMIN | PROFESSOR
  must_change_password
  created_at, updated_at
```

## 6.2 Professor

```text
Professor
  id
  user_id                UNIQUE, nullable FK → User
  name
  department
  designation
  is_active              (deactivation instead of deletion)
  created_at, updated_at
```

* A professor has at most one user account; the administrator has no Professor record.
* Contact/login email lives on `User`.
* Professors are **deactivated**, not hard-deleted (hard delete deferred).

## 6.3 ExternalIdentity

```text
ExternalIdentity
  id
  professor_id           FK → Professor
  source                 OPENALEX | DBLP | ORCID
  external_id            normalized identifier
  is_active
  verified_at
  created_at, updated_at

  UNIQUE(source, external_id)
```

* A professor may have **zero, one or several** identities per source (OpenAlex can split one person across several author IDs).
* The same identity can never belong to two professors.
* Identities are **admin-managed** only. The admin verifies an identity using a preview fetch before saving.
* Professors are never identified primarily by name.
* Identity formats: OpenAlex author ID (`A…`), DBLP PID (as used in `https://dblp.org/pid/{pid}`), ORCID iD (`0000-0000-0000-000X`, checksum-validated).

## 6.4 Publication (canonical)

One record per real-world publication.

```text
Publication
  id
  title
  normalized_title
  year                   nullable
  venue                  nullable (display only; not a match key)
  type_family            PREPRINT | CONFERENCE | JOURNAL | BOOK_CHAPTER | BOOK | OTHER
  author_names_display   nullable text (display only)
  doi                    nullable, UNIQUE (normalized)
  status                 ACTIVE | SUPPRESSED
  is_curated
  created_at, updated_at
```

* `SUPPRESSED` replaces deletion for incorrect publications: the record is hidden and never automatically re-linked.
* `is_curated = true` means canonical fields were deliberately edited by the administrator; synchronization never overwrites them.
* Canonical fields are derived from source records by the metadata priority (Section 9).

## 6.5 PublicationSourceRecord

One record per publication as reported by one source.

```text
PublicationSourceRecord
  id
  publication_id         FK → Publication
  source                 OPENALEX | DBLP | ORCID | MANUAL
  external_id
  title
  normalized_title
  doi                    nullable (normalized)
  year                   nullable
  venue                  nullable
  type_family
  raw_metadata           JSON (excluding abstracts, references and full-text content)
  match_method           how the record was attached to its Publication
  match_detail           short explanation
  created_by_user_id     nullable (MANUAL records)
  first_seen_at
  last_seen_at
  created_at, updated_at

  UNIQUE(source, external_id)
```

* Many source records (e.g. an OpenAlex work, a DBLP record and an ORCID put-code) may point to one canonical Publication. Source identifiers are never collapsed into a single field on `Publication`.
* There is deliberately **no** uniqueness on `(publication_id, source)`: one source can contain the same publication more than once.
* External ID formats: OpenAlex work ID (`W…`); DBLP record key (e.g. `conf/cav/KupfermanV96`); ORCID `{orcid}:{put-code}`; MANUAL generated UUID.
* If a record reports several DOIs, the first is stored in `doi` and all are kept in `raw_metadata`; matching considers all of them.

## 6.6 ProfessorPublication

The professor ↔ publication relationship and its verification state.

```text
ProfessorPublication
  id
  professor_id                 FK → Professor
  publication_id               FK → Publication
  status                       PENDING | APPROVED | REJECTED
  origin                       DISCOVERED | MANUAL | ADMIN
  discovered_via_identity_id   nullable FK → ExternalIdentity
  decided_at                   nullable
  decided_by_user_id           nullable
  created_at, updated_at

  UNIQUE(professor_id, publication_id)
```

* `discovered_via_identity_id` records which external identity caused the relationship to be discovered. It allows cleanup of PENDING relationships created by an incorrectly configured identity. It is `NULL` for manual/admin-created relationships.
* Approval/rejection applies to this relationship only, never to the canonical publication globally.

## 6.7 DuplicateCandidate

A possible duplicate that was deliberately **not** merged automatically.

```text
DuplicateCandidate
  id
  publication_a_id       FK → Publication
  publication_b_id       FK → Publication
  reason                 which rule/veto produced the candidate
  status                 OPEN | MERGED | DISMISSED
  resolved_by_user_id    nullable
  resolved_at            nullable
  created_at, updated_at

  UNIQUE(publication_a_id, publication_b_id)
```

## 6.8 SyncRun

```text
SyncRun
  id
  trigger                MANUAL | SCHEDULED
  triggered_by_user_id   nullable
  status                 RUNNING | SUCCESS | PARTIAL_SUCCESS | FAILED
  started_at, finished_at
  summary counts
```

## 6.9 SyncTask

One task per external identity per run.

```text
SyncTask
  id
  sync_run_id            FK → SyncRun
  identity_id            nullable FK → ExternalIdentity
  source
  status                 PENDING | RUNNING | SUCCESS | FAILED
  records_fetched, records_new, records_updated,
  links_created, candidates_created, warnings
  error_message          nullable
  started_at, finished_at
```

## 6.10 Relationship & delete behavior

* Professor deactivation keeps all data; identities of inactive professors are not synchronized.
* Deleting an `ExternalIdentity` sets `ProfessorPublication.discovered_via_identity_id` to `NULL` (identity removal cleanup is described in Section 12.4).
* A `Publication` cannot be deleted while source records or professor relationships reference it; use `SUPPRESSED`.
* `SyncTask` rows belong to their `SyncRun` (deleted with it); deleting an identity keeps its tasks with `identity_id = NULL`.
* A `Professor` cannot be hard-deleted while identities or relationships reference it (consistent with deactivation-only).
* `DuplicateCandidate` references become `NULL` when a publication is removed (e.g. merged away), so resolved candidates keep their status and reason. A pair is stored once in canonical order (`publication_a_id < publication_b_id`, enforced by a CHECK constraint).
* Deleting a `User` unlinks it (`SET NULL`) from its professor and from audit-style references (`created_by`, `decided_by`, `resolved_by`, `triggered_by`).

---

# 7. Normalization

All data (API and manual) is converted to a common normalized record before matching:

```text
NormalizedPublication
  source, externalId
  title, normalizedTitle
  dois[] (normalized)
  year
  venue
  typeFamily
  isPreprint
  authorNamesDisplay
  rawMetadata
```

## 7.1 DOI normalization

1. Trim whitespace.
2. Remove prefixes `doi:`, `https://doi.org/`, `http://doi.org/`, `https://dx.doi.org/`, `http://dx.doi.org/`.
3. URL-decode.
4. Lowercase (DOIs are case-insensitive; DBLP returns uppercase DOIs).
5. Remove trailing punctuation (`. , ; )`).
6. Must match `^10\.\d{4,9}/\S+$`; otherwise the DOI is treated as absent (the raw value stays in `raw_metadata`).

One shared implementation is used by all mappers, manual entry and admin edits.

## 7.2 Title normalization

1. Convert literal escape sequences (e.g. `\n`, `\t` as text) and real control characters to spaces.
2. Decode HTML entities and strip markup tags.
3. Unicode NFKD; remove combining marks (e.g. `ü` → `u`).
4. Lowercase.
5. Replace every character other than `[a-z0-9]` with a space (removes DBLP's trailing period and punctuation differences).
6. Collapse whitespace and trim.

Stopwords are kept. No stemming. The function is deterministic; if it ever changes, stored normalized titles are recomputed.

## 7.3 Type families

```text
PREPRINT | CONFERENCE | JOURNAL | BOOK_CHAPTER | BOOK | OTHER
```

OpenAlex's `type` field alone is **not** reliable (conference papers appear as `article`). Type family is determined per source using:

| Source | Inputs |
|---|---|
| OpenAlex | `type` **and** `primary_location.source.type` |
| DBLP | `bibtexType` / record type and record key |
| ORCID | `type` |
| MANUAL | required professor selection |

Initial mapping (refined with real fixtures during Phases 3–6):

* **OpenAlex:** preprint rules (7.4) → `PREPRINT`; `conference-paper` or source type `conference` → `CONFERENCE`; `article` with source type `journal` → `JOURNAL`; `book-chapter` → `BOOK_CHAPTER`; `book` → `BOOK`; anything else or insufficient information → `OTHER`.
* **DBLP:** `Informal` / `journals/corr/` → `PREPRINT`; `Inproceedings` → `CONFERENCE`; `Article` → `JOURNAL`; `Incollection` → `BOOK_CHAPTER`; `Book` → `BOOK`; others → `OTHER`.
* **ORCID:** `preprint` → `PREPRINT`; `conference-paper` → `CONFERENCE`; `journal-article` → `JOURNAL`; `book-chapter` → `BOOK_CHAPTER`; `book` → `BOOK`; others → `OTHER`.

`OTHER` is never treated as a *known* type family for automatic title-based matching.

## 7.4 Preprint detection

| Source | Record is a preprint when |
|---|---|
| DBLP | record type `Informal`, or key begins with `journals/corr/` (DBLP CoRR records usually have **no DOI**) |
| OpenAlex | `type = preprint`, or DOI begins with `10.48550/`, or the primary source is a repository where applicable |
| ORCID | `type = preprint` |

---

# 8. Matching & Deduplication (Final)

Matching is deterministic and explainable. Every attachment records `match_method` and `match_detail`. Matching searches **all** canonical publications, not only the current professor's.

## 8.1 Rules (evaluated in order)

```text
1. Same source + external ID
   → same source record (update it)

2. Normalized DOI match (any DOI of the incoming record vs. canonical/source-record DOIs)
   → same canonical Publication
   → subject to contradiction checks

3. Exact normalized title + year ±1
   → automatic match ONLY when:
       - both years are known (and within ±1)
       - type families are compatible (= the same KNOWN family; OTHER is never compatible)
       - no veto applies

4. Otherwise
   → DuplicateCandidate (when a possible match was blocked or uncertain)
     OR new Publication (when there is no possible match)
```

## 8.2 Vetoes (block automatic matching)

* Different non-null DOIs.
* Preprint vs published conflict.
* Incompatible known type families.
* Generic or too-short titles (e.g. "Editorial", "Preface", "Introduction").

## 8.3 Clarifications

* If either record lacks the information needed to establish safety (unknown type family, missing year), rule 3 does **not** auto-merge; the result is a `DuplicateCandidate`. An exact title alone never merges records.
* A DOI match that shows a strong contradiction is not merged; the new record gets its own Publication (without the conflicting canonical DOI) and a `DuplicateCandidate` is created.
* A DOI change on an existing source record never silently moves it to a different Publication; a `DuplicateCandidate` is created instead.
* Several source records from the same source may attach to one Publication (in-source duplicates).
* Exact contradiction criteria, the generic-title list and the minimum title length are defined and tested in Phase 3.

## 8.4 Not used

* AI/ML/LLM matching, embeddings, vector databases, `pg_trgm`.
* Arbitrary fuzzy thresholds.

**Fuzzy matching is DEFERRED** until real project data demonstrates that deterministic matching is insufficient. If introduced, it may only create `DuplicateCandidate` records, never automatic merges, and requires approval.

## 8.5 Duplicate candidate resolution (admin)

* **Dismiss:** candidate marked `DISMISSED`; both publications remain.
* **Merge B into A:** B's source records and professor relationships move to A (a professor linked to both keeps one relationship: APPROVED > PENDING > REJECTED); B is then removed; candidate marked `MERGED`.
* **Detach a source record:** moves a wrongly attached source record to its own new Publication.

---

# 9. Canonical Metadata Priority (Final)

```text
CURATED → OpenAlex → DBLP → ORCID → MANUAL
```

* For each canonical field, the first available non-empty value in this order is used.
* Canonical fields are recomputed after source-record changes unless `is_curated` is set.
* `MANUAL` is a provenance type, **not** automatically more authoritative than API sources; it is the final fallback (so manual-only publications still have metadata).
* `is_curated` protects deliberately human-curated canonical metadata.
* No field-level provenance flags; source records already preserve provenance.
* Metadata updates to an APPROVED publication do not reset its verification status.

---

# 10. Preprint Policy (Final)

* Preprints remain **separate** from published versions unless there is sufficiently strong evidence to safely associate them.
* Preprints and published versions are never merged automatically by title.
* Preprints remain in the database and may appear in professor publication lists.
* Preprints are **excluded from default research analytics**.

---

# 11. Professor Verification

```text
PENDING → APPROVED
PENDING → REJECTED
APPROVED ⇄ REJECTED   (professor may change their decision)
```

* Newly discovered relationships are always created as `PENDING`; API discoveries never become APPROVED automatically.
* Synchronization only **creates** missing relationships; it never changes an existing relationship's status.
* A rejected relationship stays rejected across future syncs and never automatically returns to PENDING; only an explicit professor action can reverse it.
* Rejection never deletes the canonical publication; professor A may reject while professor B approves the same publication.
* Only APPROVED publications appear in a professor's verified publication list.
* Professors act only on their own relationships; the professor is always derived from the authenticated account, never from a URL or request parameter.
* Bulk approval is supported (the first sync may produce many pending items).

---

# 12. Manual Publications

## 12.1 Fields

* Title — required
* Type family — **required**
* DOI, year, venue, author names — optional

## 12.2 Pipeline

A manual entry becomes a `PublicationSourceRecord` with `source = MANUAL` and follows the same pipeline as API records:

```text
normalize → match → duplicate detection → canonical Publication → ProfessorPublication
```

* If it matches an existing Publication (rules 1–3), it links to that Publication.
* If safe matching is not possible but a possible match exists, a `DuplicateCandidate` is created.
* Otherwise a new Publication is created.
* The resulting relationship is `APPROVED` with `origin = MANUAL` (an explicit professor assertion; it also upgrades an existing PENDING/REJECTED relationship).

## 12.3 Rule

**A manual entry must never silently create a duplicate when an existing canonical publication can be matched.** If safe matching is not possible, a `DuplicateCandidate` is preferable to an unsafe automatic merge. The same applies when an API later discovers a manually added publication.

## 12.4 Identity removal / correction

When an admin deactivates or removes an incorrect external identity, PENDING relationships whose `discovered_via_identity_id` is that identity are removed. APPROVED and REJECTED relationships are kept. Relationships genuinely supported by the professor's other identities are recreated by the next synchronization.

---

# 13. External API Integration (Final)

Each source has an isolated integration module:

```text
integrations/
  openalex/  client, mapper
  dblp/      client (SPARQL), mapper
  orcid/     client, mapper
```

* **Client:** HTTP calls through the shared helper, pagination, response validation, retry/backoff, per-source rate configuration.
* **Mapper:** converts validated source responses into `NormalizedPublication`.
* No source-specific parsing outside these modules.

## 13.1 API response validation (core reliability requirement)

**HTTP 200 alone does NOT mean a successful fetch.**

The integration layer must treat all of the following as **fetch failures**:

* unexpected content type
* HTML (e.g. bot-protection pages) instead of expected JSON / SPARQL JSON
* malformed or unparseable bodies
* API error payloads
* structurally invalid responses
* a nonexistent/invalid identity

A fetch failure must **never** be interpreted as "the professor has zero publications". A genuine, valid empty result (a well-formed response confirming zero works for a validated identity) must remain distinguishable from a failed fetch.

## 13.2 Shared HTTP helper

* Native `fetch`, request timeout, retry with exponential backoff and jitter.
* Honour `Retry-After`; retry on 429, 5xx and network errors; do not retry other 4xx.
* Per-source configuration: minimum interval between requests, concurrency, page size.

## 13.3 OpenAlex

* Validate the author identity (`/authors/{id}`) **before** fetching works; a nonexistent ID is a failure (the works filter returns an empty 200 for nonexistent IDs). Redirects indicate merged IDs and are logged.
* Fetch works with `filter=author.id:{id}`, **cursor pagination**, `per-page=100`.
* Use `select=` to fetch only needed fields (no abstracts, references or full-text data).
* Use a free API key from configuration.
* Validate response content; retry/backoff on 429/5xx.

## 13.4 DBLP

* Use the **DBLP SPARQL endpoint** (`sparql.dblp.org`) with SPARQL JSON results.
* Do **NOT** use `dblp.org/pid/{pid}.xml`, the normal DBLP search endpoint, or DBLP mirrors (they currently return bot-protection HTML).
* Retrieve publications **authored** by the professor's PID (editor-only records are excluded).
* Record key → `external_id`; map title, year, DOI(s), venue and record type.
* Throttle conservatively (one request at a time, 1–2 s apart); handle 429 and other failures.
* Implementation stays isolated behind the DBLP source client so the access method can change without affecting the rest of the system.

## 13.5 ORCID

* ORCID Public API, v3.0 works endpoint: `/v3.0/{orcid}/works`.
* Request JSON with `Accept: application/json` (default is XML) and validate the content type.
* One source record per work summary (put-code): `external_id = {orcid}:{put-code}`.
* Use only external identifiers with relationship `self` (e.g. ignore `part-of` ISSNs).
* Handle missing years and in-source duplicates (several put-codes for the same work).
* Anonymous public access is sufficient; public-API registration is optional.

---

# 14. Synchronization (Final)

```text
SyncRun
   ↓
SyncTask per active ExternalIdentity
   ↓
fetch → validate response → normalize → match → write
```

Rules:

* One sync run at a time (application-level guard is sufficient initially; PostgreSQL advisory locking is not required).
* Each task fetches its complete result set and validates it **before** writing; a failed fetch writes nothing and marks the task FAILED. Other tasks continue; the run ends as `PARTIAL_SUCCESS`.
* Failed fetches never destroy or alter existing data.
* Missing records are never automatically deleted or unlinked.
* `last_seen_at` is updated only after the record's task has been fetched, validated and processed successfully.
* Incomplete or failed API responses never cause deletion or unlinking.
* Reruns are idempotent.
* Rejected relationships remain rejected.
* Suppressed publications are not automatically re-linked.
* DOI changes do not silently move source records.
* Runs left `RUNNING` by a crash are marked failed at startup.
* `node-cron` is only the scheduler (monthly); synchronization logic is independent of it. The admin can also trigger a sync manually.
* Redis/BullMQ are out of scope.

---

# 15. Users, Authentication & Authorization

## 15.1 Roles

* **ADMIN** (single administrator): manages professors, identities, publications (edit, curate, suppress), duplicate candidates, synchronization and analytics.
* **PROFESSOR:** views own profile and publications, approves/rejects pending relationships, adds manual publications, edits permitted own information.

## 15.2 Authentication

* JWT stored in an HTTP-only, `SameSite=Lax` cookie; never in `localStorage`.
* Passwords hashed with bcrypt/bcryptjs.
* The admin creates professor accounts with a temporary password; the professor must change it at first login.
* The admin account is created by a development/deployment seed.
* No OAuth/SSO, no refresh-token infrastructure.

## 15.3 REST boundaries

```text
/api/health
/api/auth/*     login, logout, current user, change password
/api/me/*       authenticated professor's own data (no professor IDs in URLs)
/api/admin/*    ADMIN role only
```

Request input is validated with Zod. Errors use one consistent JSON error shape.

---

# 16. Analytics

Default analytics count **APPROVED** relationships to **ACTIVE**, non-preprint canonical publications, without double-counting source records.

* Overview: total professors, total unique publications, pending verifications, last sync time
* Approved publications per professor
* Publications by year
* Source statistics: records per source, unique canonical publications after merging
* Synchronization statistics: successful/failed runs, records fetched/added/updated

---

# 17. Frontend

* Public: `/login`
* Professor: dashboard, profile, publications, pending verification, add publication
* Admin: dashboard, professors (+ identities), publications, duplicate candidates, synchronization, analytics

No UI features beyond the required workflows.

---

# 18. Testing Expectations

* **Vitest** for backend unit and integration tests; **Supertest** for route/authorization tests.
* Normalization and matching are pure functions with extensive unit tests (Phase 3).
* Mapper tests use **recorded real API responses** stored as fixtures; automated tests never call live APIs.
* Integration tests run against a separate local test database.
* Required matching/pipeline cases: same DOI across sources, missing DOI, conflicting DOI, title variations, year ±1, conference/journal conflict, preprint/published conflict, in-source duplicate records, multiple identities for one professor, incorrect external identity, failed API responses (including HTML-with-200), partial sync, idempotent reruns, manual record later discovered by API, rejected relationship surviving resync.
* No phase is complete without relevant tests passing.

---

# 19. Implementation Phases (Final Order)

| Phase | Name | Goal |
|---|---|---|
| 0 | Requirements & Architecture Freeze | Finalize requirements, scope, architecture, API assumptions, matching rules and schema decisions. **COMPLETE.** |
| 1 | Minimal Project Setup | Clean application foundation: repository structure, backend/frontend configuration cleanup, environment configuration/validation, Express/TypeScript consistency, basic health endpoint, testing foundation, development configuration, cleanup of scaffold/placeholder implementation. **No** domain schema/models, matching, API integrations, authentication, verification, sync, analytics or domain UI. (The pre-freeze scaffold does not count as Phase 1.) |
| 2 | Minimal Database Foundation | Implement the 9-table model: relationships, constraints, indexes, migration, minimal development seed. No matching or API integrations. |
| 3 | Matching & Deduplication Engine | Normalization (DOI, title, type family), preprint detection, deterministic matching, vetoes, DuplicateCandidate creation, canonical metadata selection, provenance handling. Synthetic/unit-test data first. Fuzzy matching deferred. |
| 4 | OpenAlex Integration | Identity validation, cursor pagination, response validation, mapping, normalization, source records, matching, PENDING relationships, retry/rate handling. |
| 5 | DBLP Integration | SPARQL client, identity handling, query/mapping, response validation, throttling, normalization, matching, provenance, failure handling. |
| 6 | ORCID Integration | Identity handling, works retrieval, JSON handling, put-code source records, normalization, matching, provenance, failure handling. |
| 7 | Core Pipeline Testing & Audit | Test the complete multi-source pipeline against the required cases (Section 18) before building application workflows. |
| 8 | Authentication | ADMIN/PROFESSOR, JWT, HTTP-only cookie, password hashing, temporary password, forced password change, route protection. |
| 9 | Professor Management | Professor creation, profile, external identity management, identity activation/deactivation, professor deactivation (no hard delete). |
| 10 | Verification Workflow | PENDING/APPROVED/REJECTED, approval/rejection, reversible rejection, authenticated ownership. |
| 11 | Manual Publication Addition | Manual entry through the same pipeline; test exact match, DOI match, uncertain match, DuplicateCandidate, later API discovery. |
| 12 | Synchronization | SyncRun, SyncTask, node-cron, one-sync-at-a-time guard, retries, failure handling, idempotency, last-seen tracking. |
| 13 | Analytics | Required admin statistics following the preprint policy. |
| 14 | Frontend Integration | Admin and professor workflows, pending verification, manual addition, sync status, analytics. |
| 15 | Final Testing & Deployment | End-to-end testing, edge cases, security checks, production configuration, deployment preparation, documentation, demo readiness. Deployment provider chosen here. |

Each phase ends with: what was implemented, files changed, design decisions, test results, known limitations — and an update to `PROJECT_PROGRESS.md`.

---

# 20. Deferred Decisions

These are intentionally **not** decided yet and must remain marked as deferred until decided and logged:

* Fuzzy matching (only after real data shows need; candidates only).
* Exact DOI-contradiction criteria, generic-title list and minimum title length (Phase 3, test-driven).
* PostgreSQL advisory locking (only if multiple backend instances are ever used).
* Startup catch-up sync (optional; Phase 12).
* Exact monthly schedule time (Phase 12).
* Whether analytics count the `OTHER` type family (Phase 13).
* ORCID public-API client registration (optional).
* Hard deletion of professors.
* Deployment provider (Phase 15).

---

# 21. Definition of Done

* Admin and professor authentication work.
* Admin fully manages professors and external identities.
* Publications collected from OpenAlex, DBLP and ORCID; normalized; deduplicated into canonical records with preserved provenance.
* Uncertain matches surface as DuplicateCandidates; no unsafe automatic merges.
* Professors approve/reject discoveries and add manual publications; manual publications are never silently duplicated by later discoveries.
* Manual and monthly synchronization work; failures preserve existing data.
* Administrator analytics available.
* No PDFs, full papers or abstracts stored; no AI/ML features.
