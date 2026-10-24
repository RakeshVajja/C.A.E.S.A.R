# CSE_Research_Hub

Departmental research publication management for professors: aggregates publication metadata from OpenAlex, DBLP and ORCID, deduplicates it into canonical records, and lets professors verify their publications.

| Document | Purpose |
|---|---|
| `Project_plan.md` | Authoritative requirements and architecture |
| `CLAUDE.md` | Implementation rules |
| `PROJECT_PROGRESS.md` | Current phase and decision log |

## Layout

```text
backend/    Express + TypeScript + Prisma (PostgreSQL) API
frontend/   Next.js (App Router) + Tailwind UI
```

## Prerequisites

* Node.js ≥ 20.9
* A local PostgreSQL instance (development uses a database named `cse_research_hub`)

## Setup

```bash
# Backend
cd backend
cp .env.example .env          # set DATABASE_URL and JWT_SECRET (see below)
npm install
npx prisma migrate dev        # apply migrations to the dev database
npm run db:seed               # optional demo data (idempotent)
npm run admin -- create --email admin@your-institute.example   # the admin account (hidden password prompt)
npm run dev                   # http://localhost:5001/api/health

# Frontend (separate terminal)
cd frontend
cp .env.example .env.local
npm install
npm run dev                   # http://localhost:3000
```

The backend validates its environment at startup and exits with a clear message if something is missing or invalid. `JWT_SECRET` is required (at least 32 characters); `.env.example` shows how to generate one.

## Authentication

Backend only for now (the login and recovery screens come in Phase 14). Sessions are an HTTP-only cookie holding an 8-hour token.

| Endpoint | Purpose |
|---|---|
| `POST /api/auth/login` | `{ email, password }` → session cookie |
| `POST /api/auth/logout` | clears the session cookie |
| `GET /api/auth/me` | the signed-in user |
| `POST /api/auth/change-password` | `{ currentPassword, newPassword }` (required first when the password is temporary) |
| `POST /api/auth/password-recovery/request` | `{ email }` → emails a 6-digit code to an eligible professor |
| `POST /api/auth/password-recovery/verify` | `{ email, code }` → short-lived reset cookie |
| `POST /api/auth/password-recovery/reset` | `{ newPassword }` → sets the password and ends all sessions |

Passwords: 10 characters minimum, 72 bytes (UTF-8) maximum, different from the current one.

Recovery codes expire after 10 minutes; at most one code per minute and 5 per hour are sent, and 5 verification attempts are allowed per hour-long recovery window in total (a new code does not reset them). State-changing requests must send JSON, and browsers may only send them from `CORS_ORIGIN`.

### Professor management (admin)

`/api/admin/professors` lists, creates (with a login account and a one-time temporary password the admin hands over), edits and activates/deactivates professors (never deletes them). `POST /api/admin/professors/:id/account` adds an account to a professor without one. External identities are previewed first — `POST …/:id/identities/preview` with `{ source: "OPENALEX" | "DBLP" | "ORCID", externalId }` checks the identity with the source and writes nothing — then saved with the returned `previewToken` (`POST …/:id/identities`, valid 15 minutes). Deactivating or deleting an identity removes the PENDING publication links it discovered; approved and rejected ones stay. Professors can read their own profile and change their name at `/api/me/profile`.

### Verifying publications (professors)

`GET /api/me/publications` lists the signed-in professor's discovered publications (`?status=PENDING|APPROVED|REJECTED`, `limit` up to 200, `offset`; `status=APPROVED` is the verified list). `PATCH /api/me/publications/:relationshipId` with `{ status: "APPROVED" | "REJECTED", expectedStatus }` records a decision (a stale `expectedStatus` answers 409, so concurrent decisions never overwrite each other); a rejection can be reversed later, but nothing returns to pending. `POST /api/me/publications/approve` with `{ relationshipIds: [...] }` (up to 500) approves the pending ones. Synchronization never changes a decision.

### Adding a publication manually (professors)

`POST /api/me/publications` with `{ title, typeFamily: "PREPRINT" | "CONFERENCE" | "JOURNAL" | "BOOK_CHAPTER" | "BOOK" | "OTHER", doi?, year?, venue?, authorNames? }` adds a publication missing from the sources. It goes through the same matching as synchronized data: an existing publication (same DOI, or same title, year ±1 and type) is reused, an uncertain match is flagged for the administrator as a possible duplicate, otherwise a new publication is created. The professor's relationship becomes approved. Only metadata is accepted — no abstracts, full text or files.

### Publications and duplicate candidates (admin)

`GET /api/admin/publications` searches all publications (`q` = title words or a DOI; filters `status`, `typeFamily`, `curated`; `limit`/`offset`), suppressed ones included; `GET /api/admin/publications/:id` shows source records, professor relationships and duplicate candidates. `PATCH /api/admin/publications/:id` edits the canonical title, year, venue, type, authors or DOI and marks the publication curated, so synchronization never overwrites it. `PATCH /api/admin/publications/:id/status` with `{ status, expectedStatus }` suppresses or restores it; records and relationships are kept. `GET /api/admin/duplicate-candidates` lists candidates (`status`, default `OPEN`); `POST …/:id/dismiss` keeps both publications; `POST …/:id/merge` with `{ keepPublicationId }` merges the other publication into it. `POST /api/admin/source-records/:id/detach` moves a wrongly attached record to its own publication. Merge and detach are refused while a synchronization run is in progress.

