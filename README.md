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
npm run prisma:generate
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

Backend tests (Vitest + Supertest) never call the database or external APIs unless a test explicitly sets that up.
