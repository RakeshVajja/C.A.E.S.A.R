# CSE_Research_Hub — Implementation Rules

## Documents and their roles

| File | Role |
|---|---|
| `Project_plan.md` | **Authoritative** requirements and architecture (frozen). |
| `CLAUDE.md` (this file) | Implementation rules and constraints. |
| `PROJECT_PROGRESS.md` | Current execution state, phase tracking and decision log. |
| `frontend/AGENTS.md` | Next.js-version-specific rules for frontend work. |

If code or instructions conflict with `Project_plan.md`, the plan wins. Report the conflict instead of silently resolving it.

## Role

You are the implementation engineer. The project architect decides architecture. If you believe a better approach exists, report it before implementing it.

## Phase discipline

* Follow the phase order in `Project_plan.md` §19 and `PROJECT_PROGRESS.md`.
* Work only on the current active phase; one phase at a time.
* Do not start a phase until the previous phase is validated and marked complete.
* Update `PROJECT_PROGRESS.md` when a phase is completed.
* At the end of each phase report: what was implemented, files changed, design decisions, test results, known limitations.

## Architecture rules

* Do not change frozen architectural decisions silently. Any change needs approval and a Decision Log entry.
* If a genuine architectural blocker appears, **stop and report it** rather than redesigning.
* Exactly 9 core tables. Do not add `SourceRecordProfessor`, `Author`, citation, embedding/ML, queue or audit/history tables.
* Keep source-specific API logic isolated in `integrations/<source>/`.
* Services use Prisma directly; no repository abstraction layer.
* The sync engine must stay independent of the scheduler.
* Deferred decisions (`Project_plan.md` §20) stay deferred until decided and logged.

## Scope and technology rules

* Do not expand scope without approval.
* Do not introduce discarded technologies: Redis, BullMQ, Axios, GraphQL, Docker/Kubernetes, microservices, OAuth/SSO, refresh-token infrastructure, `pg_trgm`, vector databases.
* Do not introduce AI/ML/LLM/embedding-based matching or fuzzy auto-merging.
* Do not replace PostgreSQL or Prisma.
* Do not add dependencies that are not required by the current phase.

## Data rules

* Never store full papers, PDFs, abstracts, references or full-text content — metadata only.
* Preserve publication provenance: every canonical publication keeps all its source records and identifiers.
* Do not silently discard source-specific metadata (keep it in `raw_metadata`, minus excluded content).
* Matching must be deterministic and explainable (record `match_method` / `match_detail`).
* Never auto-merge uncertain matches; create a `DuplicateCandidate`.
* Use the single shared DOI and title normalization functions everywhere.
* Approval/rejection applies to the professor–publication relationship, never globally.
* Synchronization never changes an existing relationship status; rejected stays rejected.

## Reliability rules

* HTTP 200 is not proof of success. Validate content type and body; HTML, malformed or error payloads are fetch failures.
* A failed fetch must never be interpreted as "zero publications" and must never delete or alter existing data.
* Never delete or unlink records because they are missing from a later response.
* Synchronization must be idempotent.

## Security rules

* Professor identity always comes from the authenticated token, never from URL or request parameters.
* JWT only in an HTTP-only cookie; never in `localStorage`.
* Never commit secrets; configuration comes from environment variables.

## Working rules

* Inspect existing code before modifying it; reuse working code.
* Do not rewrite or delete functioning code merely for stylistic reasons.
* Frontend work must also follow `frontend/AGENTS.md` (read the docs shipped with the installed Next.js version first).
* Keep changes focused on the current task.
* Run type checking, linting and relevant tests after implementation; report results honestly.
* Automated tests must not call live external APIs; use recorded fixtures.