### Synchronization (admin)

Publications are synchronized from OpenAlex, DBLP and ORCID for every active identity of every active professor — monthly (`SYNC_CRON`, default `0 2 1 * *` = 02:00 on the 1st, in `SYNC_TIMEZONE`, default `Asia/Kolkata`) and on demand with `POST /api/admin/sync` (202; 409 while a run is in progress). `GET /api/admin/sync/runs` lists runs and `GET /api/admin/sync/runs/:runId` shows each identity's task, counts and error. A failed or incomplete source response fails only that identity's task and changes nothing; synchronization never deletes data or changes a professor's decisions. Runs interrupted by a restart are marked failed at startup.

### Analytics (admin)

`GET /api/admin/analytics/overview`, `/professors`, `/years`, `/sources` and `/sync` return the administrator statistics, computed from the stored data on each request. Publication figures count approved, non-suppressed, non-preprint publications, each publication once however many professors or sources report it; per-professor figures count each professor's approved publications (inactive professors included and marked); source figures compare source records with unique publications. Pending verifications count every relationship still awaiting a professor's decision (inactive professors and preprints included, suppressed publications excluded). Publications without a year are reported separately.

### Admin account (command line only)

There is no HTTP endpoint for creating the administrator or resetting its password. On the backend host:

```bash
cd backend
npm run admin -- create --email admin@your-institute.example   # once
npm run admin -- reset-password                                # forgotten admin password
```

Both ask you to confirm the admin email and to type the new password twice at a hidden prompt. For automation, pipe the password instead: `printf '%s\n' "$ADMIN_PASSWORD" | npm run admin -- reset-password --password-stdin --confirm admin@your-institute.example`. Passwords are never accepted as arguments. A reset signs the admin out everywhere.

### Professor password-recovery email (SMTP)

Recovery emails go through any SMTP server configured in `backend/.env` (`SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASSWORD`, `MAIL_FROM`). Without them, recovery is disabled and answers `503`.

* **Gmail (simplest for a demo):** on a personal Google account, turn on 2-Step Verification, create an App Password (Google Account → Security → App passwords), then set `SMTP_HOST=smtp.gmail.com`, `SMTP_PORT=587`, `SMTP_SECURE=false`, `SMTP_USER=<your Gmail address>`, `SMTP_PASSWORD=<the app password>`, `MAIL_FROM="CSE Research Hub <your Gmail address>"`. App passwords are usually unavailable for work or school accounts, and changing the Google password revokes them.
* **Institute SMTP later:** replace those six values with the server details your IT department provides and restart the backend. No code or database change is needed.

Keep real credentials only in `backend/.env` (git-ignored) or the deployment's secret settings.

## Checks

| | Backend | Frontend |
|---|---|---|
| Type check | `npm run typecheck` | `npm run typecheck` |
| Tests | `npm test` | — |
| Lint | `npm run lint` | `npm run lint` |
| Build | `npm run build` | `npm run build` |

Backend tests (Vitest + Supertest) never call external APIs: live network access is blocked in tests, which replay recorded responses from `backend/tests/fixtures/`. They never send email either: SMTP settings are blanked for tests, recovery tests inject an in-memory mailer, and message composition is checked with Nodemailer's stream transport. Database tests use a separate database — `DATABASE_URL`'s name plus `_test` (e.g. `cse_research_hub_test`), or `TEST_DATABASE_URL` if set — which is created and migrated automatically; tests refuse to touch any database whose name does not end in `_test`.

## External sources

| Command (in `backend/`) | Purpose |
|---|---|
| `npm run smoke:openalex -- <author ID>` | Read-only live check: fetch, map and normalize one OpenAlex author's works (no database writes) |
| `npm run fixtures:openalex` | Re-record the OpenAlex test fixtures from the live API |
| `npm run smoke:dblp -- <PID>` | Read-only live check: validate a DBLP PID and fetch, map and normalize its authored records via sparql.dblp.org |
| `npm run fixtures:dblp` | Re-record the DBLP test fixtures from sparql.dblp.org |
| `npm run smoke:orcid -- <iD>` | Read-only live check: validate an ORCID iD and fetch, map and normalize its public works |
| `npm run fixtures:orcid` | Re-record the ORCID test fixtures from the public API |

`OPENALEX_API_KEY` in `backend/.env` is optional; without it OpenAlex requests use the smaller keyless budget.

## Discovery demo (development database)

`backend/scripts/demo-discovery.ts` runs the real discovery pipeline for a professor's identities against the development database and explains the result: source records per source, canonical publications, cross-source matches (DOI vs exact title + year) and duplicate candidates. It calls the existing services unchanged and only reads the database for the report.

```bash
cd backend
npm run demo -- --add "Moshe Y. Vardi" --openalex A5000059818 --dblp v/MosheYVardi --orcid 0000-0002-0661-5773
npm run demo -- --professor "Moshe Y. Vardi"            # live discovery for all identities, then the report
npm run demo -- --professor "Moshe Y. Vardi" --report   # report only, no API calls
npm run demo -- --list                                  # professors and identity ids
```

Options: `--identity <id>` (one identity), `--limit <n>` (examples shown, default 10), `--all` (every publication). Live runs call the public APIs and write to the development database; automated tests never run the demo.
