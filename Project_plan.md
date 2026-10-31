# Professor Research Publication Management System (CSE_Research_Hub)

> **Status:** Architecture FROZEN, amended only by logged, approved decisions · Phases 0–13B complete, Phase 14 implemented · Phase 15 (Scopus, Web of Science, JCR) architecture approved 2026-10-30 (#107–#125), sections 1–21 aligned in stage 15.0 (#126) · Phase 16 deployment.
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
* Scopus (Elsevier; institutional entitlement required — Phase 15)
* Web of Science (Clarivate; institutional entitlement required — Phase 15)

and journal-level metrics from Journal Citation Reports (JCR, Clarivate; a journal-metrics integration, not a publication source — Phase 15).

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
3. Fetch publication metadata from OpenAlex, DBLP, ORCID, Scopus and Web of Science, and journal metrics from JCR (decisions #107–#125).
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
15. Use only free/open-source technologies. External APIs are free where available; Scopus, Web of Science and JCR are used only through the institution's own entitlements (decision #107 — an architectural exception, not an authorization to purchase any licence or subscription).

---

# 3. Scope

## 3.1 In Scope

* **Users:** Administrator, Professor
* **Professor management:** create, edit, deactivate; manage external identities
* **Publication management:** automatic discovery, manual addition, verification, rejection, metadata updates, duplicate prevention, multi-source aggregation, admin suppression, admin resolution of duplicate candidates
* **Sources:** OpenAlex, DBLP, ORCID, Scopus, Web of Science (publication discovery); JCR (journal metrics only)
* **Citation observations:** per-provider citation counts from Scopus and Web of Science, kept independently over time (#111)
* **Synchronization:** manual trigger, monthly schedule, history, error tracking
* **Analytics:** totals, per-professor counts, by-year counts, by-source statistics, pending statistics, sync statistics; internal Scopus citation aggregates for the administrator (#112)

## 3.2 Out of Scope

Must NOT be implemented unless explicitly approved later:

* Storing PDFs, full papers, abstracts or downloading papers
* Paper summarization, AI chatbot, recommendation system
* Citation graph / reference storage (citing/cited lists, references); per-provider citation **counts** are in scope (#111)
* Author-level metrics (h-index etc.) (#113)
* Purchasing licences or entering provider agreements (institutional decisions outside the project, #107)
* Author/co-author entity tables
* AI/ML/LLM-based matching, embeddings, vector databases, semantic search, `pg_trgm`
* Student publication management
* Email notification infrastructure (sole exception: the transactional email that delivers professor password-recovery codes, §15.4, decision #53)
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
| Email (password recovery only) | Nodemailer over generic SMTP, configured by environment variables (decision #55) |
| Scheduler | node-cron (scheduler only) |
| Testing | Vitest, Supertest |
| Version control | Git |

Licensed provider credentials (Scopus, Web of Science, JCR) come only from environment variables, are sent only in request headers, and never appear in URLs, logs, responses, errors, frontend code or Git (§13.9).

The application must not depend on any specific PostgreSQL hosting provider. The deployment provider is **deferred** to Phase 16 (renumbered from Phase 15 on 2026-10-30, decision #103).

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
  ├── Sync engine (SyncRun / SyncTask; run kinds PUBLICATION_DISCOVERY
  │     and JOURNAL_METRICS)              ◄── node-cron (scheduler only)
  ├── Provider-data removal (admin command line, §13.10)
  └── Integrations (isolated per source)
        ├── openalex/  client + mapper
        ├── dblp/      SPARQL client + mapper
        ├── orcid/     client + mapper
        ├── scopus/    client + mapper      (Phase 15)
        ├── wos/       client + mapper      (Phase 15, Starter API)
        └── jcr/       client + mapper      (Phase 15, journal metrics)
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

# 6. Data Model (Final — 14 tables: 9 core + 5 Phase 15)

The following tables are frozen: the 9 core tables (§6.1–§6.9) and, from Phase 15, the 5 tables of §6.11 (decision #107; the 9-table limit of decision #2 is superseded). No other domain tables may be added without approval (explicitly excluded: `SourceRecordProfessor`, `Author`, citation-graph/reference tables, embedding/ML tables, queue tables, audit/history tables). Phase 15 columns of existing tables are listed in their sections and specified in §22.5.

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
  password_reset_code_hash      nullable (keyed HMAC of the recovery code; never the code)
  password_reset_expires_at     nullable
  password_reset_attempts       default 0
  password_reset_last_sent_at   nullable
  password_reset_send_count     default 0
  temporary_password_expires_at nullable (when an emailed temporary password stops being accepted; NULL once activated)
```

The `password_reset_*` columns hold professor password-recovery state (§15.4): at most one active code per user, so no separate table is needed (decision #54; additive migration `add_user_password_recovery`). `temporary_password_expires_at` holds the expiry of a professor's emailed temporary password (§15.2; decision #102; additive migration `add_user_temporary_password_expiry`).

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
  source                 OPENALEX | DBLP | ORCID | SCOPUS | WOS
  external_id            normalized identifier
  is_active
  verified_at
  verification_method    API_PREVIEW | MANUAL_PROFILE          (Phase 15, #118)
  verification_evidence_url  nullable                          (Phase 15)
  verified_by_user_id    nullable FK → User (SET NULL)          (Phase 15)
  created_at, updated_at

  UNIQUE(source, external_id)
```

* A professor may have **zero, one or several** identities per source (OpenAlex can split one person across several author IDs).
* The same identity can never belong to two professors.
* Identities are **admin-managed** only. The admin verifies an identity using a preview fetch before saving.
* Professors are never identified primarily by name.
* Identity formats: OpenAlex author ID (`A…`), DBLP PID (as used in `https://dblp.org/pid/{pid}`), ORCID iD (`0000-0000-0000-000X`, checksum-validated), Scopus Author ID (digits), Web of Science ResearcherID (e.g. `A-1009-2008`).
* Scopus and WoS identities may be verified by the API preview or, without credentials, manually from the provider's authoritative public profile, recording method, evidence URL and administrator; the identity is revalidated by its first synchronization before any record is accepted (#118).

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
  is_curated             (true when `curation` is non-empty)
  curation               JSON: per administrator-edited field → basis + evidence   (Phase 15, #125)
  journal_id             nullable FK → Journal (SET NULL)                         (Phase 15, #116)
  created_at, updated_at
```

* `SUPPRESSED` replaces deletion for incorrect publications: the record is hidden and never automatically re-linked. It still takes part in matching, so later source records for the same paper are absorbed into it as provenance instead of recreating it as a new publication; no professor relationship is ever created for it automatically (decision #30).
* `curation` records, for each canonical field the administrator actually changed (`title`, `year`, `venue`, `type_family`, `author_names_display`, `doi`), its basis — `INDEPENDENT` (with retained evidence), the provider it was derived from (`SCOPUS`, `WOS`, `JCR`, …), or `PRE_PHASE15` for edits made before Phase 15 — and an evidence note. Synchronization never overwrites a curated field; other fields are still recomputed (decision #125, refining #90). `INDEPENDENT` is a declaration, not proof of legal independence.
* `journal_id` is set only when the publication's ISSNs identify exactly one journal; otherwise it stays NULL (#116).
* Canonical fields are derived from source records by the metadata priority (Section 9).

## 6.5 PublicationSourceRecord

One record per publication as reported by one source.

```text
PublicationSourceRecord
  id
  publication_id         FK → Publication
  source                 OPENALEX | DBLP | ORCID | SCOPUS | WOS | MANUAL
  external_id
  title
  normalized_title
  doi                    nullable (normalized)
  year                   nullable
  venue                  nullable
  type_family
  author_names_display   nullable (display only; feeds canonical selection — decision #21)
  raw_metadata           JSON (excluding abstracts, references and full-text content; U+0000 replaced with U+FFFD — §7)
  match_method           how the record was attached to its Publication
  match_detail           short explanation
  created_by_user_id     nullable (MANUAL records)
  issns                  normalized ISSN list (Phase 15; for journal linking)
  entry_basis            nullable; MANUAL only: INDEPENDENT | provider name | PRE_PHASE15  (Phase 15, #125)
  entry_evidence         nullable; MANUAL only: DOI / publisher or repository URL / note
  first_seen_at
  last_seen_at
  created_at, updated_at

  UNIQUE(source, external_id)
```

* Many source records (e.g. an OpenAlex work, a DBLP record and an ORCID put-code) may point to one canonical Publication. Source identifiers are never collapsed into a single field on `Publication`.
* There is deliberately **no** uniqueness on `(publication_id, source)`: one source can contain the same publication more than once.
* External ID formats: OpenAlex work ID (`W…`); DBLP record key (e.g. `conf/cav/KupfermanV96`); ORCID `{orcid}:{put-code}`; Scopus EID / `SCOPUS_ID`; Web of Science accession number (`WOS:…`); MANUAL generated UUID.
* If a record reports several DOIs, the first is stored in `doi` and all are kept in `raw_metadata` (the complete normalized list under the key `_normalizedDois`, next to the source payload); matching considers all of them — every DOI of the incoming record against canonical DOIs, source-record `doi` columns and the `_normalizedDois` lists of stored records (decision #28).

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
  kind                   PUBLICATION_DISCOVERY | JOURNAL_METRICS   (Phase 15, #123)
  trigger                MANUAL | SCHEDULED
  triggered_by_user_id   nullable
  status                 RUNNING | SUCCESS | PARTIAL_SUCCESS | FAILED
  started_at, finished_at
  summary counts         (+ JCR data date, journals checked, snapshots added for JOURNAL_METRICS runs)
```

## 6.9 SyncTask

One task per external identity per discovery run; one task per journal per JCR run (Phase 15).

```text
SyncTask
  id
  sync_run_id            FK → SyncRun
  kind                   IDENTITY_DISCOVERY | JOURNAL_METRICS     (Phase 15)
  identity_id            nullable FK → ExternalIdentity
  journal_id             nullable FK → Journal (SET NULL)          (Phase 15)
  source                 identity source; NULL only for JOURNAL_METRICS tasks
  status                 PENDING | RUNNING | SUCCESS | FAILED | NOT_CONFIGURED
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
* Provider-data removal (§13.10) is the only process besides an administrator merge that deletes publications, and only those left without independently supported metadata, after explicit administrator approval (#124).
* Citation observations are deleted with their source record; journal ISSNs, metric snapshots and category metrics are deleted with their journal; deleting a journal sets `publications.journal_id` and `sync_tasks.journal_id` to NULL.

## 6.11 Phase 15 tables (decisions #107–#125; full specification in §22.5)

```text
CitationObservation      one provider's citation count for one source record at one time; append-only
  source_record_id (FK, CASCADE), provider, database, count, observed_at, sync_task_id (SET NULL)
  UNIQUE(source_record_id, sync_task_id)

Journal                  JCR journal identity
  jcr_id UNIQUE, name, jcr_title, iso_title, publisher_name, first_issue_year, frequency, language

JournalIssn              print / electronic / previous ISSNs
  journal_id (CASCADE), issn, kind, valid_from_year, valid_to_year
  UNIQUE(journal_id, issn); index on issn (an ISSN of two journals = ambiguous, never linked)

JournalMetricSnapshot    one revision of one journal's JCR report for one JCR year; insert-only
  journal_id (CASCADE), jcr_year, revision, payload_hash, jcr_data_update, retrieved_at, sync_task_id,
  published values (JIF and JIF without self-citations as text; 5-year JIF, JCI, immediacy index,
  total cites, average JIF percentile; suppressed / on hold / delisted) and derived numeric JIF values
  UNIQUE(journal_id, jcr_year, revision)

JournalCategoryMetric    per-category rank, quartile and percentile within a snapshot; insert-only
  snapshot_id (CASCADE), metric JIF | JCI, category_name, category_code, edition (NOT NULL, '' = not given),
  rank_text, rank, rank_total, quartile, percentile
  UNIQUE(snapshot_id, metric, category_name, edition)
```

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

**U+0000 (decision #52).** PostgreSQL cannot store U+0000 in text or JSON, so before storage it is replaced with U+FFFD in every text field and in `raw_metadata` (string values and keys, at any depth). Normalized titles are unaffected (title normalization already treats control characters as separators). If replacing it in keys makes two `raw_metadata` keys identical, keys without U+0000 keep their names and the replaced key gets the first free suffix `#2`, `#3`, … — no value is overwritten. A record whose external ID contains U+0000 is skipped with a warning (the external ID is never altered). Warnings and fetch error messages that quote source values have U+0000 replaced the same way.

## 7.1 DOI normalization

1. Trim whitespace.
2. Remove prefixes `doi:`, `https://doi.org/`, `http://doi.org/`, `https://dx.doi.org/`, `http://dx.doi.org/`.
3. URL-decode.
4. Lowercase (DOIs are case-insensitive; DBLP returns uppercase DOIs).
5. Remove trailing punctuation (`. , ; )`).
6. Must match `^10\.\d{4,9}/\S+$` and must not contain U+0000 (decision #52); otherwise the DOI is treated as absent (the raw value stays in `raw_metadata`).

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
| DBLP | record type = the record's dblp class (`rdf:type`, e.g. `Inproceedings`, `Informal`), with `bibtexType` only as a fallback, plus the record key. `bibtexType` alone is not reliable: CoRR preprints are class `Informal` but bibtex `Article` (decision #36). |
| ORCID | `type` |
| Scopus | `subtype` **and** `prism:aggregationType` (mapping defined with synthetic fixtures in stage 15.3, validated live in 15.9) |
| Web of Science | `types[]` **and** `sourceTypes[]` (mapping defined in stage 15.4, validated live in 15.9) |
| MANUAL | required professor selection |

Initial mapping (refined with real fixtures during Phases 3–6):

* **OpenAlex:** preprint rules (7.4) → `PREPRINT`; `conference-paper` or source type `conference` → `CONFERENCE`; `article` with source type `journal` → `JOURNAL`; `book-chapter` → `BOOK_CHAPTER`; `book` → `BOOK`; anything else or insufficient information → `OTHER`.
* **DBLP (decision #40):** class `Informal` **and** key under `journals/corr/`, or a DOI beginning with `10.48550/` → `PREPRINT`; `Informal` outside `journals/corr/` → `OTHER`; `Inproceedings` → `CONFERENCE`; `Article` → `JOURNAL`; `Incollection` → `BOOK_CHAPTER`; `Book` → `BOOK`; others (`Data`, `Reference`, `Withdrawn`, …) → `OTHER`. Neither `journals/corr/` alone nor `Informal` alone is a preprint signal.
* **ORCID:** `preprint` → `PREPRINT`; `conference-paper` → `CONFERENCE`; `journal-article` → `JOURNAL`; `book-chapter` → `BOOK_CHAPTER`; `book` → `BOOK`; others → `OTHER`.

`OTHER` is never treated as a *known* type family for automatic title-based matching.

## 7.4 Preprint detection

| Source | Record is a preprint when |
|---|---|
| DBLP | record class `Informal` **and** key beginning with `journals/corr/` (CoRR; usually **no DOI**), or a DOI beginning with `10.48550/`. `journals/corr/` alone is not enough (published EPTCS/LMCS papers are filed there as `Inproceedings`/`Article`), and `Informal` alone is not enough (Dagstuhl seminar items are `Informal` outside CoRR → `OTHER`). Decision #40, from the Phase 5 audit of recorded data. |
| OpenAlex | `type = preprint`, or DOI begins with `10.48550/`. Repository hosting is **not** a preprint signal (decision #31, settled in Phase 4 with live data: of 140 repository-hosted works of one author, all 94 real preprints were already typed `preprint`; the other 46 were published papers, reports and books). |
| ORCID | `type = preprint` |
| Web of Science | Preprint databases (`PPRN`) are not queried; Core Collection records are not preprints unless their type says so (stage 15.4) |
| Scopus | Determined from `subtype`/`aggregationType` in stage 15.3 |

---

# 8. Matching & Deduplication (Final)

Matching is deterministic and explainable. Every attachment records `match_method` and `match_detail`. Matching searches **all** canonical publications, not only the current professor's. Scopus and Web of Science records use exactly these rules; there is no provider-specific matching engine (#107–#125).

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
* **DOI contradiction criteria (decision #22, resolved in Phase 3).** A DOI match is blocked only by: (a) preprint vs published; (b) unrelated titles — no title of the publication (canonical or source record) equals the incoming normalized title or contains it / is contained in it as a whole-word sequence. Type-family and year differences never block a DOI match. No similarity threshold is used.
* **Generic / too-short titles (decision #23, resolved in Phase 3).** A normalized title is ineligible for title-based auto-merging when it has fewer than 10 characters, fewer than 2 words, is on the fixed generic list (editorial, preface, foreword, introduction, erratum, corrigendum, front matter, table of contents, keynote, in memoriam, …) or starts with a generic prefix (`editorial`, `guest editorial`, `preface`, `foreword`, `erratum`, `corrigendum`, `correction to`, `retraction`, `front matter`, `back matter`). The authoritative list is `backend/src/services/matching/titleEligibility.ts`.
* **Blocked or ambiguous matches (decision #24).** Every exact-title match blocked by a veto — generic titles included — produces a `DuplicateCandidate`. When several publications qualify (by DOI or by title), nothing is merged: a new Publication is created with a candidate for each.
* **DOI ownership precedence (decision #27, Phase 3 implementation decision).** A publication whose canonical DOI matches takes precedence over publications that only carry the DOI on a source record. **Exception (#136, owner-approved 2026-10-31):** when that canonical owner is refused by the DOI contradiction checks (#22), the publications carrying the DOI only on a source record are evaluated with the same checks — exactly one that passes receives the record (match method DOI, the refusal named in `match_detail`); several → nothing is merged and each becomes a candidate (#24); none → unchanged behaviour. The #22 checks themselves and every other rule are unchanged; canonical DOIs stay unique, so the DOI remains with the publication that claimed it first.
* An existing `DuplicateCandidate` pair is never duplicated or reopened (a `DISMISSED` pair stays dismissed).

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
CURATED → OpenAlex → DBLP → ORCID → Scopus → Web of Science → MANUAL
```

* For each canonical field, the first available non-empty value in this order is used.
* Canonical fields are recomputed after source-record changes, except fields recorded in `curation` (field-level, decision #125; before Phase 15 `is_curated` protected the whole record, #90). Scopus and WoS are placed after ORCID so existing canonical values do not change; the placement is reassessed with real data (#110).
* `MANUAL` is a provenance type, **not** automatically more authoritative than API sources; it is the final fallback (so manual-only publications still have metadata).
* `OTHER` means "no usable type information", so it does not outrank a known type family from a lower-priority source (decision #26). Within one source, the oldest record wins.
* A DOI already owned by another publication is skipped when selecting the canonical DOI (canonical DOIs are unique).
* `curation` protects deliberately human-curated canonical fields; `is_curated` is true while any field is curated.
* Field-level information is limited to curated fields (their basis and evidence, #125); provenance of imported values is preserved by source records.
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
* From Phase 15: the basis of the entry (`INDEPENDENT` or the provider it was derived from) and supporting evidence (DOI, publisher or repository URL) — required (#125); retyping provider data never makes it independent (#124)

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
  scopus/    client, mapper        (Phase 15)
  wos/       client, mapper        (Phase 15)
  jcr/       client, mapper        (Phase 15; journal metrics)
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
* Use a free API key from configuration when set (`OPENALEX_API_KEY`, sent as `Authorization: Bearer`); the key is optional and requests are keyless otherwise (decision #32).
* Validate response content; retry/backoff on 429/5xx.
* A merged author ID is resolved to the ID OpenAlex returns and works are fetched with it; the stored identity is not changed automatically (identities are admin-managed) and a warning is reported (decision #33). Detection relies on OpenAlex's **documented** 301 redirect for merged IDs. A live check on 2026-09-28 of OpenAlex's documented merged example (`A5092938886` → `A5006060960`) returned **404** instead of a redirect, so such a merged-away ID currently fails safely as `IDENTITY_NOT_FOUND` with no writes. The redirect path is covered by a simulated response, not a real recorded redirect.
* A fetch that returns fewer works than OpenAlex's `meta.count` for the query is an incomplete fetch (failure, decision #34). The author's `works_count` is not used for this check (it can differ from the works query count).

## 13.4 DBLP

* Use the **DBLP SPARQL endpoint** (`sparql.dblp.org`) with SPARQL JSON results.
* Do **NOT** use `dblp.org/pid/{pid}.xml`, the normal DBLP search endpoint, or DBLP mirrors (they currently return bot-protection HTML).
* Retrieve publications **authored** by the professor's PID (editor-only records are excluded).
* Record key → `external_id`; map title, year, DOI(s), venue and record type.
* Throttle conservatively (one request at a time, 1–2 s apart); handle 429 and other failures.
* The PID must identify a `dblp:Person`: a PID with no triples is `IDENTITY_NOT_FOUND`; a disambiguation page (`dblp:AmbiguousCreator`, whose records belong to several people) or any other non-person creator is `IDENTITY_INVALID` — both are fetch failures with no writes (decision #37).
* Three validated SPARQL requests per identity: identity check, authored records (one row per record), and author signatures (display names in `signatureOrdinal` order). Records and authors are queried separately because a single joined query is ~20× slower (decision #38).
* Completeness (decisions #38, #41): `meta.result-size-total` is required on every dblp result; the delivered rows must equal it (fewer → `INCOMPLETE`, more → invalid). The author-signature result must refer only to records in the records result, and every record must have at least one author signature (otherwise the fetch is incomplete).
* Implementation stays isolated behind the DBLP source client so the access method can change without affecting the rest of the system.

## 13.5 ORCID

* ORCID Public API, v3.0 works endpoint: `/v3.0/{orcid}/works`.
* Request JSON with `Accept: application/json` (default is XML) and validate the content type.
* One source record per work summary (put-code): `external_id = {orcid}:{put-code}`.
* Use only external identifiers with relationship `self` (e.g. ignore `part-of` ISSNs).
* Handle missing years and in-source duplicates (several put-codes for the same work).
* Anonymous public access is sufficient; public-API registration is optional.
* Verified against the live API in Phase 6: `/works` returns the complete list of work summaries in one response (no paging — e.g. 1,351 summaries, equal to the counts in `/record`), so completeness rests on full structural validation; a truncated body fails JSON parsing (decision #45).
* Identity validation happens on the works request itself, before any work is processed (decision #42): the iD's ISO 7064 checksum (no request is sent for an invalid iD); 404 (error 9016) → `IDENTITY_NOT_FOUND`; 409 (deactivated, error 9044 — verified live; locked records are documented as 409) → `IDENTITY_INVALID`; the response `path` and every work-summary `path` must name the requested iD.
* A deprecated (merged) iD — documented as a 301 to the primary record — fails safely as `IDENTITY_INVALID` naming the primary iD; redirects are not followed and nothing is written (decision #43).
* Title = `title.title.value` only; the subtitle stays in `raw_metadata` (decision #44). Author names are not available in work summaries. A put-code listed twice is ingested once.
* For the administrator's identity preview only, the record holder's public display name is read from `/v3.0/{orcid}/person` (anonymous, same identity checks); a name that is not public is shown as absent (decision #69). Synchronization still uses `/works` only.

## 13.6 Scopus (Phase 15)

* Elsevier Scopus Search API, `query=AU-ID({id})`, STANDARD view; completeness against `opensearch:totalResults`. Author Retrieval API for identity checks (merged authors: HTTP 300/301). Headers `X-ELS-APIKey` and, outside the institutional IP range, `X-ELS-Insttoken`.
* Implemented in stage 15.3 (#131), tested with synthetic fixtures only — **not yet validated against the live API**:
  * Paging: offset paging (`start`/`count`, 200 per page) in a fixed ascending order, `sort=+orig-load-date,+coverDate` (an unprefixed sort field is descending); fewer distinct documents than reported, a changing total or an empty page before the total is INCOMPLETE; nothing is written for an incomplete fetch. No unique identifier is a documented sort field, so ties may reorder between pages; such gaps surface as INCOMPLETE and the next run retries.
  * Beyond Elsevier's 5,000-result offset limit the author is fetched again with cursor pagination (#133): release notes 2018-06-21 (forward only, mutually exclusive with `start`, Scopus subscribers only) and Getting Started guide V1 (2023-09-07) p. 51 (`cursor=*` first, then each response's URL-encoded `cursor/@next`, or the `next` navigation link). The cursor is taken from the validated `next` link (same API host — http:80 as in Elsevier's examples or https — path `/content/search/scopus`, one cursor, no `start`, same query/view/sort/count) and/or `cursor/@next` (both must agree); requests are always built against the configured base URL, never by following the link. Elsevier documents no end-of-results marker, so the fetch ends when the distinct documents reach `opensearch:totalResults`; a missing continuation, an empty page, a page of only repeated documents, a repeated or malformed cursor, a changing total or more pages than the total allows fail the fetch. A refused cursor request (HTTP 400/403) keeps the fail-safe: INCOMPLETE with an actionable message, nothing written.
  * To confirm with a real key (stage 15.9): the JSON spelling and position of `cursor/@next` (no published JSON example shows it), the presence and form of `next` links and of `opensearch:totalResults` in cursor responses, the last page, the compatibility of `sort` with `cursor`, and subscriber entitlement.
  * Records: `external_id` is the EID `2-s2.0-<SCOPUS_ID>`; title, DOI, cover-date year and source title are mapped; type family from `subtype` + `prism:aggregationType`. The STANDARD view gives only the first author (`dc:creator`), so no author list is built from it (kept in `raw_metadata`); ISSN/eISSN, source id and cited-by count stay in `raw_metadata` (journal linking in stage 15.6).
  * Identities: a Scopus Author ID is any string of 1–20 digits (Elsevier publishes no length; 20 is an application safety limit), verified by the API preview when credentials are configured, otherwise manually from the author's scopus.com profile URL (it must name the same Author ID); every synchronization revalidates the author with the Author Retrieval API before any record is accepted; a replaced (merged) profile fails the task and is never followed or transferred.
  * Citations: one `citation_observations` row per Scopus source record per successful synchronization task, written after the complete ingestion.
  * Failures: 401 → `AUTH_FAILED`, 403 → `NOT_ENTITLED`, 429 → `QUOTA_EXCEEDED` (an exhausted weekly quota, `X-ELS-Status: QUOTA_EXCEEDED`, is not retried). Every Scopus failure message is fixed text plus validated values; no Scopus response body, header or free-text field reaches task errors or logs (#132).
* Data access follows the institution's Scopus entitlement; the use follows Elsevier's "Scopus institutional repositories, research information systems, VIVO" use case, subject to written confirmation (§22.3.4).

## 13.7 Web of Science (Phase 15)

* Web of Science Starter API, Institutional Member plan (#108); `GET /documents?db=WOS&q=AI={ResearcherID}`, `limit` ≤ 50; completeness against `metadata.total`. Header `X-ApiKey`. `AI=` coverage is validated in live testing (#109).
* Implemented in stage 15.4 (#134) from Clarivate's OpenAPI specification (version 1.0.0, read 2026-10-30), tested with synthetic fixtures only — **not yet validated against the live API**:
  * Request: `https://api.clarivate.com/apis/wos-starter/v1/documents?db=WOS&q=AI=(<ResearcherID>)&limit=50&page=<n>&sortField=LD+A,PY+A` (pages from 1; load date then publication year ascending, `+` percent-encoded). Paging: the result must contain as many distinct documents as `metadata.total`; a page without documents before the total, repeated UIDs, a changing total, an answered page or page size other than requested, more hits than the page size, or a document failing validation (`uid` `WOS:…`) fail the fetch; nothing is written for an incomplete fetch. Clarivate documents no paging limit; an application safety limit of 10,000 documents per ResearcherID (200 requests of the 5,000/day plan) fails the fetch as INCOMPLETE. No unique identifier is a documented sort field, so ties may reorder between pages; such gaps surface as INCOMPLETE.
  * Identities: a ResearcherID is 1–3 letters, 4 digits and a year (`A-1009-2008`, `AAG-1344-2019`; Clarivate's examples — the specification states no format), upper-cased. Verified by the API preview when credentials are configured (first page of the `AI=` search: the author name carrying the ResearcherID and the document total; no linked document → not found; documents none of which lists the ResearcherID → invalid), otherwise manually from the author's Web of Science record URL (`https://www.webofscience.com/wos/author/record/<ResearcherID>` or `…/rid/<ResearcherID>`, which must name the same ResearcherID; stored as the canonical `…/rid/` link). The Starter API has no researcher-profile endpoint, so every synchronization revalidates through the documents: only documents whose `names.authors[].researcherId` equals the ResearcherID are attributed (others skipped with a warning); if none of the found documents lists it, the task fails and nothing is written. `AI=` finds the documents linked to the ResearcherID, which need not be every publication of the researcher.
  * Records: `external_id` is the accession number `uid`; title, DOI, `source.publishYear`, `source.sourceTitle`, authors (`names.authors[].displayName`, joined with "; " because WoS names contain commas; none → null) are mapped; type family from `types[]` (proceedings paper → conference; article/review → journal only with an ISSN/eISSN and no ISBN; book chapter, book; arXiv DOI → preprint; everything else OTHER). Identifiers (ISSN, eISSN, ISBN, PMID), ResearcherIDs, links and Times Cited stay in `raw_metadata`; abstracts are excluded at any depth (`abstract`, `abstracts`, `abstract_text`).
  * Citations: one `citation_observations` row per WoS source record per successful synchronization task (`provider` WOS, `database` WOS, `citations[db=WOS].count`), written after the complete ingestion; a complete fetch in which no document carries `citations` (a plan without Times Cited, e.g. Free Trial) is NOT_ENTITLED and writes nothing. Times Cited is stored, not displayed (§13.10).
  * Failures: 401 → `AUTH_FAILED`, 403 → `NOT_ENTITLED`, 429 → `QUOTA_EXCEEDED` after retries honouring Retry-After (Clarivate documents 400, 401, 404, 405 and 5xx; 403/429 are classified defensively). Every WoS failure message is fixed text plus validated values; no Web of Science response body, header or free-text field reaches task errors or logs.
  * To confirm with a real key (stage 15.9): `AI=` behaviour and coverage for ResearcherIDs (query form, exact matching), whether `names.authors[].researcherId` is present for linked authors, the empty-result form (200 with `total` 0 is assumed; 404 is treated as a failure), `sortField` with two fields, 403/429 behaviour and rate-limit headers, the Institutional Member plan's Times Cited, and the type mapping on real records.

## 13.8 Journal Citation Reports (Phase 15)

* Web of Science Journals API (`https://api.clarivate.com/apis/wos-journals/v1`, `X-ApiKey`): journals by ISSN, journal profile and history, yearly reports, `/last-updated`. Paid licence (add-on to JCR or InCites); no purchase is authorized by the architecture decisions.
* Stored: the metrics returned directly by the API, published and derived numeric values kept separately; no overall journal quartile is derived (#114). Years: those relevant to stored publication years plus the latest edition (#115). Snapshots: journal, JCR year, revision, normalized payload hash; corrections add a revision (#122). Unfamiliar edition identifiers are stored and reported, never fatal.
* Implemented in stage 15.6 (#137) from Clarivate's OpenAPI specification (`developer.clarivate.com/apis/wos-journal/swagger`, version 1.0.0, read 2026-10-31), tested with synthetic fixtures only — **not validated against the live API**; live ingestion stays blocked by the §22.6 gate:
  * ISSNs: one shared normalizer (`NNNN-NNNC`, ISO 3297 check character). Source records store their journal's ISSNs (`issns`): OpenAlex `primary_location.source.issn`/`issn_l`, ORCID `issn`/`eissn` identifiers with relationship `part-of`, Scopus `prism:issn`/`prism:eIssn`, WoS `identifiers.issn`/`eissn` (DBLP and manual entries have none). Records stored before 15.6 are filled from their `raw_metadata` at the start of each JCR run (only empty `issns`; idempotent).
  * Identification: each ISSN of an ACTIVE publication that no known journal has → `GET /journals?q=<ISSN>&limit=50` (complete against `metadata.total`) → each hit's `/journals/{id}` and `/history`; a hit is kept only when its own ISSNs include the searched one (free-text search). Journals upserted by JCR id; ISSN rows replaced from the profile (`issn` PRINT, `eIssn` ELECTRONIC, `previousIssn` and history-only PREVIOUS, validity years from the history). ISSNs JCR does not know are searched again in later runs (no table records a negative result).
  * Linking (#116): `publications.journal_id` is set when the publication's source-record ISSNs identify exactly one journal and cleared when they identify none or several; only the link changes.
  * Refresh (one JOURNAL_METRICS task per journal with an ACTIVE linked publication; every task references its journal): profile, then the reports of the JCR years selected by D9 as resolved (#115, #138): for each linked ACTIVE publication of year P, JCR year P if the journal's profile lists it, plus the latest year the profile lists; deduplicated; P−1, P+1 and P+2 are never substituted or fetched (a project interpretation, not a Clarivate-defined rule) — all fetched and validated first, then profile and changed reports written in one transaction. A report answered with HTTP 404 is UNAVAILABLE, not absent: Clarivate documents both "not found" and a suppressed title as 404, so it is a task warning that stores nothing and leaves earlier snapshots of that year unchanged. A report whose normalized SHA-256 equals the latest snapshot of that journal and year adds nothing; otherwise revision n+1 with its category metrics (#122). `jcrDataUpdate` (from `/last-updated`), retrieval time and task are recorded.
  * Normalization: metrics as returned (`totalCites`, `jif`, `jifWithoutSelfCitations`, `jif5Years`, `immediacyIndex`, `jci`, `sourceMetrics.jifPercentile`, `suppressed`, `onHold`, `delisted`); derived `jif_value`/`jif_without_self_value` only for plain numbers ("N/A", "<0.1" → NULL). Category rows from `ranks.jif`/`ranks.jci`: name trimmed, collapsed, upper-case; code from the rank's `self`; edition trimmed upper-case or `''` when absent; rank/total parsed only from "n/total" with 1 ≤ n ≤ total; quartile only Q1–Q4; identical duplicate rows collapse, conflicting ones make the report invalid. Editions other than the documented SCIE/SSCI/AHCI/ESCI are stored as returned and counted as task warnings; unusable ranks or quartiles are warnings and never invented.
  * Runs (#123): `SyncService.startJournalMetrics` under the same single-run guard, exclusivity and crash recovery as discovery; triggered by the administrator (`POST /api/admin/sync/journal-metrics`), its own schedule (`JCR_SYNC_CRON`, default 03:00 on the 15th, `SYNC_TIMEZONE`) and after a discovery run that added source records. Outcome independent of discovery coverage: SUCCESS when identification completed and every task succeeded; FAILED when no task succeeded and something failed; PARTIAL_SUCCESS otherwise, including runs without JCR credentials (tasks `NOT_CONFIGURED`, never executed). Counters `journals_checked`, `snapshots_added`, `records_fetched` (reports), `jcr_data_update`. Access failures (401/403/429) stop identification, and the known journals' tasks then record the failure; an unusable content date (server error, or not a calendar date) is recorded as missing and makes the run partial but does not stop identification. With no journal to refresh: FAILED when identification failed, SUCCESS when nothing failed. Admin endpoints `GET /api/admin/sync/journal-metrics/runs[/:id]` report status and counters only, never metric values.
  * Failures: 401 → `AUTH_FAILED`, 403 → `NOT_ENTITLED`, 429 → `QUOTA_EXCEEDED` after retries; fixed messages, no provider text.
  * To confirm with a real key (stage 15.9): ISSN search behaviour and hit precision, the shape of `journalCitationReports` and `ranks` (`self` codes, editions, JCI editions), 404 bodies for suppressed titles, quotas and rate-limit headers.

## 13.9 Provider configuration and credentials (Phase 15)

* Scopus, Web of Science and JCR are core integrations without enable/disable switches. Configuration states describe only the environment, never access: `NOT_REQUIRED` (keyless OpenAlex/DBLP/ORCID), `PRESENT` (credentials set — institutional access and entitlement **not** verified; only a successful fetch shows access works), `NOT_CONFIGURED`, `INCOMPLETE` (e.g. a Scopus institutional token without an API key; reported with a warning naming variables only, never fatal). At run time 401 → authentication failure, 403 → not entitled, 429 → quota exceeded. A missing, incomplete or failing provider never blocks startup or other providers (#129).
* Every publication-discovery run stores a coverage snapshot of the five mandatory providers at start (configuration state and identity count, `sync_runs.provider_coverage`); a provider that cannot be attempted keeps the run from SUCCESS even with zero identities, and so does a licensed provider (Scopus, WoS) whose credentials are `PRESENT` but which was not successfully accessed in that run (no identities, or every task failed) — present credentials do not prove access (`accessConfirmed` stays false). Keyless providers (`NOT_REQUIRED`) are covered without identities. The snapshot — not the current environment — decides the run's outcome and reported coverage (#129, #130).
* Credentials are institution/department-owned (#120), read from environment variables, sent only in headers, and never logged, returned, committed or exposed to the frontend.

## 13.10 Licensed provider data: display and removal (Phase 15)

* Display: Scopus per-publication citation counts to authenticated professors and the administrator with attribution and links; aggregates only in internal admin analytics (#112). Web of Science citation counts and all JCR metrics are displayed only after written Clarivate confirmation (#112, #114); attribution notices and links follow the provider rules.
* Removal: an administrator command-line procedure — read-only dry run with a report and plan fingerprint, explicit approval with that fingerprint, then one transaction (#124). It deletes the provider's source records, citation observations and (JCR) journal data, removes **provider-derived curation entries and provider-derived MANUAL entries** of that provider, recomputes surviving publications from their remaining sources, keeps professor decisions on surviving publications, and deletes — after explicit approval — publications left without independently supported, legally retainable metadata together with their relationships. Only independently supported and legally retainable curated values survive. `VACUUM` is ordinary maintenance outside the transaction, not secure erasure; WAL archives and backups need a separate expiry/purge process (Phase 16).
* **Gate:** no live Clarivate (WoS or JCR) data is ingested before this procedure is complete and the written retention, deletion, backup and display confirmations are on record (§22.6).
  * Enforced in the backend since stage 15.7 (#140): `services/providers/clarivateGate.ts` holds both conditions as code constants, both false, so the gate is closed whatever the environment holds (present credentials do not open it; there is no environment switch); opening it is a reviewed code change made only when both conditions are met and approved. While closed: the Web of Science and JCR clients refuse every request before the network (`BLOCKED`); JCR runs cannot start — admin endpoint (409 `CLARIVATE_GATE_CLOSED`), schedule and after-discovery trigger (skipped), no run created; every Web of Science identity with credentials gets a `NOT_CONFIGURED` task carrying the reason, never executed, and the run's coverage snapshot records WoS as `blocked` (#141) so coverage reports it as blocked by Clarivate policy — not available, its tasks counted as blocked, not "not configured" — while genuinely missing credentials stay `NOT_CONFIGURED`; the WoS identity preview is refused (409 `PROVIDER_BLOCKED`; manual verification is unaffected); the status endpoint and the admin pages show why.

---

# 14. Synchronization (Final)

```text
SyncRun (kind PUBLICATION_DISCOVERY)
   ↓
SyncTask per active ExternalIdentity (OpenAlex, DBLP, ORCID, Scopus, Web of Science)
   ↓
fetch → validate response → normalize → match → write (+ citation observations for Scopus/WoS)

SyncRun (kind JOURNAL_METRICS; independent schedule, counters and reporting — Phase 15)
   ↓
SyncTask per journal (always created with a valid journal)
   ↓
fetch → validate → normalize → snapshot when the payload hash changed
```

Rules:

* One sync run at a time (application-level guard is sufficient initially; PostgreSQL advisory locking is not required).
* Each task fetches its complete result set and validates it **before** writing; a failed fetch writes nothing and marks the task FAILED. Other tasks continue; the run ends as `PARTIAL_SUCCESS`.
* A mandatory provider without credentials yields `NOT_CONFIGURED` tasks; a discovery run with incomplete provider coverage — a licensed provider not configured, incompletely configured, or not successfully accessed in that run — ends `PARTIAL_SUCCESS` and reports coverage per provider, never plain SUCCESS (#117, #129, #130). JCR status never affects discovery runs.
* Runs of both kinds share the single-run guard, crash recovery and admin merge/detach coordination (#82, #91, #123).
* Failed fetches never destroy or alter existing data.
* Missing records are never automatically deleted or unlinked.
* `last_seen_at` is updated only after the task's complete fetch has been validated and that record has been processed successfully (records are written one transaction at a time, so records processed before a later database error keep their refreshed `last_seen_at`).
* Incomplete or failed API responses never cause deletion or unlinking.
* Reruns are idempotent.
* Rejected relationships remain rejected.
* Suppressed publications are not automatically re-linked: matching records are absorbed into them as provenance, but no professor relationship is created for them (decision #30).
* DOI changes do not silently move source records.
* Runs left `RUNNING` by a crash are marked failed at startup.
* `node-cron` is only the scheduler (monthly); synchronization logic is independent of it. The admin can also trigger a sync manually.
* Redis/BullMQ are out of scope.

---

# 15. Users, Authentication & Authorization

## 15.1 Roles

* **ADMIN** (single administrator): manages professors, identities (including manual Scopus/WoS verification with evidence, #118), publications (edit with a declared basis, curate, suppress), duplicate candidates, synchronization (discovery and JCR runs) and analytics; runs provider-data removal from the command line (§13.10).
* **PROFESSOR:** views own profile and publications, approves/rejects pending relationships, adds manual publications, edits permitted own information. Of their profile a professor may edit only their own **name** (`/api/me/profile`); department, designation, login email, activation status and external identities are administrator-managed (decision #67).

## 15.2 Authentication

* JWT stored in an HTTP-only, `SameSite=Lax` cookie (`Secure` in production); never in `localStorage`.
* Passwords hashed with bcrypt/bcryptjs.
* The admin creates professor accounts; a temporary password (CSPRNG, stored only as a bcrypt hash) is **emailed to the professor** through the configured SMTP and is valid for 7 days. The administrator never sees or can retrieve it — the admin sees only the delivery status (`SENT`, `FAILED`, `NOT_CONFIGURED`). The professor must change it at first login; an expired temporary password is refused (`TEMPORARY_PASSWORD_EXPIRED`). If delivery fails the account is kept and the admin can resend: a new temporary password replaces the old one, which stops working at once. Changing the login email of an account that is not yet activated sends a new temporary password to the new address (decision #102, replacing the hand-over of #66).
* The admin account is created, and its password reset, only through the backend command-line utility (§15.4); there is no HTTP endpoint for either.
* No OAuth/SSO, no refresh-token infrastructure.
* Sessions (decision #57): HS256 JWT signed with `JWT_SECRET` (required, at least 32 characters), valid 8 hours. Every authenticated request reloads the user from the database (role, professor link, active state); the token carries no role. It carries a fingerprint of the password hash, so any password change or reset ends every existing session.
* Account rules (decision #58): emails are trimmed and lowercased; passwords are never normalized. Password policy: at least 10 characters, at most 72 bytes (UTF-8), different from the current password. Login errors are generic. A professor account whose linked professor is inactive cannot sign in and loses its sessions. While `must_change_password` is set, only the current-user, change-password and logout operations are allowed.
* Login, password change and recovery endpoints are rate-limited per client IP (decision #59; in-process memory, so limits are per backend instance and reset on restart).
* State-changing API requests that carry an `Origin` header other than `CORS_ORIGIN` are refused (`403 ORIGIN_NOT_ALLOWED`), in addition to the `SameSite=Lax` cookies and JSON-only request bodies; requests without `Origin` (non-browser clients) are unaffected (decision #62).

## 15.3 REST boundaries

```text
/api/health
/api/auth/*     login, logout, current user, change password, professor password recovery (request, verify, reset)
/api/me/*       authenticated professor's own data (no professor IDs in URLs)
/api/admin/*    ADMIN role only
```

Request input is validated with Zod. Errors use one consistent JSON error shape.

## 15.4 Password recovery (decisions #53–#56)

**Professors — emailed one-time code.**

* `POST /api/auth/password-recovery/request` sends a 6-digit code from a cryptographically secure generator to the account's email address. The response is identical for every address (unknown, administrator, inactive or unlinked professor, or eligible). Only a PROFESSOR account with a linked, active Professor is eligible; administrators never are.
* The code is valid for 10 minutes and stored only as a keyed HMAC. At most one code per 60 seconds per account. A recovery window lasts until an hour has passed since the last code was sent; within it at most 5 codes are sent and at most 5 verification attempts are allowed **in total** — a replacement code does not restore the attempt budget (decision #61). While the budget is used up, no further code is generated or sent and nothing is recorded, so the window cannot be extended; the request still receives the same public response (decision #64). A new code replaces the previous one. Limits are enforced with atomic database updates, so concurrent requests cannot bypass them.
* `POST /api/auth/password-recovery/verify` with the correct code sets a short-lived reset token (at most 10 minutes, never beyond the code's expiry) in an HTTP-only cookie limited to the recovery path. It is bound to that issuance of the code (a later code, even with the same digits, invalidates it) and cannot be used as a session (decision #63).
* `POST /api/auth/password-recovery/reset` consumes the code atomically (only one reset succeeds), applies the password policy, clears the code state and ends every existing session. The user is not signed in automatically.
* Every password change (change-password, recovery, admin command-line reset) clears a pending code and its attempt state, so an earlier reset token can no longer be used; send limits are kept (decision #63).
* Email is sent through generic SMTP (`SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASSWORD`, `MAIL_FROM`); changing provider (e.g. a Gmail app password → institute SMTP) changes configuration only. Without SMTP configuration every recovery request answers `503 RECOVERY_UNAVAILABLE`, and professor sign-in emails report `NOT_CONFIGURED` (§15.2). The same mailer sends both kinds of email.

**Administrator — command-line utility only.** `npm run admin -- create` and `npm run admin -- reset-password` run on the backend host with database access. Passwords are entered at a hidden prompt or piped with `--password-stdin` (never as arguments); the target admin email must be confirmed; the same policy and hashing apply; a reset ends all admin sessions. More than one admin, or none for a reset, is refused. There is no email or HTTP recovery for the administrator.

Codes, reset tokens, passwords and password hashes never appear in logs, responses or command output. SMS, phone numbers, two-factor authentication, OAuth/SSO and refresh tokens are not part of recovery.

---

# 16. Analytics

Default analytics count **APPROVED** relationships to **ACTIVE**, non-preprint canonical publications, without double-counting source records.

* Overview: total professors, total unique publications, pending verifications, last sync time
* Approved publications per professor
* Publications by year
* Source statistics: records per source (including Scopus and Web of Science), unique canonical publications after merging
* Citation aggregates (internal, administrator only): Scopus per-provider aggregates; Web of Science aggregates only after written Clarivate confirmation (#112). JCR-based analytics only after licence confirmation (#114)
* Synchronization statistics: successful/failed runs, records fetched/added/updated

---

# 17. Frontend

* Public: `/login`
* Professor: dashboard, profile, publications, pending verification, add publication
* Admin: dashboard, professors (+ identities, with manual verification evidence), publications, duplicate candidates, synchronization (discovery and JCR runs, provider coverage and configuration status), analytics
* Phase 15 display rules: provider citation counts and JCR metrics only as allowed by §13.10, with the required attribution
* Implemented in stage 15.7 (#139): Synchronization shows the five discovery providers' configuration (credentials present or not — never "access works"), and each run's provider coverage from its stored snapshot (configuration at start, outcome, access confirmed, complete). Journal metrics (JCR) have their own page and navigation entry (configuration, refresh, run history, per-journal tasks): status and counters only, no metric value. Scopus citation counts are shown to the administrator (publication detail) and to professors (their publications) as "N citations in Scopus · as of <date>" with the record and cited-by links Scopus provided (https scopus.com links only; none invented), the latest observation per Scopus record and the highest when a publication has several. Admin analytics add internal Scopus aggregates (counted publications, each once; per professor). Web of Science Times Cited and JCR metrics are not returned by any API nor shown anywhere. Professors now see every source of their publications, Scopus and Web of Science included.

No UI features beyond the required workflows.

---

# 18. Testing Expectations

* **Vitest** for backend unit and integration tests; **Supertest** for route/authorization tests.
* Normalization and matching are pure functions with extensive unit tests (Phase 3).
* From Phase 15 (decision #119 as clarified by the owner, #127): only **synthetic** fixtures are committed to Git; real recorded API responses — including OpenAlex, DBLP and ORCID responses — stay local and uncommitted. The real OpenAlex, DBLP and ORCID recordings committed in Phases 4–6 remain in the repository and its history; whether to replace them with synthetic fixtures is an open owner decision (§22.7). Automated tests never call live APIs.
* Phase 15 adds cross-provider matching, citation-observation, JCR snapshot and provider-data removal tests (§22.8).
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
| 8 | Authentication | ADMIN/PROFESSOR, JWT, HTTP-only cookie, password hashing, temporary password, forced password change, route protection, professor email-code password recovery, admin command-line account creation and recovery. Backend only; the login and recovery screens are built in Phase 14. |
| 9 | Professor Management | Professor creation, profile, external identity management, identity activation/deactivation, professor deactivation (no hard delete). |
| 10 | Verification Workflow | PENDING/APPROVED/REJECTED, approval/rejection, reversible rejection, authenticated ownership. |
| 11 | Manual Publication Addition | Manual entry through the same pipeline; test exact match, DOI match, uncertain match, DuplicateCandidate, later API discovery. |
| 12 | Synchronization | SyncRun, SyncTask, node-cron, one-sync-at-a-time guard, retries, failure handling, idempotency, last-seen tracking. |
| 13 | Analytics | Required admin statistics following the preprint policy. |
| 13B | Admin Publication & Duplicate Management | Backend for the §15.1 publication administration and §8.5 duplicate-candidate resolution: publication search and details, canonical metadata editing (curation), suppression/restoration, candidate listing, dismiss, merge, source-record detach; merge/detach coordinated with synchronization. Inserted 2026-10-26 (decision #95, resolving #29). Backend only. |
| 14 | Frontend Integration | Admin and professor workflows, pending verification, manual addition, sync status, analytics. |
| 15 | Scopus, Web of Science and JCR Integration | Scopus and Web of Science as first-class publication sources through the existing normalization, matching, canonicalization and provenance pipeline; provider-specific citation observations; JCR journal identity and historical journal metrics; institutional API provisioning; admin and professor interface changes; tests. Inserted 2026-10-30 (decision #103). **PLANNED — architecture approved with conditions (D1–D19, §22.7); implementation awaits separate owner approval and external confirmations.** |
| 16 | Final Testing & Deployment | End-to-end testing, edge cases, security checks, production configuration (including provider credentials and network access from §22), deployment preparation, documentation, demo readiness. Deployment provider chosen here. Was Phase 15 until 2026-10-30 (decision #103). |

Each phase ends with: what was implemented, files changed, design decisions, test results, known limitations — and an update to `PROJECT_PROGRESS.md`.

---

# 20. Deferred Decisions

These are intentionally **not** decided yet and must remain marked as deferred until decided and logged:

* Fuzzy matching (only after real data shows need; candidates only).
* PostgreSQL advisory locking (only if multiple backend instances are ever used).
* Startup catch-up sync (optional; Phase 12).
* Exact monthly schedule time (Phase 12).
* Whether analytics count the `OTHER` type family (Phase 13).
* ORCID public-API client registration (optional).
* Hard deletion of professors.
* Deployment provider (Phase 16).
* Phase 15: architecture decisions D1–D19 approved with conditions (§22.7); institutional and provider confirmations listed there remain open.

---

# 21. Definition of Done

* Admin and professor authentication work.
* Admin fully manages professors and external identities.
* Publications collected from OpenAlex, DBLP, ORCID, Scopus and Web of Science; normalized; deduplicated into canonical records with preserved provenance; per-provider citation observations and JCR journal metrics stored as approved (Phase 15), with provider-data removal available before any live Clarivate ingestion.
* Uncertain matches surface as DuplicateCandidates; no unsafe automatic merges.
* Professors approve/reject discoveries and add manual publications; manual publications are never silently duplicated by later discoveries.
* Manual and monthly synchronization work; failures preserve existing data.
* Administrator analytics available.
* No PDFs, full papers or abstracts stored; no AI/ML features.

---

# 22. Phase 15 — Scopus, Web of Science and JCR Integration (PLANNED)

> **Status (2026-10-30):** architecture decisions D1–D19 **approved by the owner with conditions** (§22.7, Decision Log #107–#125). Implementation is **not** approved yet and needs the owner's separate approval. Stage 15.0 has aligned sections 1–21 with these decisions (#126); the `CLAUDE.md` change is proposed and awaits the owner's approval. Architecture approval authorizes no purchase, subscription or provider agreement. Labels used below: **[Confirmed]** = owner requirement; **[Verified]** = read in official provider documentation or the institute's published pages on 2026-10-30; **[Proposed]** = engineer's design, not yet approved; **[Pending]** = needs an owner decision; **[Institution]** / **[Provider]** = only IIT (ISM) Dhanbad, Elsevier or Clarivate can confirm.

## 22.1 Confirmed requirements [Confirmed]

1. Scopus and Web of Science (WoS) are mandatory, first-class publication sources alongside OpenAlex, DBLP and ORCID.
2. They use the existing shared normalization, matching, canonicalization and provenance pipeline; no separate matching engine.
3. A publication found by several providers maps to one canonical publication whenever the existing rules (§8) establish identity.
4. Every provider's identifiers and provenance are preserved independently (one source record per provider record).
5. Scopus and WoS citation counts are separate observations; one provider's count never overwrites another's.
6. JCR is a dedicated journal-metrics integration (not a discovery source), linked to canonical publications through journal identity.
7. Historical JCR editions are preserved; new metrics never overwrite earlier observations.
8. No full papers, PDFs or abstracts are stored (§3.2 unchanged).
9. Professor verification and admin approval rules are unchanged (§11): discoveries are PENDING, uncertain matches are never attributed automatically.
10. PostgreSQL, Prisma and the application architecture are kept.
11. The three integrations are core, not feature-flagged: no `*_ENABLED` switches. Missing credentials → `NOT_CONFIGURED`; invalid credentials → an authentication failure; an unavailable provider never blocks startup or other providers; a run with missing provider coverage is never reported as complete success.

## 22.2 Conflicts with frozen decisions (resolved: approved as #107–#125; §1–§21 aligned in stage 15.0, #126; `CLAUDE.md` amendment awaiting approval)

Kept as the record of what Phase 15 changed.

| Frozen item | Conflict |
|---|---|
| §2 objective 15 "free API access" | Scopus API data access requires an Elsevier institutional entitlement; WoS Starter's institutional plans require a WoS subscription (the free trial plan returns no Times Cited); the JCR (Web of Science Journals) API is a paid add-on to JCR or InCites. |
| §6 "exactly 9 core tables; no citation tables"; `CLAUDE.md` data rule | Citation observations, journal identity and JCR metrics need five new tables (14 in total under the recommended design, §22.5). `CLAUDE.md` would need a matching amendment once approved. |
| §1.1, §2 (3), §3.1, §5, §13, §21 | Name only OpenAlex, DBLP and ORCID. |
| §9 metadata priority | Has no position for SCOPUS or WOS. |
| §6.9 / §14 sync outcome | SyncTask/SyncRun have no state for "provider not configured". |
| #68 identity preview | Saving an identity requires a successful live preview, impossible without credentials (§22.4, D12). |
| §6.10 / §12.4 deletion rules | A provider-data removal procedure (licence compliance, D15/D18) would delete source records and possibly publications; today publications are never deleted except by an admin merge. |
| §9 "No field-level provenance flags"; #90 whole-record curation | Safe provider-data removal needs, for each administrator-edited field and each manual entry, its declared basis (independent or derived from a named provider), and recomputation must skip only edited fields (D19). |
| §6 exclusion of audit/history tables | Compliance evidence for a removal is therefore proposed as a report file produced by the removal tool, not a database table (D18). |

## 22.3 Verified access and licensing model

### 22.3.1 Institute listing [Verified; entitlement unconfirmed]

`library.iitism.ac.in/e-resources.php` (read 2026-10-30) lists, under subscribed e-resources: **Scopus** "November 2025 – October 2026", **Journal Citation Report** "August 2025 – July 2026", **InCites** "April 2026 – March 2027"; and, in the separate table of resources provided under **ONOS** (One Nation One Subscription), **Web of Science Lease Access** "January – December 2025". On 2026-10-30 the published Scopus period ends the next day, the JCR and WoS periods have passed, and only InCites is within its published period. A listing is not proof of a current entitlement (renewals may simply not be published), and none of these listings says anything about API use. **[Institution]** current entitlements, renewals, the nature of the ONOS WoS "lease access", and whether API use is covered must be confirmed.

### 22.3.2 Provider access [Verified unless marked]

| | Scopus (Elsevier) | WoS Starter API (Clarivate) | JCR — Web of Science Journals API (Clarivate) |
|---|---|---|---|
| Portal | dev.elsevier.com — "My API Key" | developer.clarivate.com — register an application, subscribe to the API | developer.clarivate.com (same flow) |
| Entitlement | A new key has **no data access**; data follows the institution's Scopus entitlement, recognized by institutional IP or an Elsevier-issued institutional token | Free Trial (anyone; 1 req/s, 50/day, **no Times Cited**), Free Institutional Member (members of WoS-subscribing organizations; 5 req/s, 5,000/day, Times Cited), Free Institutional Integration (administrative staff only; 5 req/s, 20,000/day). Whether ONOS-based WoS access qualifies is **[Provider]** | Paid licence, add-on to JCR or InCites; one plan, 5 req/s; approval by Clarivate Sales/Product |
| Base URL / auth | `https://api.elsevier.com/content/…`; `X-ELS-APIKey`, plus `X-ELS-Insttoken` outside the institutional IP range (never in browser code, never in URLs) | `https://api.clarivate.com/apis/wos-starter/v1` (v2 adds ORCID-fed `contributors`); `X-ApiKey` | `https://api.clarivate.com/apis/wos-journals/v1` (confirmed by Clarivate's own `wosjournals-python-client`); `X-ApiKey` |
| Operations used | Scopus Search `query=AU-ID(…)`; Author Retrieval (identity check, merged-author 300/301) | `GET /documents?db=WOS&q=AI=…`, `GET /documents/{uid}`; `limit` ≤ 50 | `/journals` (q ≥ 3 chars incl. ISSN; `jcrYear`, `edition`), `/journals/{id}`, `/journals/{id}/history`, `/journals/{id}/reports/year/{year}`, `/categories`, `/categories/{id}`, `/last-updated` (returns only `{"jcrDataUpdate": "YYYY-MM-DD"}`, the date of the last content update for the whole database; the specification has no per-journal, per-year or per-report release or version identifier). `/last-updated` is in the specification but not in the client's endpoint list **[Provider: verify with a key]** |
| Quotas | Scopus Search 20,000/week, 9 req/s; Author Retrieval 5,000/week, 3 req/s; 200 results/page (STANDARD), 25 (COMPLETE); 5,000-item offset limit without cursor paging | per plan (above) | 5 req/s; ≤ 50 journals per search |

### 22.3.3 Field coverage against `NormalizedPublication` [Verified from API specifications]

| Field | Scopus Search (STANDARD) | WoS Starter `/documents` |
|---|---|---|
| Stable record ID | `dc:identifier` (SCOPUS_ID) / EID | `uid` (`WOS:…`) |
| Title | `dc:title` | `title` |
| DOI | `prism:doi` | `identifiers.doi` |
| Year | `prism:coverDate` | `source.publishYear` |
| Venue | `prism:publicationName` | `source.sourceTitle` |
| Type family inputs | `subtype` + `prism:aggregationType` | `types[]` + `sourceTypes[]` |
| ISSN / eISSN | `prism:issn`, `prism:eIssn` | `identifiers.issn`, `identifiers.eissn` |
| Author names | first author only (`dc:creator`); full list only in COMPLETE view (25/page) | full list `names.authors[].displayName` (with `researcherId`) |
| Citation count | `citedby-count` | `citations[{db, count}]` (institutional plans only) |
| Abstract | not requested | not requested (Starter does not return it) |

Both cover every field the pipeline needs; WoS Starter's author list is fuller than Scopus STANDARD. The Expanded API adds addresses, funding and full records, none of which the project stores.

**`AI=` (Author Identifier):** Clarivate's search help describes it as searching the Author Identifiers table of a record for a Web of Science ResearcherID or ORCID iD; Starter's specification lists `AI` without format details. Coverage therefore depends on documents being linked to the researcher's profile (claimed and curated profiles are most complete), so a ResearcherID query can miss documents. **[Provider: verify with a key]** whether Starter's `AI=` matches ResearcherIDs exactly as in the web interface.

### 22.3.4 Licensing for an authenticated institutional portal

**Scopus — Elsevier use case "Scopus institutional repositories, research information systems, VIVO"** (dev.elsevier.com/ir_cris_vivo.html, policy.html) [Verified]:
* Applies when "the application needs to be operated by, or on behalf of an academic institution that has a subscription for Scopus".
* Permitted metadata includes record IDs, DOI, author IDs and names, title, source title, ISSN, document type, **citation count**, **author metrics** (H-Index, document count, citation count, cited by) and journal metrics (SNIP, SJR, CiteScore).
* Storage: "allowed to store this metadata in its IR/CRIS in perpetuity even after it has cancelled its Scopus license" (no new retrieval afterwards).
* Display: the metadata "can be shown to any IR/CRIS user"; abstracts, CAS numbers, author emails, non-English language tags, chemical names and controlled vocabulary may not be displayed publicly.
* Citation counts: individual counts are part of the permitted, displayable metadata; "Cited-by counts can be aggregated for use in internal bibliometric analysis, but not be aggregated for external display."
* Attribution: Scopus identified as the source, with links to the Scopus record and cited-by list (Scopus Attribution Guide); counts must be labelled as coming from Scopus.
* For this project: showing per-publication Scopus counts to signed-in professors and the admin, and aggregate citation figures in admin analytics, fit the use case; publishing aggregated Scopus citation figures outside the portal does not. **[Provider/Institution]** written confirmation that a departmental portal qualifies as a CRIS operated on behalf of IIT (ISM), that Scopus Search by `AU-ID` is the agreed retrieval method, that monthly refresh is acceptable (the weekly refresh rule belongs to the separate "showing cited-by counts on your website" use case), and that the perpetual-storage clause is in the institute's licence.

**Clarivate — Product/Service Terms, "Web of Science APIs"** (version 3.8, last updated 17 July 2024; the Clarivate Legal Center still links this document on 2026-10-30) [Verified]:
* Structure: the Product/Service Terms supplement the general Clarivate Terms and apply to products identified in the customer's **order form**; licence levels and use rights apply "unless stated otherwise on your order form". The developer-portal Terms of Use page carries no operative text. The institute's actual order form is therefore decisive **[Institution]**.
* Data "may only be accessed by the same users who are permitted access by your subscription"; on termination "any data you downloaded must be deleted unless we provide written authorization or mutually agree in writing otherwise".
* Data Integration use right: "extract, maintain and display data in an institutional repository on websites owned, maintained and controlled by you, including your intranet and your own publicly-accessible websites", limited to works by the institution's staff, students or affiliated researchers; **only publicly accessible** repositories are limited to the public-display field list. Times Cited (Core Collection) and JCI are in that public list; **Journal Impact Factor, JIF quartiles and category ranks are not**.
* Attribution: "© [year] Clarivate" notice on every page or table showing WoS content; "View record in Web of Science" links; counts shown as "Web of Science Times Cited: N".
* No use with AI/ML or content generation.
* For this project: internal display of WoS Times Cited and of JCI, JIF and quartiles to authenticated institution members appears permitted under Data Integration, but JIF/quartile display is not expressly addressed for intranets and the order form may differ. **[Provider/Institution]** written confirmation required before JIF, quartiles and ranks are displayed or used in analytics; D6/D8 stay pending.

## 22.4 Architecture [Approved 2026-10-30, with the conditions in §22.7]

* **Integrations (source isolation, §5):** `integrations/scopus/` (Scopus Search `AU-ID`, STANDARD view, completeness against `opensearch:totalResults`; Author Retrieval for identity checks and merged-author redirects 300/301), `integrations/wos/` (Starter `/documents`, `db=WOS`, `q=AI=…`, `limit=50`, completeness against `metadata.total`), `integrations/jcr/` (Journals API). All use the shared HTTP helper (§13.2) and §13.1 response validation; credentials only in headers.
* **Mappers → `NormalizedPublication`:** per §22.3.3. Preprint databases (WoS `PPRN`) are not queried; `raw_metadata` excludes abstracts.
* **Provider status (no feature flags):** each provider resolves to `CONFIGURED` or `NOT_CONFIGURED` from its credentials; at run time `AUTH_FAILED` (401), `NOT_ENTITLED` (403, or a plan without required fields such as WoS without `citations`), `QUOTA_EXCEEDED` (429) and ordinary fetch failures are recorded per task. Startup never fails for missing provider credentials.
* **Publication discovery runs (five providers):** one task per active identity for OpenAlex, DBLP, ORCID, SCOPUS and WOS; a provider without credentials yields `NOT_CONFIGURED` tasks; the run cannot finish as plain SUCCESS while coverage is incomplete (D11). JCR is **not** part of these runs.
* **JCR refresh lifecycle (independent schedule and status, shared engine — D17):** a JCR refresh is a `SyncRun` of kind `JOURNAL_METRICS` with one `SyncTask` of kind `JOURNAL_METRICS` per journal, triggered by the admin, by its own schedule, and after discovery runs add publications in journals without metrics. Discovery runs are kind `PUBLICATION_DISCOVERY`; every status, history and analytics query filters by kind, so a missing JCR key (`NOT_CONFIGURED` JCR run) never appears in discovery status. It reuses the existing single-run guard, crash recovery and admin merge/detach coordination (#82, #91) — runs of either kind are serialized, which is required because a JCR refresh updates publication journal links.
* **JCR snapshots (D16):** each yearly report is normalized (fields in §22.5, numbers and strings canonicalized, ranks sorted) and hashed (SHA-256). A snapshot is added only when the hash differs from the latest snapshot of that journal and JCR year; it records `jcrDataUpdate`, retrieval time and the run task. Corrections therefore become a new revision; earlier revisions are never updated.
* **Citation observations:** appended per source record per successful, fully validated fetch (Scopus `citedby-count`, WoS `citations[db=WOS].count`); never overwritten or merged across providers.
* **Journal identity:** journals keyed by JCR id; print, electronic and previous ISSNs from `/journals/{id}` and `/history` map publications to journals via source-record ISSNs; an ISSN set that maps to more than one journal is left unlinked and reported.
* **Identity verification (D12):** Scopus Author IDs and WoS ResearcherIDs may be verified either by the existing API preview (#68) when credentials exist, or manually by the administrator against the provider's public profile page, with the method, evidence URL and admin recorded; manually verified identities are re-checked by the first synchronization (the identity must resolve to an author/profile before anything is written). Credentials are required for synchronization, not for manual verification.
* **Provider-data compliance tooling (D15, D18, D19):** an administrator command-line procedure, built in Phase 15 before any live Clarivate data is ingested:
  1. *Plan (dry run, read-only):* classifies everything derived from the provider — its source records (with `raw_metadata`), citation observations, journal identities, JCR snapshots and category metrics, journal links, identities of that source, and run messages that quote provider data — and every affected publication as (a) supported by another source, (b) supported only by this provider but with administrator-edited fields, or (c) supported only by this provider. It writes a report (internal IDs and counts, no provider content) and a plan fingerprint.
  2. *Approval:* the removal runs only with the fingerprint of an unchanged plan (re-computed inside the transaction; any difference aborts).
  3. *Removal (one transaction, under the sync guard):* deletes the provider's citation observations, source records and (JCR) journal data; clears journal links; **removes every curation entry and MANUAL entry whose basis names that provider**; recomputes surviving publications from their remaining sources — only curated values that are independently supported and legally retainable (basis `INDEPENDENT` with retained evidence and not excluded by the administrator in the plan, or `PRE_PHASE15`) survive; handles (b) and (c) as decided in D18; never deletes a publication in (a); keeps professor decisions on every surviving publication. `INDEPENDENT` values are listed in the dry-run report for review, and their retention remains subject to Clarivate's written confirmation.
  Lineage needed for this (D19): source records already identify the provider of every imported record, and non-curated canonical values are recomputed from the remaining records. What is missing is, for each administrator-edited canonical field, its **basis** — `INDEPENDENT` (supplied from first-party knowledge or independent evidence, with an evidence note) or derived from a named provider (`SCOPUS`, `WOS`, `JCR`, …) — and, for each MANUAL source record, the same basis declared by the professor. A value whose basis names the removed provider is treated as that provider's data; provider-derived manual and curated values always keep the name of their actual provider. `INDEPENDENT` values must carry stored evidence (e.g. DOI, publisher or repository URL); a declaration is not proof of legal independence and does not by itself satisfy Clarivate's deletion requirements — the administrator reviews the evidence in the removal plan, and the treatment of such values remains subject to Clarivate's written confirmation. Curated values that existed before Phase 15 cannot derive from Scopus, WoS or JCR (none were ingested) and are recorded as `PRE_PHASE15`.
  *Manual re-entry (D18):* re-entry never reclassifies provider data automatically. The professor uses the normal manual-addition flow with a required basis declaration and evidence (DOI or publisher/repository URL) and is not shown the provider's metadata to copy; a MANUAL record declared as derived from the removed provider counts as that provider's data; the administrator reviews declared-independent entries in the removal plan. Matching and the professor's APPROVED/MANUAL relationship work exactly as today (§12).
  *Unsupported publications:* deleted together with their professor relationships (APPROVED and REJECTED alike) and their duplicate-candidate references (SET NULL as today); the removal report lists the affected relationship and professor IDs and decisions without provider content. A later rediscovery from an independent source starts again as PENDING (a rejection is not remembered, since no table may hold it).
  *Other copies:* database rows are deleted in the removal transaction. A `VACUUM` may be run separately afterwards (never inside the transaction) as ordinary database maintenance; neither `DELETE` nor `VACUUM` is a secure physical-erasure guarantee (old row versions can persist on disk, in WAL and in backups until overwritten or expired). `sync_tasks.error_message` texts of the provider's tasks are cleared; application logs must contain identifiers only (no titles or other provider content) and host log files are rotated within a short retention; there is no application cache, and provider-data API responses are sent with `Cache-Control: no-store`; developer copies (development/test databases, local recorded responses kept out of Git by D13, scratch files) are deleted by procedure; the application has no export feature, and any administrator export is inventoried and deleted by procedure; **database backups and WAL archives** cannot be edited; they need a separate expiry/purge process within a defined retention period, with the removal report kept alongside the backups so the removal is re-applied after any restore (Phase 16 backup policy). That process, the retention period, the handling of first-party information and the retained removal reports require **written Clarivate confirmation before any live Clarivate data is ingested**.

## 22.5 Schema changes [Approved design — not yet made]

Five new tables (9 → **14**) under the recommended D17 (reuse of `sync_runs`/`sync_tasks`) and with JCR categories stored inline; 15 with a separate category table; 16 with separate JCR run tables; 17 with both. All types follow the existing conventions (uuid keys, `timestamptz(3)`, snake_case).

**New enums / values:** `SCOPUS`, `WOS` in `identity_source` and `publication_source`; `NOT_CONFIGURED` in `sync_task_status`; `sync_run_kind` (`PUBLICATION_DISCOVERY`, `JOURNAL_METRICS`); `sync_task_kind` (`IDENTITY_DISCOVERY`, `JOURNAL_METRICS`); `identity_verification_method` (`API_PREVIEW`, `MANUAL_PROFILE`); `journal_issn_kind` (`PRINT`, `ELECTRONIC`, `PREVIOUS`); `jcr_rank_metric` (`JIF`, `JCI`).

**Modified tables**
* `external_identities`: + `verification_method` (`API_PREVIEW` | `MANUAL_PROFILE` | `PRE_PHASE15`; existing rows `PRE_PHASE15` because pre-Phase-15 provenance was not recorded — the development identities predate the #68 preview flow), `verification_evidence_url` text null, `verified_by_user_id` uuid null FK users SET NULL (D12; #129).
* `publication_source_records`: + `issns` text[] not null default `{}` (normalized `NNNN-NNNX`), GIN index; backfilled from stored OpenAlex/ORCID `raw_metadata`. + `entry_basis` text null and `entry_evidence` text null, required for new MANUAL records (basis `INDEPENDENT` or a provider name) and null for provider-imported records (D18/D19); existing MANUAL records get `PRE_PHASE15`.
* `publications`: + `journal_id` uuid null FK journals SET NULL, index (D10); + `curation` jsonb not null default `{}` (D19): one entry per administrator-edited canonical field (`title`, `year`, `venue`, `type_family`, `author_names_display`, `doi`) holding its basis (`INDEPENDENT`, a provider name, or `PRE_PHASE15`) and an evidence note; current state only, no history. Only fields whose value actually changes are recorded. `is_curated` stays and becomes "curation is non-empty"; canonical recomputation updates only fields without a curation entry (a change to the whole-record behaviour of #90).
* `sync_runs`: + `kind` (default `PUBLICATION_DISCOVERY`), + `provider_coverage` jsonb null (discovery runs only; CHECK), + `jcr_data_update` date null, + `journals_checked`, `snapshots_added` int default 0 (JCR counters kept separate from the publication counters); index (kind, started_at).
* `sync_tasks` (current: `sync_run_id` NOT NULL FK CASCADE, `identity_id` NULL FK external_identities SET NULL, `source identity_source` NOT NULL, no professor column, no unique constraint besides the key, indexes on `sync_run_id` and `identity_id`): + `kind sync_task_kind NOT NULL DEFAULT 'IDENTITY_DISCOVERY'`; + `journal_id uuid NULL` FK journals ON DELETE SET NULL, index; + `snapshots_added int NOT NULL DEFAULT 0`; `source` DROP NOT NULL; hand-written `CHECK ((kind = 'IDENTITY_DISCOVERY' AND source IS NOT NULL AND journal_id IS NULL) OR (kind = 'JOURNAL_METRICS' AND source IS NULL AND identity_id IS NULL))` — `identity_id` and `journal_id` stay nullable because history rows outlive deleted identities and removed journals; `UNIQUE (sync_run_id, journal_id)` (one task per journal per run; identity tasks have a NULL journal and NULLs are distinct — equivalent to the originally proposed partial index, which Prisma 6 cannot model and would drop as drift; #128). Run/task kind agreement is enforced in code and tests (a CHECK cannot span tables). Newly created `JOURNAL_METRICS` tasks must always reference an existing journal: task creation rejects a missing `journal_id` (application rule, tested); only historical tasks may later hold a NULL journal after provider-data removal. Engine changes: task planning, task ordering (currently by identity professor/source/ID) and the "identity removed" failure path must branch on kind.

**New tables**

| Table | Purpose | Columns | Keys and constraints | Retention / deletion | Why no existing table fits |
|---|---|---|---|---|---|
| `citation_observations` | One provider's citation count for one source record at one time | id, source_record_id, provider (`publication_source`), database text null (WoS `citations[].db`), count int ≥ 0, observed_at, sync_task_id null, created_at | FK source record CASCADE; FK sync task SET NULL; UNIQUE (source_record_id, sync_task_id); index (source_record_id, observed_at), (provider, observed_at) | Append-only; never updated; follows its source record on merge/detach; removed with the provider's data | `raw_metadata` is replaced on every sync (history lost); `publications` has no per-provider series |
| `journals` | JCR journal identity | id, jcr_id text, name, jcr_title, iso_title, publisher_name null, first_issue_year null, frequency null, language null, created_at, updated_at | UNIQUE (jcr_id) | Profile fields updated in place (not metrics); deleted only by provider-data removal (publications SET NULL) | `publications.venue` is display text, not an identity; JCR id is the provider's journal key |
| `journal_issns` | Print, electronic and previous ISSNs with validity years | id, journal_id, issn char(9), kind, valid_from_year null, valid_to_year null, created_at | FK journal CASCADE; UNIQUE (journal_id, issn); index (issn) | Replaced from `/journals/{id}` and `/history` on refresh; cascades with the journal | One journal has several ISSNs over time; an ISSN shared by two journals must be detectable as ambiguous |
| `journal_metric_snapshots` | One revision of one journal's JCR report for one JCR year | id, journal_id, jcr_year int, revision int, payload_hash char(64), jcr_data_update date null, retrieved_at, sync_task_id null; directly returned: total_cites, jif_text, jif_without_self_text, jif_5_years, immediacy_index, jci, avg_jif_percentile, suppressed, on_hold, delisted; derived: jif_value, jif_without_self_value (numeric parses of the text values) | FK journal CASCADE; FK sync task SET NULL; UNIQUE (journal_id, jcr_year, revision); index (journal_id, jcr_year, retrieved_at) | Insert-only: a new revision only when the hash differs from the latest; never updated or deleted except by provider-data removal | Metrics per year and revision cannot live on `journals` without overwriting history |
| `journal_category_metrics` | Per-category rank, quartile and percentile within a snapshot | id, snapshot_id, metric (`JIF` \| `JCI`), category_name (trimmed, whitespace-collapsed, upper-case as JCR prints it), category_code null (from the rank's `self`, e.g. `RO_SCIE`), edition text NOT NULL DEFAULT '' (`''` = not provided, as for JCI rows in the schema), rank_text, rank int null, rank_total int null, quartile null, percentile null | FK snapshot CASCADE; `UNIQUE (snapshot_id, metric, category_name, edition)` — an ordinary constraint Prisma can model, since `edition` is never NULL (a nullable column would allow duplicates under PostgreSQL's default NULLS DISTINCT; `NULLS NOT DISTINCT` (PostgreSQL ≥ 15) is not expressible in Prisma 6 and would be dropped as drift); `CHECK (quartile IN ('Q1','Q2','Q3','Q4'))` hand-written; no allowlist on `edition`: an unfamiliar edition identifier is stored as returned (trimmed, upper-case) and reported as a task warning for review, never a synchronization failure | Insert-only with its snapshot | JSON cannot enforce uniqueness per category/edition/metric or be filtered by quartile reliably |

## 22.6 Sub-stages

| Stage | Content | Needs credentials? |
|---|---|---|
| 15.0 | Owner decisions (§22.7, approved); §1–§21 aligned (#126); `CLAUDE.md` amendment proposed, awaiting approval | No |
| 15.1 | **External milestone:** institutional confirmation (current entitlements, ONOS WoS, API rights, display terms) and API provisioning (Elsevier key + institutional token; Clarivate application with Starter institutional plan and Journals API) | Institution/provider |
| 15.2 | Schema extension and migrations; provider-status configuration (`NOT_CONFIGURED`, auth/entitlement failures); identity verification evidence — **implemented 2026-10-30, migrations not yet applied (#128)** | No |
| 15.3 | Scopus client, mapper, identity checks, discovery task — synthetic fixtures — **committed 0b00b6f (#131–#133); live validation outstanding** | No (live validation needs 15.1) |
| 15.4 | WoS Starter client, mapper, identity checks, discovery task — synthetic fixtures — **committed 68ffb99 (#134); live validation outstanding** | No (live validation needs 15.1) |
| 15.5 | Five-provider matching and duplicate-prevention tests; citation observations — **committed 3e82f62 (#135, #136); results in §22.9** | No |
| 15.6 | JCR journal identity, ISSN linking, metric snapshots (revision + payload hash), JCR runs as `JOURNAL_METRICS` run/task kinds — **committed 91c910f (#137, #138); live validation outstanding** | No (live validation needs 15.1) |
| 15.7 | Admin (provider status, JCR status, identities, sync tasks, metrics) and professor interface changes, with provider attribution — **implemented 2026-10-31, pending review (#139)** | No |
| 15.8 | Provider-data compliance tooling (plan/dry run with report and fingerprint, approved removal, recomputation, basis and evidence lineage (`publications.curation`, `entry_basis`/`entry_evidence`)) and its tests — **must be complete before 15.9 ingests live Clarivate data** | No |
| 15.9 | Live validation with real credentials (including `AI=` coverage and JCR endpoints); regression; documentation; completion report | **Yes** |

Stages 15.2–15.8 can proceed before access is granted; 15.9 cannot complete without it. **Gate before any live Clarivate ingestion (WoS or JCR):** stage 15.8 complete and written confirmation from the library/Clarivate of the applicable data retention, deletion, backup and display requirements. Scopus live ingestion requires the institutional confirmations listed in §22.7.

## 22.7 Owner decisions (approved 2026-10-30, with conditions)

Architecture approval only: no purchase, subscription, licence or provider agreement is authorized by these decisions. Decision Log #107–#125.

| # | Decision | Conditions |
|---|---|---|
| D1 | Exceptions to §2 objective 15 (free API access) and the 9-table rule approved; target **14 tables** | Architecture only; §1–§21 and `CLAUDE.md` amended in stage 15.0 |
| D2 | WoS Starter **Institutional Member** plan initially | Conditional on confirmation that IIT (ISM)'s ONOS arrangement qualifies |
| D3 | WoS identity = ResearcherID, searched with `AI=` | Actual search coverage validated in live testing (15.9) |
| D4 | SCOPUS and WOS after ORCID in canonical metadata priority | Reassessed after comparing real metadata completeness/reliability; no unnecessary changes to existing canonical records |
| D5 | Citation observation on every successful, fully validated provider fetch | Provider counts kept independently |
| D6 | Scopus per-publication citation counts shown to authenticated professors and admin with attribution and links; aggregates only in internal admin analytics | WoS citation display waits for written Clarivate confirmation |
| D7 | Author-level metrics excluded from Phase 15 | — |
| D8 | Store the JCR metrics returned directly by the API (JIF, JIF without self-citations, 5-year JIF, JCI, immediacy index, total citations, per-category ranks/quartiles/percentiles, suppressed/on-hold/delisted) where available; published values and derived numeric values stored separately | No overall journal quartile without an explicit product requirement; all user-facing JCR display subject to licence confirmation |
| D9 | JCR years relevant to publication years in the database, plus the latest available edition | Resolved 2026-10-31 (#138): for publication year P, JCR year P when the journal lists it, plus the latest available JCR year, deduplicated; no P−1/P+1/P+2 — a project interpretation, not a Clarivate rule |
| D10 | `publications.journal_id` set only when ISSN matching identifies exactly one journal | Ambiguous publications stay unlinked |
| D11 | Discovery runs with missing mandatory-provider credentials end `PARTIAL_SUCCESS` with explicit provider coverage | JCR synchronization independent |
| D12 | Admin verification of Scopus/WoS identities from authoritative provider profile evidence, recording method, evidence URL and admin | Identity revalidated in its first synchronization before records are accepted |
| D13 | Only synthetic API fixtures committed | Real licensed responses never committed |
| D14 | Production API applications and credentials institution/department-owned, managed per each provider's credential rules | No sharing of individual account passwords |
| D15 | Provider-specific removal tooling implemented in Phase 15 | Before any live Clarivate data is ingested |
| D16 | JCR snapshot identity = journal, JCR year, revision, normalized payload hash | Global `jcrDataUpdate` date and retrieval time recorded |
| D17 | JCR runs reuse `SyncRun`/`SyncTask` with explicit run and task kinds | Independent scheduling, counters and reporting |
| D18 | Dry run → fingerprinted approval → transactional removal | Manual re-entry declares actual origin and evidence; retyping never makes provider data independent; if no independently permitted metadata remains after the re-entry window, the publication and its professor relationships may be deleted after explicit admin approval (decisions are lost; rediscovery starts PENDING); Clarivate must confirm handling of first-party information and retained removal reports |
| D19 | `publications.curation` (per-field basis and evidence) instead of `curated_fields`; `entry_basis`/`entry_evidence` on MANUAL source records | Independent, provider-derived (with the actual provider) and `PRE_PHASE15` values kept distinct; `INDEPENDENT` is not automatic proof of legal independence; evidence retained |

**Open owner decision (from the clarified D13, #127):** the real OpenAlex, DBLP and ORCID recordings committed in Phases 4–6 (24 files under `backend/tests/fixtures/`) predate the synthetic-only rule. Options: keep them (history already public), or replace them with synthetic fixtures going forward (history unchanged either way).

[Institution]/[Provider] confirmations still outstanding — see the list in the owner-facing summary and `PROJECT_PROGRESS.md`: current entitlements and renewals (Scopus period ends 2026-10-31 as published; JCR and WoS published periods have passed), ONOS WoS eligibility for Starter institutional plans, API rights under each licence, who may request keys and the Scopus institutional token, use from a server outside the campus network, the governing order forms, permitted internal display of citation counts and JCR metrics, Elsevier CRIS fit and refresh frequency, and Clarivate data retention, deletion, backup, first-party information and removal-report requirements.

## 22.8 Acceptance criteria

* Scopus and WoS records flow through the unchanged §8 rules; cross-provider tests (all five sources + MANUAL) show one canonical publication per paper and DuplicateCandidates for uncertain cases.
* Every provider keeps its own source records, identifiers and citation observations; no overwrite across providers or over time.
* JCR snapshots are stored per journal, JCR year and revision, with ranks per category, edition and metric; unchanged reports add no revision; corrections add one; ambiguous ISSNs are never linked; JCR runs are reported separately from discovery runs.
* Missing credentials → `NOT_CONFIGURED`, invalid → authentication failure; other providers continue; discovery runs report incomplete coverage.
* The provider-data removal procedure is tested before live Clarivate data is ingested: dry run (read-only, report without provider content, plan fingerprint); approval with an unchanged fingerprint only (a changed plan aborts); transactional removal; no loss of publications supported by other sources. Required tests:
  * **Provider-derived admin edits removed:** a curation entry whose basis is the removed provider is deleted and the field is recomputed from the remaining sources (or emptied when none supplies it).
  * **Independently evidenced edits:** an `INDEPENDENT` curation entry with evidence is listed for review in the dry run, retained by default, and removed when the administrator excludes it in the approved plan; `PRE_PHASE15` entries are retained.
  * **Canonical recomputation:** a publication supported by OpenAlex/DBLP/ORCID/Scopus/MANUAL and the removed provider keeps its other source records and its canonical fields are recomputed from them by §9 priority, curated fields excepted.
  * **Manual re-entry:** an `INDEPENDENT` manual entry with evidence for a publication otherwise supported only by the removed provider attaches to the same canonical publication by the §8 rules (no duplicate publication), so the publication survives; a manual entry whose basis names the removed provider is removed with that provider's data.
  * **Approvals preserved:** an APPROVED (and a REJECTED) `ProfessorPublication` on a publication that survives removal keeps its status, origin and decision metadata.
  * **Unsupported publications:** a publication without independently supported, retainable metadata is deleted with its relationships only in the approved plan; its candidates' references become NULL.
* No credentials in Git, logs, responses, errors or frontend code; automated tests make no live provider requests; no real licensed response is committed.
* New `JOURNAL_METRICS` tasks are always created with a valid journal; unfamiliar JCR editions are stored and reported, never fatal.
* Manual entries and administrator edits record their basis (provider-derived values keep their provider; independent values keep evidence); canonical recomputation changes only non-curated fields; existing canonical records are not changed unnecessarily by the new priority.
* No live Clarivate ingestion before stage 15.8 is complete and the written retention, deletion, backup and display confirmations are on record; WoS citation and JCR displays only after their written confirmations. No institutional API purchase or provider agreement is made or implied by the project.
* All existing tests pass; new tests cover adapters, mappers, validation failures, quotas/retries, partial failures, citations, JCR snapshots and compliance removal.
* Live validation (15.9) with real credentials recorded in `PROJECT_PROGRESS.md`; displays follow the attribution rules and the written licence confirmations.

## 22.9 Stage 15.5 validation results (2026-10-30, #135)

Validated with synthetic responses of all five providers (`backend/tests/fixtures/synthetic/fiveProviders.ts`, built from the shapes each client validates; no real response) through the real provider clients, discovery services and synchronization engine, and the unchanged §8/§9 rules (`backend/tests/crossProvider/fiveProviders.test.ts`). No matching rule or schema was changed.

* **One canonical publication per paper:** a journal article reported by OpenAlex, DBLP, ORCID, Scopus, WoS (title case, trailing punctuation, DOI case and form, WoS's final-year 2022 vs 2021) and a manual entry ends as one publication with six source records, matched by DOI; a conference paper DBLP and ORCID report without a DOI attaches by exact title + year. Canonical metadata follows §9 (OpenAlex first; WoS's year, venue spelling and "Surname, I" author list stay on its own source record).
* **Uncertain cases are candidates:** a DOI-less record typed OTHER (Scopus editorial) → separate publication + candidate; a wrong DOI under an unrelated title (ORCID) → not merged, candidate (#22); preprint (arXiv DOI) and published version → separate + candidate.
* **Decisions and provenance:** a manual APPROVED entry stays APPROVED/MANUAL; APPROVED and REJECTED decisions survive later synchronizations, which add no publications, links or candidates and leave canonical metadata unchanged; every provider keeps its own source record and identifier.
* **Order:** twelve discovery orders (every rotation of OpenAlex, DBLP, ORCID, Scopus, WoS and the manual entry, forwards and backwards) give identical publications, canonical metadata and candidates for papers without conflicting evidence.
* **Wrong-DOI record discovered first — found in 15.5, fixed by the #27 exception (#136):** a record carrying another paper's DOI under an unrelated title, ingested before that paper, becomes the DOI's canonical owner; before the fix every later record of the genuine paper was refused against it (#22) and, with the canonical owner taking precedence (#27) and no rule-3 fallback after a blocked DOI match (§8.3), each provider's record became its own publication (five in the test, each with its own PENDING link). Now the first record of the genuine paper still starts its own publication (refused against the wrong-DOI owner, as before) and every later one attaches to it by its source-record DOI: in all twelve orders the genuine paper is one publication with the manual entry's APPROVED link, the wrong-DOI record stays separate with one candidate, and the professor sees each once. Remaining, by design: the canonical DOI stays with whichever publication claimed it first (canonical DOIs are unique, §9), so in wrong-DOI-first orders the genuine paper shows no canonical DOI until an administrator resolves the candidate. Engine tests cover one, several (no merge, candidates) and no qualifying source-record owner, unrelated titles and preprints, canonical-owner precedence when it is not refused, decisions and provenance.
* **Remaining order dependence (documented, rule unchanged): canonical-year drift.** Rule 3 compares the incoming year with the publication's canonical year, which moves when a higher-priority source arrives: DBLP 2023 (no DOI), WoS 2022, OpenAlex 2021 merge when DBLP comes first and give two publications + a candidate when DBLP comes last. Both outcomes are safe; no change (comparing with every source-record year would loosen rule 3).
* **Citation observations:** Scopus and WoS counts for the same paper stay separate (own provider, own source record); every successful fetch appends one observation per source record and earlier ones are never changed; a retried task adds none (UNIQUE source record + task); an incomplete Scopus fetch or a failed WoS fetch adds none while the other providers continue; observations follow their source record through administrator merge and detach, are deleted with it (as the stage 15.8 removal tool will), and survive deletion of their run (task reference NULL); counts never enter canonical metadata and are not returned by the publication API.
