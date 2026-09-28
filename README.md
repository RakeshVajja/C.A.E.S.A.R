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
cp .env.example .env          # set DATABASE_URL for your machine
npm install
npx prisma migrate dev        # apply migrations to the dev database
npm run db:seed               # optional demo data (idempotent)
npm run dev                   # http://localhost:5001/api/health

# Frontend (separate terminal)
cd frontend
cp .env.example .env.local
npm install
npm run dev                   # http://localhost:3000
```

The backend validates its environment at startup and exits with a clear message if something is missing or invalid.

## Checks

| | Backend | Frontend |
|---|---|---|
| Type check | `npm run typecheck` | `npm run typecheck` |
| Tests | `npm test` | — |
| Lint | — | `npm run lint` |
| Build | `npm run build` | `npm run build` |

Backend tests (Vitest + Supertest) never call external APIs: live network access is blocked in tests, which replay recorded responses from `backend/tests/fixtures/`. Database tests use a separate database — `DATABASE_URL`'s name plus `_test` (e.g. `cse_research_hub_test`), or `TEST_DATABASE_URL` if set — which is created and migrated automatically; tests refuse to touch any database whose name does not end in `_test`.

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
