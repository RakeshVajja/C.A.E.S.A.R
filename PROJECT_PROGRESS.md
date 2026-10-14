# CSE_Research_Hub — Project Progress

> Execution-status file. Architecture and requirements: `Project_plan.md` (authoritative). Implementation rules: `CLAUDE.md`.

## Current Phase

```text
Phase 10 — Verification Workflow
STATUS: COMPLETE (verified and architect-approved; 540/540 tests passing)

Next phase: Phase 11 — Manual Publication Addition (NOT STARTED)
```

## Current Architecture Status

```text
Architecture:   FROZEN
Implementation: IN PROGRESS (Phases 1–10 done)
```

## Phase 10 Report

Professors verify the publications discovered for them (Project_plan.md §11). Backend only (screens in Phase 14). No schema change; matching and ingestion unchanged.

**Implemented** (`backend/`)

* `src/services/verification/verification.ts`
  * `listOwnPublications` — the professor's relationships to ACTIVE publications only (relationships to SUPPRESSED publications are neither listed nor counted, #75); optional status filter (`status=APPROVED` is the verified list); `limit` (default 50, max 200) and `offset`; order: PENDING, APPROVED, REJECTED, then publication year descending with unknown years last, then title, then relationship id; `total` = visible relationships matching the filter, `counts` = per status over all visible relationships (not affected by the filter).
  * `decide` — one conditional `UPDATE` on (relationship, owning professor, visible publication, `expectedStatus`) setting `status`, `decided_at` and `decided_by_user_id` (#72). Allowed: PENDING→APPROVED/REJECTED, APPROVED→REJECTED, REJECTED→APPROVED; never to PENDING. When nothing is updated: 404 `RELATIONSHIP_NOT_FOUND` (missing, another professor's — no detail — or suppressed), 409 `STATUS_CONFLICT` with the current status (stale or concurrent change — always for a valid transition whose conditional update did not match, even if a later change restored the expected status before the lookup), 409 `INVALID_TRANSITION` (requested status equals the current one, #73). The returned item is read after the update, so a decision committed in between may show a newer status (stored state and attribution stay correct; accepted).
  * `bulkApprove` — one conditional `UPDATE` approving the given relationships that are the professor's, visible and PENDING; returns `{ approved, skipped }` without saying which IDs were skipped or why (#74).
  * Response items (#76): relationship `id`, `status`, `origin`, `decidedAt`, `createdAt`; publication `id`, `title`, `year`, `venue`, `typeFamily`, `doi`, `authorNamesDisplay`, `sources` (distinct, in the order OPENALEX, DBLP, ORCID, MANUAL). No raw metadata, identities, users, `decidedByUserId` or other professors' data.
* `src/routes/mePublications.ts` — `GET /api/me/publications`, `PATCH /api/me/publications/:relationshipId` (`{ status, expectedStatus }`), `POST /api/me/publications/approve` (`{ relationshipIds }`, 1–500 unique UUIDs), mounted in the existing `/api/me` router (session, active account, no temporary password; professors only; the professor is the session's own, loaded from the database). Strict bodies and query (a `professorId` or `decidedByUserId` is refused, never used).

**Tests** — 19 new (540 total, all passing): `tests/verification/verification.test.ts` (real test database)

* Access: 401 without a session, 403 for the admin, `PASSWORD_CHANGE_REQUIRED` for a temporary password, 404 for an unlinked professor account; a deactivated professor's session ends (no decision applied); foreign origin, `text/plain` and form bodies refused.
* Listing: only own relationships with exactly the approved fields (raw metadata, other professors, users and attribution never appear); distinct ordered sources with an in-source duplicate; status filter with filtered `total` and unfiltered `counts`; deterministic order (PENDING first, newest year, unknown last, title, id) and paging; invalid query parameters (incl. `professorId`) → 400; SUPPRESSED publications excluded from results and counts, decisions on them 404 and skipped in bulk.
* Decisions: every allowed transition with `decided_at`/`decided_by_user_id` updated each time; to PENDING refused; same status → 409 `INVALID_TRANSITION` without touching `decided_at`; stale `expectedStatus` → 409 `STATUS_CONFLICT`; a lost compare-and-set stays `STATUS_CONFLICT` even when the status is restored before the lookup (deterministic race via a second connection; fails without the fix); strict bodies; another professor's, unknown and malformed IDs → the same 404; one publication approved by A and rejected by B independently; rejection leaves all nine table counts unchanged; concurrent approve + reject → exactly one 200 and one 409; a failing update (temporary trigger in the test database) rolls back and answers a generic 500 for single and bulk decisions.
* Bulk approval: mixed IDs (own PENDING, own REJECTED, another professor's, unknown) → correct counts and attribution, others untouched; empty, duplicate, malformed, 501 IDs → 400; exactly 500 accepted; three concurrent identical requests approve each relationship once (approved 5, skipped 10 in total).
* Resync and cleanup: re-running recorded ORCID discovery after API decisions changes no relationship row (status, `decided_at`, `decided_by_user_id`) and creates no link; identity deactivation removes only PENDING links, APPROVED and REJECTED stay.

**Validation**

* Backend: `lint` ✅, `typecheck` ✅, `build` ✅, `test` 540/540 ✅, `prisma validate` ✅, test database `migrate status` up to date and no drift ✅, no leftover test triggers. Frontend: `lint` ✅.
* Test breakdown (each test counted once): Phases 1–7 **386** · configuration **12** · Phase 8 **82** · Phase 9 **41** · Phase 10 **19** = 540.

**Schema:** none — no migration; still 9 tables. `Project_plan.md` unchanged (the decisions refine §11 without changing it).

**Known limitations / open items**

* No administrator view or override of professor decisions (not an admin role in §15.1); only the latest decision's `decided_at`/`decided_by_user_id` are kept (no history; audit tables excluded).
* Offset paging can shift while decisions are being made; `counts` help the client re-sync.
* Phase 11: a manual entry upgrades an existing PENDING/REJECTED relationship to APPROVED (§12.2); Phase 10's transitions remain the rule for professor decisions.
* Phase 12 must keep synchronization create-only (as `ingestDiscoveredRecords` already is).

## Phase 9 Report

Administrator management of professors, their login accounts and external identities, plus the professor's own profile. Backend only (screens in Phase 14). No schema change.

**Implemented** (`backend/`)

* `src/services/professors/professors.ts` — list (all professors, ordered by name, unpaginated, #70), detail, create (professor + PROFESSOR user in one nested write; role fixed by the server), account for an existing professor without one (transaction with a conditional link, so concurrent requests create exactly one account), profile and email update (one transaction; an email change clears a pending recovery code, send limits kept, #70), activation/deactivation (idempotent; identities and relationships unchanged, #71), own profile read and name update (#67). Duplicate emails → 409 `EMAIL_IN_USE`.
* `src/services/auth/password.ts` — `generateTemporaryPassword()`: 4 × 5 unambiguous characters from `crypto.randomInt` (≈100 bits), within the password policy (#66).
* `src/services/auth/tokens.ts` — identity preview token: HS256, issuer + own audience, 15 minutes, bound to professor, source and normalized submitted identifier (#68).
* `src/services/identities/identities.ts` — preview: normalize with the existing source normalizer, validate with the existing client (OpenAlex author check; DBLP person check; ORCID `/works` + `/person`), show source details, report an existing assignment, return the token; reads only. Save: valid token for that professor, no external request, `verified_at` = preview time, the unique constraint settles conflicts (409 `IDENTITY_IN_USE`). The submitted normalized identifier is stored — a merged OpenAlex ID is not replaced (#33, #68). Deactivate/delete: one transaction removing PENDING relationships discovered through the identity (§12.4); the identity change is conditional, so an identity removed concurrently after the ownership check gives 404 and rolls the transaction back (other database errors are not suppressed). Errors: 400 `INVALID_IDENTIFIER`, 422 `IDENTITY_NOT_FOUND` / `IDENTITY_INVALID`, 502 `IDENTITY_SOURCE_UNAVAILABLE`, all with stable project messages (DBLP: not a single person / disambiguation page; ORCID: deactivated or locked; ORCID: deprecated); no provider message, error code or URL reaches the client — the sanitized detail (e.g. ORCID's user message, a merged record's primary iD) is logged server-side. Preview clients use a 20 s timeout and one retry; synchronization clients are unchanged (#68).
* `src/integrations/openalex/client.ts` — `validateAuthor` also returns the author's `orcid` and `works_count` from the response it already validates (additive). `src/integrations/orcid/` — the identity checks of `/works` moved into a shared section request (behaviour unchanged; all ORCID tests pass) and `fetchPersonName` reads the public name from `/person` (#69).
* Routes: `src/routes/adminProfessors.ts` under the existing admin guards — `GET/POST /api/admin/professors`, `GET/PATCH /api/admin/professors/:id`, `PATCH …/:id/status`, `POST …/:id/account`, `POST …/:id/identities/preview`, `POST …/:id/identities`, `PATCH/DELETE …/:id/identities/:identityId`; strict bodies (unknown fields such as `role` refused); responses carrying a temporary password or preview token are `Cache-Control: no-store`. `src/routes/protected.ts` — `GET/PATCH /api/me/profile` (professors only; profile from the session). `src/app.ts` — `identityClients` option (tests inject replays).
* Fixtures: `tests/fixtures/orcid/person-{carberry,vardi,not-found}.json`, recorded once from the public API (`npm run fixtures:orcid -- person`, read-only; works fixtures not re-recorded).

**Tests** — 41 new (521 total, all passing)

* `tests/professors/professorsAdmin.test.ts` (13, real test DB): every route refuses anonymous users (401), professors (403), admins with a temporary password (403) and foreign origins, without writes or source calls; create returns the temporary password once (`no-store`, policy-compliant, not in logs or later responses), the user is PROFESSOR with forced change, first login is limited until changed; duplicate email → 409 with no orphan rows, 5 concurrent creations with one email → exactly one; strict validation (role, `mustChangePassword`, `isActive` refused); list order, inactive and account-less professors; 404 for unknown/malformed IDs; no delete route; profile edits and clearing; email change normalized, recovery code cleared, send limits kept; an update with a taken email rolls back entirely; `NO_ACCOUNT`; deactivation (repeated) keeps every row, identity flag and PENDING link, ends the session, blocks login, and discovery refuses the identity without a request; reactivation restores login; account for an existing professor (once; concurrent requests → one account, no orphan user; taken email creates nothing).
* `tests/professors/identities.test.ts` (18, recorded responses): OpenAlex preview (no writes; only the author request), merged author (requested/resolved IDs, warning, submitted ID stored), DBLP person/disambiguation/missing and a non-person creator (stable message, no dblp type URIs; detail only in the server log), ORCID name (credit name; given + family), works count and recent works, checksum (no request), nonexistent, deactivated and deprecated (stable messages without ORCID's wording or error code); all nine tables unchanged by successful OpenAlex, DBLP and ORCID previews; HTML with 200, 503, malformed JSON, network error and timeout → 502 without upstream text or writes; unknown professor refused before any request; existing assignment reported; save without further requests and `verified_at` = preview time; expired, tampered, session and other-professor tokens refused; several identities from one source; concurrent saves of one identity for two professors → one 201, one 409; deactivation removes only that identity's PENDING links (idempotent; reactivation restores nothing); deletion keeps APPROVED/REJECTED with `discovered_via` cleared, publications, records and sync history; another professor's path → 404; an identity removed concurrently after the ownership check (deterministic race via a second connection) → 404 for both deactivation and deletion, with the transaction rolled back (fails without the fix); real rollback (temporary trigger blocking the delete) keeps the PENDING link and still reports the database error.
* `tests/professors/meProfile.test.ts` (5): own profile; 401/403/404 cases; name-only edits (department, designation, email, status, other IDs and empty names refused); deactivated professor's session ends.
* `tests/integrations/orcid.client.test.ts` (+2): person name (credit name; given + family), private name → null, 404, path mismatch, deprecated, checksum. `tests/auth/units.test.ts` (+3): temporary passwords; preview token round trip, expiry and separation from session/reset tokens. `tests/integrations/openalex.client.test.ts`: the author assertion now includes `orcid` and `worksCount`.

**Validation**

* Backend: `lint` ✅, `typecheck` ✅, `build` ✅, `test` 521/521 ✅, `prisma validate` ✅, test database `migrate status` up to date and no drift ✅, no leftover test triggers. Frontend: `lint` ✅.
* Test breakdown (each test counted once): Phases 1–7 **386** (unchanged) · configuration **12** · Phase 8 **82** (unchanged) · Phase 9 **41** = 521. The 41 Phase 9 tests are 36 in `tests/professors/` (13 + 18 + 5) plus 5 placed in existing files: 2 ORCID person-name tests in `tests/integrations/orcid.client.test.ts` and 3 unit tests (temporary passwords, preview tokens) in `tests/auth/units.test.ts`. By directory: Phase 1–7 files 388 (386 + 2), `env.test.ts` 12, `tests/auth/` 85 (82 + 3), `tests/professors/` 36.

**Schema:** none — no migration; still 9 tables.

**Known limitations / open items**

* No admin endpoint to reset a professor's password (#66, deferred): recovery is the email-code flow, so a professor without working email recovery (no SMTP, locked window) cannot regain access until that is resolved.
* A synchronization already running when an identity is deactivated or deleted could still create a PENDING link through it (or fail on its foreign key after deletion); Phase 12 (one run at a time, re-checking identities) must account for this.
* Links removed by §12.4 that another identity would also support return only with the next synchronization.
* Previews call the live sources (DBLP is throttled; large ORCID records are large); failures save nothing.
* The temporary password is only in the creation response (`no-store`); the frontend (Phase 14) must not log or cache it. No audit trail of administrator changes (audit tables excluded).
* `npm run demo` still creates professors and identities directly (development tool; bypasses previews).

## Phase 8 Report

Backend authentication (the login and recovery screens are Phase 14, #60), with the owner-approved password-recovery scope (#53): professors recover by emailed code, the administrator only through a command-line utility.

**Implemented** (`backend/`)

* `src/config/env.ts` — required `JWT_SECRET` (≥ 32 characters); optional `TRUST_PROXY`; generic SMTP settings (`SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASSWORD`, `MAIL_FROM`): all unset → recovery disabled, partly set → startup error. Error messages name settings, never values.
* `src/services/auth/`
  * `password.ts` — the single policy and hashing implementation (bcryptjs, cost 12; 4 only when `NODE_ENV=test` and the configured database is a `*_test` database, #65): ≥ 10 characters, ≤ 72 UTF-8 bytes, not the current password; never trimmed; >72-byte input never verifies; a dummy comparison for unknown emails.
  * `tokens.ts` — HS256 JWTs (issuer, audience, algorithm pinned): 8-hour session token carrying an HMAC fingerprint of the password hash (#57); reset token bound to one recovery code, separate audience; purpose-specific keys derived from `JWT_SECRET` with HKDF.
  * `accounts.ts` — email normalization, generic authentication, per-request session loading from the database (current role, professor link, active state, fingerprint), compare-and-set password change (#58).
  * `passwordRecovery.ts` — 6-digit code (`crypto.randomInt`), 10-minute expiry, stored as keyed HMAC; issue with one conditional `UPDATE` (60 s cooldown, ≤ 5 sends per hour, replaces the previous code); verification reserves one of 5 attempts atomically before comparing (constant time); reset consumes the bound code with a conditional `UPDATE` (only one succeeds), applies the policy, clears the code state (send limits kept), ends all sessions, does not sign in. Only PROFESSOR accounts with an active linked professor are eligible (#53).
  * `adminAccount.ts` — create (serializable, single admin, idempotent for the same email) and reset (exactly one admin, policy, compare-and-set) (#56).
* `src/services/email/mailer.ts` — `Mailer` interface; Nodemailer SMTP transport built only from configuration (no provider preset, STARTTLS required when not `secure`); delivery failures described by error codes only (#55).
* `src/middleware/auth.ts` — session cookie (`cse_session`: HttpOnly, SameSite=Lax, Secure in production, Path `/`, 8 h), `requireAuth`, `requireRole`, `requirePasswordChanged` (temporary passwords may only use `/api/auth/me`, change-password and logout).
* `src/middleware/rateLimit.ts` — dependency-free in-memory per-IP fixed-window limiter on login, change-password and the three recovery endpoints (#59).
* `src/routes/auth.ts` — `POST /login`, `POST /logout`, `GET /me`, `POST /change-password`, `POST /password-recovery/{request,verify,reset}`; the reset cookie (`cse_password_reset`) is limited to `/api/auth/password-recovery`. `src/routes/protected.ts` — guarded `/api/me` (session) and `/api/admin` (session + ADMIN) groups, no feature endpoints yet. `src/utils/validation.ts` — Zod body validation without echoing values (form posts fail).
* `scripts/admin-account.ts` (+ `scripts/lib/secretInput.ts`) — `npm run admin -- create --email …` / `reset-password`: hidden prompt (raw mode, entered twice) or `--password-stdin` with `--confirm`; email confirmation; passwords as arguments refused and unexpected arguments never echoed; configuration and database errors reported without secrets; exit codes 0/1/2.
* `prisma/migrations/…_add_user_password_recovery` — additive: five `password_reset_*` columns on `users` (#54); still 9 tables.
* Dependencies: `bcryptjs` 3, `jsonwebtoken` 9, `cookie-parser` 1.4, `nodemailer` 10; types `@types/jsonwebtoken`, `@types/cookie-parser`, `@types/nodemailer`. `npm audit` unchanged (the same 5 pre-existing findings).
* Docs: `Project_plan.md` §3.2, §4, §6.1, §15.2, §15.3, new §15.4, §19 (approved amendment); README (authentication, admin CLI, Gmail and institute SMTP); `.env.example`; `vitest.config.mts` (test-only `JWT_SECRET`, SMTP blanked so a developer's real SMTP settings are never used by tests).

**Tests** — 87 new (480 total, all passing; 70 with the implementation, 17 with the audit remediation below)

* `tests/auth/units.test.ts` (11): policy by characters and UTF-8 bytes (é, emoji); bcrypt format; no trimming; >72-byte input never verifies; session round-trip, 8-hour expiry, fingerprint; `none`, wrong secret, HS512, tampered, malformed tokens rejected; session and reset tokens not interchangeable; code format and keyed HMAC; limiter windows and independent keys.
* `tests/auth/authRoutes.test.ts` (17, real test DB): cookie attributes (Secure only in production); public fields only; email normalization, password never normalized; identical answers for unknown email and wrong password; inactive linked professor refused, unlinked allowed; validation without echo, form posts refused; `/me` 401 without a session and for garbage/expired/foreign-key/`none`/reset tokens (cookie cleared); deleted user and deactivated professor lose sessions; logout clears with matching attributes; `/api/me` and `/api/admin` protection; ADMIN role from the database (role change applies to an existing session); temporary password limited to me/change-password; change-password: wrong current, policy, 72-byte limit, reuse, other sessions ended, new cookie; CORS.
* `tests/auth/recovery.test.ts` (18, real test DB, in-memory mailer): eligible professor emailed, only the HMAC stored; unknown/admin/inactive/unlinked answers identical, nothing sent; cooldown and 5-per-hour limit, restart after an idle hour; 10 concurrent requests → one code, one email; reset cookie scope and no token in bodies; identical wrong-code answers; 10-minute expiry; 12 concurrent correct verifications → exactly 5 succeed; lock after 5 wrong; reset clears state, keeps send limits, ends old sessions, no sign-in, single use; policy on reset without consuming the code; 6 concurrent resets → exactly 1 succeeds; a new code invalidates earlier reset cookies; missing/garbage/session cookies and a deactivated account refused; reset capability expires with the code; missing SMTP → 503 for all steps; SMTP failure logged by error code only; no code, token, password or hash in any response or log line.
* `tests/auth/mailer.test.ts` (4): generic transport options (no `service`; Gmail and institute examples differ only in configuration); creating the mailer does not connect; composition through Nodemailer's stream transport (From, To, Subject, plain text, code once); failure descriptions keep codes only.
* `tests/auth/rateLimitRoutes.test.ts` (3): one IP limited with `Retry-After`, other IPs unaffected, window restart; limited answers identical for existing and unknown accounts; verification limited per IP.
* `tests/auth/adminCli.test.ts` (12; real subprocesses on the test DB): create from piped password, idempotent; second admin and email of another account refused; reset ends existing admin sessions; no admin / two admins refused; wrong confirmation (exit 2), policy and reuse refused, nothing changed; passwords as arguments refused and never echoed; no terminal without `--password-stdin`; `--confirm` required; invalid `JWT_SECRET` and unreachable database reported without secrets; hidden input (no echo, backspace, raw mode restored, Ctrl-C), piped input (one trailing line break removed only), argument parsing.
* `tests/env.test.ts` (+5): `JWT_SECRET` required/length without echo; SMTP disabled, generic parsing, unauthenticated relay, incomplete/malformed settings; `TRUST_PROXY`.
* Also checked by hand: the hidden prompt through a real pseudo-terminal (`script`) on the test database — confirmation visible, password never echoed, admin created.

**Security audit remediation** (read-only audit of the implementation, then targeted fixes)

* F1 (medium, fixed): `verifyPassword` returned at once for passwords over 72 bytes, so an existing account answered in ~0.05 ms and an unknown one in ~370 ms. It now always runs the single bcrypt comparison and then rejects over-long input. Tests: exactly one `bcrypt.compare` call for the over-long path (unit) and for both an existing and an unknown email (login route).
* F2 (medium, fixed, #61): each new code reset `password_reset_attempts`, allowing 5 attempts per code (up to 25 guesses per hour). The issuing `UPDATE` now restores the attempt budget only when the recovery window has ended (no send for an hour), with the same condition as the send counter; still one atomic statement, no new column. Follow-up (#64): while the window's budget is used up, the same statement issues nothing — no code generated or sent, no send slot used, last-send time unchanged — so unusable codes are never sent and repeated requests cannot extend the lockout; the public answer is unchanged. Tests (each of the first three fails without the follow-up): an exhausted budget suppresses issuance with an unchanged answer and unchanged state; requests up to 59 min later do not move the window, and exactly an hour after the last real send a usable code is issued with a fresh budget; 10 concurrent requests against an exhausted budget send nothing, and 10 after the window send exactly one; a replacement code issued with attempts left carries over only the remaining attempts, also under parallel verification.
* F3 (low, fixed, #63): change-password and the admin command-line reset did not clear a pending recovery code, so an earlier reset cookie stayed usable for up to 10 minutes. Every password change now clears the code, its expiry and attempts (`CLEARED_RECOVERY_CODE`), keeping send limits. Tests: a professor's reset cookie is refused after a normal password change; the admin reset clears recovery state on the admin row.
* F7 (informational, fixed, #63): reset tokens were bound to the code hash only, so the same six digits issued again would revive an older token. They are now bound to the issuance (hash + send time) and the consuming `UPDATE` also matches the send time. Test: the same code issued twice (code generator fixed in that test file only); the first token is refused, the second works — this test fails without the fix. A mailer that throws synchronously can no longer change the recovery answer (`Promise.resolve().then`); tested.
* F4 (low, fixed, #62): `src/middleware/origin.ts` refuses state-changing `/api` requests whose `Origin` is present and not `CORS_ORIGIN` (also logout), before body parsing; requests without `Origin` are unaffected. Tests: `https://evil.example`, `null` and another localhost port are refused on all six mutation routes with no effect (no cookies issued or cleared, password, code and attempts unchanged, no email); the frontend origin and Origin-less clients work; `text/plain`, form-urlencoded and multipart bodies are refused (400) on every route with a body, even from the allowed origin.
* F5, F6: assessed and documented (see known limitations); no code change.
* Bcrypt cost guard (#65): the reduced test cost (4) previously depended on `NODE_ENV=test` alone; a mistaken `NODE_ENV=test` against a real database would have stored weak hashes. `passwordHashCost` now also requires the database name — parsed as the URL path of `DATABASE_URL`, the URL Prisma connects with — to end in `_test`; anything unparsable or unverifiable gets cost 12. Tests: `*_test` database → 4; `NODE_ENV=test` with the development database, `_test` only in a parameter, user, password or host, a `_test_backup` name, no name, a non-PostgreSQL URL or garbage → 12; development and production → 12 for any database; the running suite hashes with cost 4. Checked by hand in a separate process (no database connection): `NODE_ENV=test` with `cse_research_hub` hashes at cost 12, with `cse_research_hub_test` at 4.

**Validation**

* Backend: `lint` ✅, `typecheck` ✅, `build` ✅, `test` 480/480 ✅ (Phases 1–7 and configuration suites: 398 tests, unchanged and passing), `prisma validate` ✅, test database `migrate status` up to date ✅, `migrate diff` (test database vs schema) no difference ✅. Frontend: `lint` ✅. No live API, real SMTP or development data used by tests.

**Known limitations / open items**

* Owner setup: `JWT_SECRET` must be added to `backend/.env` (the backend, scripts and seed refuse to start without it); `npx prisma migrate deploy` must be run on the development database (the new migration is not applied there yet); SMTP settings are needed for recovery; the admin account must be created with `npm run admin -- create`.
* Rate limits are per process (not shared between instances; reset on restart). Behind a reverse proxy `TRUST_PROXY` must be set, or all clients share one limit. Distributed limiting is future hardening (Phase 15) if several instances are ever used.
* Stateless sessions: logout clears the cookie, but a copied token stays valid until it expires (8 h) or the password changes.
* Timing: identical response bodies do not make requests indistinguishable by timing. Recovery `request` and `verify` do more database work for eligible accounts (an update, and for verify a read) than for unknown or ineligible ones, so a small timing difference remains; email is sent after responding. Not equalized (it would add artificial work for little benefit at this scale); login, by contrast, always performs one bcrypt comparison (F1).
* Anyone who knows a professor's email address can use up the window's 5 attempts with wrong codes and so block that professor's email recovery until an hour after the last code was sent (the per-IP limit slows but does not prevent this). This is the intended trade-off of a per-account guess limit.
* The in-memory rate limiter drops expired windows periodically but does not cap the number of active entries: a flood from very many source addresses grows memory until those windows expire. Evicting live entries early would let such a flood reset other clients' limits, so no cap was added; a shared store would be the deployment-grade answer if needed (Phase 15).
* `SameSite=Lax` requires the frontend and API on the same site in deployment; HTTPS (for `Secure`), sender-domain authentication (SPF/DKIM) for deliverability and the provider's daily sending limits (e.g. Gmail) are Phase 15 items.
* The admin utility runs with `tsx` (a development dependency); deployment must keep it available on the backend host (Phase 15).
* The frontend has no login or recovery screens yet (Phase 14).

## Phase 7 Report

Two stages: a read-only audit of the Phase 3–6 pipeline against `Project_plan.md` (every §7–§14 and §18 requirement mapped to implementation and tests; read-only checks on the development database), then remediation of the approved findings only.

**Audit result**

* PASS: normalization, rules 1–4 and vetoes, DOI contradictions and precedence (#22–#28), canonical priority (#26), SUPPRESSED absorption (#30), PENDING-only links and status preservation, response validation and identity checks for all three sources, fetch-then-write, idempotent per-source reruns, schema constraints. Development data: no publication without provenance, no ACTIVE publication without a link, every DOI shared by two publications has a candidate.
* BUG B1 (fixed): when a DOI match was blocked (or the DOIs pointed to several publications), `decide()` returned before rule 3, so publications with the identical normalized title got neither a merge nor a candidate (§8.1 rule 4, §8.3 #24, §12.3). Development data: 5 of 19 DOI-blocked records had such an uncandidated publication, e.g. OpenAlex `W3112766335` (typed preprint, ACM conference DOI) vs DBLP CoRR `journals/corr/abs-2008-05102`.
* Coverage gaps (closed): no three-source end-to-end test (C1); no test of a database failure part-way through a run (C2); concurrent unique-key retry untested (C3); preprint vs OTHER on a DOI match untested (C4).

**Implemented** (`backend/src`)

* `services/matching/engine.ts` — B1 fix (#48): when the DOI path ends without a match, every other publication with the exact normalized title becomes a `DuplicateCandidate` (reason: the rule-3 vetoes, or "Exact title match not merged: DOI match blocked"). The record still gets its own publication; no merge behaviour, rule or criterion changed.
* `integrations/openalex/client.ts` — completeness counts distinct work IDs (#51), so a work repeated across pages cannot hide a missing one; such a fetch is `INCOMPLETE` and writes nothing.
* U+0000 handling (#52; found while testing C2: PostgreSQL rejects U+0000 in text and JSON, so one such record failed on every run and stopped the identity's discovery):
  * `services/normalization/nul.ts` (new) — `replaceNul`: U+0000 → U+FFFD.
  * `normalizedPublication.ts` — title, venue and author names replaced (normalized titles unchanged); an external ID containing U+0000 is rejected (`NormalizationError`, record skipped with a warning; never altered); error messages replaced.
  * `rawMetadata.ts` — string values and keys at any depth replaced; on a key collision, keys without U+0000 keep their names and the replaced key gets the first free `#2`, `#3`, … suffix (no value overwritten; deterministic).
  * `doi.ts` — a DOI containing U+0000 is invalid (treated as absent; the raw value stays in raw metadata).
  * `ingestDiscoveredRecords.ts` (skip warning) and `integrations/http/httpClient.ts` (`FetchError` messages) — quoted source values replaced, so they are safe to persist in Phase 12.
  * Input without U+0000 is processed exactly as before: no stored data, rule or matching behaviour changes.

**Tests** — 23 new (393 total, all passing)

* `tests/matching/engine.test.ts` (+3): B1 regression for a blocked DOI match (modelled on the real W3112766335 case; written first and failing before the fix) and for DOIs matching several publications; preprint vs OTHER on a shared DOI stays split with a candidate (#49).
* `tests/integrations/openalex.client.test.ts` (+1), `tests/services/openAlexDiscovery.test.ts` (+1): a repeated work in place of a missing one → `INCOMPLETE`, nothing written.
* `tests/services/pipeline.test.ts` (4, new, real test DB):
  * C1: one professor with OpenAlex, DBLP and ORCID identities through all three discovery services (recorded Vardi data; the OpenAlex work bodies are recorded, only the author/page envelope is synthetic); cross-source merges OpenAlex↔DBLP and DBLP↔ORCID; one PENDING link per publication recorded against the first discovering identity; after one REJECTED and one APPROVED decision, reruns in the same and in reverse order leave publications, source records, links, candidates and statuses identical and refresh `last_seen_at` only.
  * C2 (real rollback, no mocks): a temporary trigger, created only in the `*_test` database and always dropped (also when an assertion fails — tested), makes PostgreSQL reject the second of three records — the first record and its link stay committed, the failing record's already-inserted Publication is rolled back, the error reaches the caller, and a rerun completes without duplicating the first record.
  * C2 (stubbed link insert): the relationship insert after a committed record fails → the record stays, unlinked; the rerun creates the missing link.
  * C3: a concurrent ingest of the same record commits during the first attempt → the attempt's Publication insert is rolled back by the database, the retry updates the committed record (one publication, one source record).
  * U+0000 (#52): a batch whose middle record has U+0000 in its title, DOI, venue and nested raw values/keys (incl. a key collision) is stored completely, later records are processed, and a rerun changes nothing; title matching is identical to the clean title; a record with U+0000 in its external ID is skipped with a sanitized warning on every run while the others are processed; a recorded ORCID response with U+0000 injected goes through `discoverOrcidIdentity` with the same outcome as the clean response and reruns cleanly.
* U+0000 unit tests (#52): `doi.test` (+2), `normalizedPublication.test` (+5: text fields, external ID rejection and message, nested raw values/keys, key collisions without overwriting, payloads without U+0000 unchanged incl. key order), `httpClient.test` (+1), `orcid.client.test` (+1: a source path with U+0000 quoted safely). The 11 U+0000 tests that exercise the fix fail without it.

**Validation**

* Backend: `lint` ✅, `typecheck` ✅, `build` ✅, `test` 393/393 ✅. Frontend: `lint` ✅. No live API calls in tests; development data only read; no test trigger left in the test database.

**Dependencies / schema:** none added or changed. `Project_plan.md`: U+0000 rule added to §7, §7.1 step 6 and the §6.5 `raw_metadata` description (#52, approved); nothing else changed.

**Known limitations / open items**

* B1 is not applied retroactively: development data ingested before the fix keeps its 5 missing candidates until it is re-ingested or reset.
* LaTeX in OpenAlex titles (e.g. `B\"uchi`, `$$ \mathcal{K} $$`; 7 development records) is not handled by §7.2 normalization; affected DOI matches are blocked as "unrelated titles" and become candidates (safe). Deferred (#50).
* ~~U+0000 in a source string blocks discovery~~ — resolved (#52). Only U+0000 is handled; other control characters are stored as before (PostgreSQL accepts them).
* Identity external IDs entered by the admin are validated in Phase 9, not by this rule.
* Matching results remain order-dependent where the plan allows it (e.g. which identity a link is attributed to, which record becomes canonical); reruns are idempotent in any order (C1).

## Tooling: Backend ESLint (between Phases 6 and 7; not part of Phase 7)

**Implemented**

* `backend/eslint.config.mjs`: mirrors the TypeScript rules the frontend gets from `eslint-config-next/typescript` (typescript-eslint `recommended`; `no-unused-vars` and `no-unused-expressions` as warnings), without React/Next rules. The frontend config is unchanged.
* Backend-only, type-aware `@typescript-eslint/no-floating-promises` (error), using the existing `tsconfig.json` (src, tests, prisma, scripts).
* `eslint` and `typescript-eslint` added as backend dev dependencies; backend `npm run lint`; README lists it.
* Lint fixes, behaviour preserved: `index.ts` handles a `startServer()` rejection explicitly (log, exit 1); the `server.close()` callback is no longer async, so a failed database disconnect is logged and exits 1 instead of an unhandled rejection; `errorHandler.ts` keeps the unused `next` (Express identifies error handlers by arity) with a one-line disable.

**Validation**

* Backend: `lint` ✅, `typecheck` ✅, `build` ✅, `test` 370/370 ✅. Frontend: `lint` ✅.

**Known limitations / open items**

* `no-misused-promises` is not enabled; the shutdown fix is not lint-enforced and was not exercised by a live signal.
* Shutdown can still stall if `disconnectDatabase()` never settles or `server.close()` waits on keep-alive connections (pre-existing; a timeout would be a behaviour change).
* `npm audit` (backend) reports 3 advisories, not addressed: `proxy-addr` 2.0.7 via Express (critical, GHSA-jqcg-44mw-7w3h; only relevant with a subnet `trust proxy` setting, which is not used; fixed in 2.0.8); `source-map-js` 1.2.1 via Vitest (high, GHSA-68fv-2mgg-jv7q; dev only; fixed in 1.2.2); `deepmerge-ts` via the Prisma 6 CLI (high, GHSA-ggr8-5vv4-36mx; already accepted in Phase 1; no Prisma 6 fix). Awaiting the architect's decision.

## Phase 6 Report

**Implemented** (`backend/src`)

* `integrations/orcid/`
  * `client.ts` — ORCID Public API v3.0, anonymous, one request per identity (`/v3.0/{orcid}/works`, `Accept: application/json`). Identity validated before any work is processed (#42): ISO 7064 MOD 11-2 checksum (no request for an invalid iD), 404 → `IDENTITY_NOT_FOUND`, 409 (deactivated/locked) → `IDENTITY_INVALID` with ORCID's error code, deprecated 301 → `IDENTITY_INVALID` naming the primary iD without following the redirect (#43); response `path` and every summary `path` must name the requested iD; ORCID error payloads with 200 → invalid; put-codes listed twice kept once (reported). 200 ms interval, 60 s timeout, retries on 429/5xx (ORCID's burst limit answers 503).
  * `types.ts` — Zod schema for the works response and work summaries.
  * `mapper.ts` — work summary → `PublicationInput`: `external_id = {orcid}:{put-code}`, title only (#44), DOIs with relationship `self` only (part-of/version-of ignored), year from `publication-date` or unknown, venue from `journal-title`, no author names, the summary as raw metadata.
  * `typeFamily.ts` — mapping unchanged (plan §7.3); confirmed against real records (comment only).
* `services/discovery/orcidDiscovery.ts` — `discoverOrcidIdentity(identityId)`: shared preconditions → complete fetch + validation → map → shared write step (unchanged).
* `integrations/http/httpClient.ts` — additive (#46): `followRedirects: false` option, `location` on responses, parsed JSON body for pass-through statuses, ORCID `developer-message` in error messages. OpenAlex/DBLP behaviour unchanged.
* Scripts: `npm run fixtures:orcid`, `npm run smoke:orcid -- <iD>` (live, read-only).

**ORCID behaviour verified live (2026-09-28, read-only)**

* No paging: 1,351 summaries for a large record in one 2.8 MB response, equal to `/record`'s counts.
* Nonexistent iD → 404 JSON (error 9016); deactivated record → 409 JSON (error 9044) on `/works`, `/person` and `/record`; deprecated → documented 301 (no real example found).
* In 1,474 summaries from 4 records: types journal-article, preprint, other, data-set, conference-paper, book-chapter, report, book; relationships doi/self, wosuid/self, eid/self, issn/part-of, doi/part-of (book chapters pointing at a parent DOI), pmid/self; 304 groups with several summaries (all but 4 share a DOI); 2 without a year; 6 with a null title; 7 with a subtitle (6 on ORCID's test record, where it holds a journal name); no arXiv DOIs.

**Recorded fixtures** (`tests/fixtures/orcid`, compact JSON, ~170 KB): Piwowar (100 summaries, 73 groups, duplicates, data-sets, part-of ISSNs), Vardi (8 self-entered works: 3 without title, 1 without year; also in the DBLP/OpenAlex fixtures), Josiah Carberry (ORCID's test record: subtitles, duplicates), a real 404 and a real deactivated 409.

**Tests** — 50 new (370 total, all passing)

* `tests/integrations/orcid.client.test.ts` (19): checksum (incl. X), iD normalization, no request for an invalid iD; full recorded list from one JSON request; redirects not followed; duplicate put-code kept once; genuine empty result; real 404 → not found; real 409 (9044) → invalid; deprecated 301 (simulated) → invalid, not followed; HTML, XML, malformed JSON, ORCID error payload, missing groups, empty group, response for another record, summary of another record; 503/429 retries.
* `tests/integrations/orcid.mapper.test.ts` (10): external ID format; self DOIs only; part-of/version-of ignored but kept raw; missing year; null titles rejected; title only / subtitle raw; venue; no author names; recorded types → families; every recorded summary normalizes.
* `tests/services/orcidDiscovery.test.ts` (13, real test DB): 100 summaries → 100 source records, PENDING links once per publication; in-ORCID duplicates merge into one publication; titleless skipped with warnings and a no-year record kept; genuine empty result writes nothing; idempotent rerun, `last_seen_at` refreshed, REJECTED kept; nothing written for the real 404, the real 409, a deprecated 301, HTML with 200, malformed JSON, or a later failed fetch; wrong-source/inactive refused without API calls; **cross-source with recorded DBLP data (Vardi)**: ORCID "Module Checking" (2001, no DOI) merges by title + year + type with the 2001 journal version, not the 1996 conference version; "Endmarkers can make a difference" merges with DBLP; the no-year "On decomposition of relational databases" becomes a candidate with the FOCS 1982 paper; one relationship per publication.
* `tests/integrations/httpClient.test.ts` (+3): pass-through JSON body, unfollowed redirect with Location, redirects followed by default.
* `tests/normalization/typeFamily.test.ts` (+5): further ORCID types → OTHER.

**Validation**

* `typecheck` ✅, `test` 370/370 ✅, `build` ✅, `prisma migrate status` up to date, `migrate diff` clean, 9 models / 9 tables; no schema changes; Phase 3 matching/normalization and Phase 4/5 integration code unchanged; Phase 3/4/5 suites 294/294 ✅.
* Live smoke (read-only): Ioannidis 1,351/1,351 normalized in 1.2 s; Vardi 5 normalized, 3 skipped (no title), 1 without year; deactivated, nonexistent and bad-checksum iDs rejected.

**Dependencies:** none added or changed.

**Known limitations**

* The deprecated-iD path is verified only with a simulated 301 (no real deprecated iD could be found); either way it fails safely.
* ORCID summaries carry no author names, so ORCID-only publications have no author list.
* ORCID preprints are recognised by `type = preprint` only (plan §7.4); unlike OpenAlex/DBLP, an ORCID record with an arXiv DOI but another type is not treated as a preprint. No such record appeared in the sampled data; if one occurs, a DOI match with a preprint record is blocked as preprint-vs-published and becomes a candidate (safe).
* A genuine subtitle used only on ORCID can prevent an exact-title match for records without DOIs (1 of 1,474 sampled summaries).
* Same write semantics as the other sources; discovery not yet triggered by routes or sync (Phases 9/12).

## Phase 5 Report

**Implemented** (`backend/src`)

* `integrations/dblp/`
  * `client.ts` — sparql.dblp.org only (§13.4). Per identity, three throttled (1.5 s, one at a time), validated SPARQL requests: identity (`dblp:Person` required; missing → `IDENTITY_NOT_FOUND`; disambiguation page / non-person → `IDENTITY_INVALID`, #37), authored records (`dblp:authoredBy` only — editor-only `editedBy` records are never selected), and author signatures (#38). PID normalization with injection-safe validation; `Accept: application/sparql-results+json`; project `User-Agent` (no contact details); 120 s timeout; completeness: `meta.result-size-total` required and must equal the rows delivered, author signatures must refer only to fetched records and every record must have one (#38, #41); DOIs sorted/de-duplicated because dblp's concatenation order is not stable.
  * `types.ts` — Zod schema for SPARQL 1.1 JSON results.
  * `mapper.ts` — dblp record → `PublicationInput`: record key as `external_id`, title, year, all DOIs, venue, ordered author names, record type from the dblp class (bibtexType fallback, #36), raw metadata.
  * `typeFamily.ts` — preprint rule replaced (#40): `Informal` + `journals/corr/`, or an arXiv DOI → PREPRINT; `Informal` elsewhere → OTHER; `journals/corr/` alone no longer counts. Takes the record's DOIs as input.
* `services/discovery/`
  * `dblpDiscovery.ts` — `discoverDblpIdentity(identityId)`: preconditions → complete fetch + validation → map → shared write step (`ingestDiscoveredRecords`, unchanged).
  * `discoveryIdentity.ts` — shared precondition check (identity exists, right source, active, professor active) now used by OpenAlex and DBLP discovery; OpenAlex behaviour unchanged.
* `integrations/http/httpClient.ts` — additive: `IDENTITY_INVALID` error kind; error messages also read an `exception` field (dblp's error format).
* Scripts: `npm run fixtures:dblp`, `npm run smoke:dblp -- <PID>` (live, read-only).

**Recorded fixtures** (`tests/fixtures/dblp`, live on 2026-09-28, compact JSON, ~1.0 MB): identity of a person (`v/MosheYVardi`), a disambiguation page (`00/10049`), a missing PID; Vardi's 830 authored records and 2,396 author signatures; the real bot-protection page `dblp.org/pid/…xml` serves with HTTP 200; a real SPARQL 400 error.

**Tests** — 61 new (320 total, all passing); `tests/normalization/typeFamily.test.ts` DBLP block rewritten for #40 (3 → 6 tests)

* `tests/integrations/dblp.client.test.ts` (30): missing `meta` → invalid; more rows than reported → invalid; truncated author signatures → INCOMPLETE; author rows for an unknown record → invalid; record without author rows → INCOMPLETE; PID normalization and injection rejection; queries use `authoredBy` only, `AuthorSignature` only, the SPARQL endpoint only; throttle interval; person accepted; disambiguation → `IDENTITY_INVALID` with no records query; missing → `IDENTITY_NOT_FOUND`; non-person; all 830 records with ordered authors from exactly 3 requests; no Editorship records; multi-DOI sorting; author ordering independent of row order; 1.5 s spacing; real bot-protection HTML with 200; real SPARQL 400 without retry; authors query failing after records; 429/5xx retries; INCOMPLETE; invalid structure; missing variable; row without record URI; bad author ordinal.
* `tests/integrations/dblp.mapper.test.ts` (13): record type from class not bibtexType; CoRR `Informal` → PREPRINT; the 11 published EPTCS/LMCS papers under `journals/corr/` → CONFERENCE/JOURNAL; the 6 Dagstuhl `Informal` items → OTHER; exactly the 97 CoRR preprints are PREPRINT; journal/chapter/book/data; multi-DOI; uppercase DOIs; trailing period; raw metadata; all 830 records map and normalize (CONFERENCE 437, JOURNAL 277, PREPRINT 97, BOOK_CHAPTER 8, BOOK 3, OTHER 8).
* `tests/services/dblpDiscovery.test.ts` (15, real test DB): LMCS paper under `journals/corr/` merges by DOI with another source's journal record (no preprint split; only the genuine conference-version candidate remains); Dagstuhl → OTHER, 97 PREPRINT in the database; 830 records with PENDING links via identity and `last_seen_at`; editor-only records never ingested; CoRR preprint kept apart from its published version (candidate); idempotent rerun; REJECTED preserved; nothing written for the real bot-protection page, the real SPARQL error, a failing authors query, a later failed sync, a disambiguation PID, a missing PID; non-DBLP/inactive identities refused without API calls; **cross-source with recorded OpenAlex data for the same professor**: 7 real papers merge into one canonical publication each (5 by DOI incl. DBLP uppercase DOIs and an OpenAlex repository-hosted work, 1 by exact title + year without DOI, 1 preprint pair), OpenAlex metadata outranks DBLP, one relationship per publication.

**Validation**

* `typecheck` ✅, `test` 320/320 ✅, `build` ✅, `prisma migrate status` up to date, `migrate diff` clean, 9 models; no schema changes; Phase 3 code untouched ✅.
* Live smoke (read-only): `v/MosheYVardi` — 830 records fetched and normalized in 3.6 s (699 with DOI, all with authors); `https://dblp.org/pid/00/10049.html` rejected as `IDENTITY_INVALID`.

**Dependencies:** none added or changed.

**Known limitations**

* sparql.dblp.org rate limits are undocumented; the client spaces requests 1.5 s apart and retries 429/5xx. If dblp puts bot protection in front of SPARQL too, DBLP fetches fail as `CONTENT_TYPE` (no writes); other sources are unaffected.
* dblp PID merges/retirements are not handled specially: a PID that no longer exists fails safely as `IDENTITY_NOT_FOUND`.
* ~~`Informal` records include Dagstuhl seminar items classified PREPRINT~~ — resolved by #40 (now OTHER).
* `Withdrawn` dblp records are ingested as OTHER (no special handling, by decision).
* Author signatures and records come from two separate queries; if dblp data changes between them, the cross-check fails the fetch (retried on the next run).
* Same write semantics as OpenAlex: nothing written on fetch/validation failure; records written one transaction at a time; discovery not yet triggered by routes or sync (Phases 9/12).

## Phase 4 Report

**Implemented** (`backend/src`)

* `integrations/http/httpClient.ts` — shared HTTP helper (§13.2): native fetch, 30 s timeout, retries with exponential backoff + jitter on 429/5xx/network/timeout honouring `Retry-After` (capped), no retry on other 4xx, per-source throttling (one request at a time, minimum interval), and §13.1 validation: HTML or non-JSON content, malformed bodies → `FetchError`.
* `integrations/openalex/`
  * `client.ts` — author validation via `/authors/{id}` (404 → `IDENTITY_NOT_FOUND`; a documented 301 redirect for a merged ID is detected via the returned `id` and resolved, #33 — live, OpenAlex's documented merged example currently answers 404 and fails safely); works via `filter=author.id`, cursor pagination, `per-page=100`, `select=` of 9 root fields (no abstracts/references/full text); Zod validation of every page and work; API error payloads with 200 → failure; fewer works than `meta.count` → `INCOMPLETE` (#34); page-count safety bound. Config: 200 ms minimum interval, 3 retries.
  * `types.ts` — Zod schemas for author, works page and work.
  * `mapper.ts` — OpenAlex work → `PublicationInput` (W-id, DOIs incl. `ids.doi`, year, venue, author names, type family via `typeFamily.ts`, payload as raw metadata).
  * `typeFamily.ts` — repository rule settled: not adopted (#31).
* `services/discovery/`
  * `ingestDiscoveredRecords.ts` — source-independent write step: normalize (skip + warn on unusable records) → Phase 3 `ingestPublication` (with `seenAt`) → create-only PENDING `ProfessorPublication` (origin DISCOVERED, `discovered_via_identity_id`); existing relationships never changed; no link for SUPPRESSED publications.
  * `openAlexDiscovery.ts` — `discoverOpenAlexIdentity(identityId)`: preconditions (identity exists, is OPENALEX, active, professor active) → complete fetch + validation → map → write. Returns counts matching the future `SyncTask` fields plus warnings.
* Config: optional `OPENALEX_API_KEY` (#32; startup warning when absent outside tests).
* Scripts: `npm run fixtures:openalex` (records fixtures), `npm run smoke:openalex -- <A-id>` (live, read-only check).

**Fixtures** (`tests/fixtures/openalex`, recorded from the live API on 2026-09-28): author; 3 cursor pages (Jason Priem, 67 works at 25/page); 9 edge-case works (Vardi: conference typed article, AAAI DOI shared by two works, arXiv preprint with literal `\n`, repository-hosted LIPIcs paper, empty title, no source, journal article); 404 HTML author; the real 404 of OpenAlex's documented merged-author example `A5092938886`; empty-200 works for a nonexistent author; 400 error payload.

**Tests** — 71 new (259 total, all passing)

* `tests/integrations/httpClient.test.ts` (20): HTML-with-200, HTML labelled JSON, wrong content type, malformed JSON, 429 + Retry-After (seconds, date, cap), 5xx backoff sequence, jitter, network errors, retry exhaustion, no retry on 400, 404 pass-through, timeouts, throttling interval, one-at-a-time, recovery after failure.
* `tests/integrations/openalex.client.test.ts` (22): ID normalization; author validation (recorded); recorded 404 → not found; nonexistent author never reaches the empty-200 works query; recorded 404 of the documented merged example → `IDENTITY_NOT_FOUND` before any works query; merged ID via a **simulated** redirect; invalid author shape; HTML on author check; API key header (and never in URLs); full recorded cursor chain (67 works, 3 calls, filter/select checked); default per-page 100; excluded fields never selected; genuine empty result; 429 mid-pagination; HTML mid-pagination; error payload with 200; recorded 400; missing meta; invalid work; INCOMPLETE; page bound.
* `tests/integrations/openalex.mapper.test.ts` (11): every recorded work (76) maps and normalizes; edge cases above; repository hosting ≠ preprint.
* `tests/services/openAlexDiscovery.test.ts` (16, real test DB): recorded 404 of the documented merged example writes nothing and leaves the identity unchanged; full discovery with PENDING links via identity and `last_seen_at`; never auto-APPROVED; idempotent rerun refreshing `last_seen_at`; REJECTED/APPROVED preserved; SUPPRESSED never re-linked; HTML page mid-fetch writes nothing; later failed sync leaves data and `last_seen_at` untouched; nonexistent identity writes nothing; preconditions (inactive identity/professor, wrong source, unknown id) make no API call; merged ID warning without changing the identity (**simulated** redirect); split profile (two identities, one professor) links once; co-author links without duplicate publications; manual publication absorbs the OpenAlex record and keeps its APPROVED manual link.
* `tests/integrations/noNetwork.test.ts` (1) + `tests/setup/noNetwork.ts`: live network access is blocked in all tests.

**Validation**

* `typecheck` ✅, `test` 259/259 ✅, `build` ✅, `db:seed` ✅, `prisma migrate status` up to date, `migrate diff` clean; no schema changes in Phase 4 ✅.
* Live smoke (keyless, read-only): Moshe Y. Vardi — 914 works reported and fetched over 10 pages in 15 s; 913 normalized, 1 skipped (empty title); CONFERENCE 393, JOURNAL 267, OTHER 130, PREPRINT 95, BOOK_CHAPTER 21, BOOK 7.

**Dependencies:** none added or changed.

**Known limitations**

* Discovery is not yet triggered by any route, scheduler or `SyncRun`/`SyncTask` bookkeeping (Phases 9/12); its summary already carries the `SyncTask` counters.
* Each record's relationship is created right after that record's ingest transaction, not inside it; if the process stops in between, the link is created by the next (idempotent) run.
* A database error part-way through the write step leaves the records written so far (fetch failures write nothing; reruns complete the rest idempotently).
* If OpenAlex's result set shrinks while paging, the fetch fails as `INCOMPLETE` and is retried on the next run.
* A merged author ID is reported but not updated automatically (admin action). The redirect path is verified only with a simulated response: OpenAlex's documented merged example currently returns 404 (fails safely as `IDENTITY_NOT_FOUND`), so no real redirect could be recorded.
* A merged profile that OpenAlex keeps as an "inert" author with no works returns a genuine empty result: discovery succeeds with 0 records and changes nothing (candidate warning for Phase 12).

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
* ~~The OpenAlex repository preprint rule is deferred to Phase 4 (decision #25)~~ — settled in Phase 4 (#31).
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
| 4 | OpenAlex Integration | Identity validation, cursor pagination, response validation, mapping into the pipeline | **COMPLETE** (approved) |
| 5 | DBLP Integration | SPARQL client, mapping, response validation, throttling, failure handling | **COMPLETE** (approved) |
| 6 | ORCID Integration | v3.0 works retrieval, JSON handling, put-code source records, failure handling | **COMPLETE** (approved) |
| 7 | Core Pipeline Testing & Audit | Test the full multi-source pipeline against all required cases | **COMPLETE** (approved) |
| 8 | Authentication | Roles, JWT in HTTP-only cookie, hashing, temporary password, forced change, route protection, professor email-code recovery, admin CLI | **COMPLETE** (pending review) |
| 9 | Professor Management | Professors, profiles, external identities, activation/deactivation | **COMPLETE** (approved) |
| 10 | Verification Workflow | PENDING/APPROVED/REJECTED, reversible rejection, ownership | **COMPLETE** (approved) |
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

Kept explicitly deferred (see `Project_plan.md` §20): fuzzy matching; advisory locking; startup catch-up sync; exact monthly schedule; analytics treatment of `OTHER`; ORCID client registration; hard professor deletion; deployment provider.

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
| 8 | 2026-09-25 | Preprints kept separate; per-source detection (DBLP Informal/CoRR — DBLP rule superseded by #40, OpenAlex preprint/10.48550/repository — repository part deferred by #25, ORCID preprint) | Live evidence: DBLP CoRR records lack DOIs and share titles/years with published versions |
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
| 25 | 2026-09-27 | ~~OpenAlex "repository where applicable" preprint rule DEFERRED to Phase 4; Phase 3 applies only type=preprint and 10.48550/ DOIs~~ **Superseded by #31** | "Where applicable" is undefined in the plan and decision #8 recorded the rule unconditionally; architect chose to defer |
| 26 | 2026-09-27 | Canonical selection: OTHER does not outrank a known type family; within one source the oldest record wins | §7.3 defines OTHER as insufficient information; approved |
| 27 | 2026-09-27 | DOI ownership precedence: canonical DOI owner before source-record-only DOI carriers | Phase 3 implementation decision (not frozen); approved |
| 28 | 2026-09-27 | ~~Known limitation: secondary DOIs of stored records not searched~~ **Superseded:** all normalized DOIs are kept in `raw_metadata._normalizedDois` and searched during matching | Architect review: the limitation conflicted with §6.5; implemented without schema change |
| 29 | 2026-09-27 | Roadmap gap recorded: §8.5 duplicate-candidate resolution has no implementation phase in §19 | Verified in Phase 3; not implemented; awaiting assignment |
| 30 | 2026-09-27 | SUPPRESSED publications stay in matching and absorb matching source records (provenance only); no professor links are ever created for them automatically; ingest result reports `publicationStatus` | Architect review of §6.4/§14; excluding them would recreate the suppressed paper as a new publication |
| 31 | 2026-09-28 | OpenAlex repository hosting is not a preprint signal; preprints = type `preprint` or `10.48550/` DOI (§7.4 updated) | Architect decision in Phase 4 on live data: 140 repository-hosted works of one author — 94 already typed preprint, 46 published papers/reports/books |
| 32 | 2026-09-28 | `OPENALEX_API_KEY` optional; sent as Bearer token when set; keyless otherwise with a startup warning | Architect decision; keyless budget verified (1,000 credits/day) |
| 33 | 2026-09-28 | Merged OpenAlex author ID: works fetched with the resolved ID; identity not changed automatically; warning reported. Detection relies on OpenAlex's documented 301 redirect; a live check on 2026-09-28 of the documented example `A5092938886` returned 404, so that merged-away ID currently fails safely as `IDENTITY_NOT_FOUND` with no writes. Redirect path covered by a simulated response only | Phase 4 implementation decision implementing §13.3; verified read-only and documented after architect review |
| 34 | 2026-09-28 | Fewer works than `meta.count` after cursor paging → fetch failure (`INCOMPLETE`) | Phase 4 implementation decision implementing §13.1/§14 (incomplete responses are failures) |
| 35 | 2026-09-28 | §14 `last_seen_at` wording clarified to match the implementation: set once the task's complete fetch is validated and that record is processed (per-record transactions) | Documentation clarification after Phase 4 review; no behaviour change |
| 36 | 2026-09-28 | DBLP record type = the record's dblp class (`rdf:type`); `bibtexType` only as fallback | Phase 5 implementation decision within §7.3; recorded evidence: CoRR preprints are class `Informal` but bibtex `Article` |
| 37 | 2026-09-28 | A DBLP PID must be a `dblp:Person`; disambiguation pages (`AmbiguousCreator`) and other non-person creators fail as `IDENTITY_INVALID` (no writes) | Phase 5 implementation of §13.1 (invalid identity is a failure); recorded evidence: `00/10049` has 49 records of several people |
| 38 | 2026-09-28 | DBLP fetch = 3 validated SPARQL queries (identity, records, author signatures); fewer rows than `meta.result-size-total` → `INCOMPLETE` | Phase 5 implementation decision; single joined query measured at 31 s vs 1.5 s + 2.8 s split |
| 39 | 2026-09-28 | Shared discovery precondition check (`discoveryIdentity.ts`) used by OpenAlex and DBLP | Phase 5 refactor to avoid duplicating Phase 4 logic; OpenAlex behaviour and tests unchanged |
| 40 | 2026-09-28 | DBLP preprint rule replaced: PREPRINT = class `Informal` AND key under `journals/corr/`, or DOI `10.48550/`; `Informal` elsewhere → OTHER; `journals/corr/` alone not a signal; other class mappings unchanged (§7.3, §7.4 updated) | Architect decision after Phase 5 audit of recorded data: all 97 real CoRR preprints are Informal+CoRR; 11 published EPTCS/LMCS papers under journals/corr/ (Inproceedings/Article) were being split from their published records; 6 Dagstuhl Informal items are not preprints. Supersedes the DBLP part of #8 |
| 41 | 2026-09-28 | DBLP completeness hardening: `meta.result-size-total` required; delivered rows must equal it; author signatures must refer only to fetched records and every record must have one | Architect decision after Phase 5 audit (the check could previously be skipped silently and authors were not cross-checked) |
| 42 | 2026-09-28 | ORCID identity validated on the works request itself: checksum (no request if invalid), 404 → not found, 409 → invalid, response and summary paths must name the iD | Phase 6 implementation decision; verified live that invalid identities never yield an empty 200 (404/409); approved by architect |
| 43 | 2026-09-28 | Deprecated ORCID iD (documented 301) fails safely as `IDENTITY_INVALID` naming the primary iD; redirects not followed; nothing written | Architect decision in Phase 6 (redirect target documented as an orcid.org profile URL; no real example to verify) |
| 44 | 2026-09-28 | ORCID title = `title.title.value` only; subtitle kept in raw_metadata | Architect decision in Phase 6; 1 of 1,474 real summaries uses a genuine subtitle, 6 misuse it for a journal name |
| 45 | 2026-09-28 | ORCID completeness: `/works` has no paging and no reported total; completeness = full structural validation, put-codes listed twice kept once | Phase 6 implementation decision; verified live (1,351 summaries in one response, equal to `/record`); approved by architect |
| 46 | 2026-09-28 | Shared HTTP helper: optional `followRedirects: false`, `location` on responses, JSON body for pass-through statuses | Phase 6, additive; OpenAlex/DBLP behaviour and tests unchanged; approved by architect |
| 47 | 2026-10-13 | Backend ESLint mirrors the frontend's applicable TypeScript rules (no shared root config) plus type-aware `no-floating-promises` | Frontend config is only `eslint-config-next` presets with no custom rules; a root config would need a root `package.json` for plugin resolution. Kept separate from Phase 7; approved by architect |
| 48 | 2026-10-13 | When the DOI path ends without a match (blocked or several DOI owners), every other publication with the exact normalized title becomes a DuplicateCandidate; the record still gets its own publication (no new merge behaviour) | Phase 7 audit finding B1 (5 of 19 DOI-blocked development records lacked such candidates; §8.3 #24, §12.3); option (a) approved by architect |
| 49 | 2026-10-13 | Preprint vs OTHER on a shared DOI stays a preprint-vs-published contradiction (split + candidate); regression test added; plan unchanged | Phase 7 audit (C4/S1); no occurrence in development data or fixtures; approved by architect |
| 50 | 2026-10-13 | LaTeX in titles is not normalized (§7.2 unchanged); kept as a known limitation | Phase 7 audit (S2); affected matches become candidates (safe); deferred by architect |
| 51 | 2026-10-13 | OpenAlex completeness counts distinct work IDs against `meta.count` (refines #34) | Phase 7 audit (H1); stricter in the safe direction; approved by architect |
| 52 | 2026-10-13 | U+0000 → U+FFFD in every stored text field and in raw_metadata values and keys (key collisions get a deterministic `#n` suffix, never overwrite); a DOI containing U+0000 is absent; a record whose external ID contains U+0000 is skipped with a warning; warnings and fetch error messages quoting source values are sanitized the same way (§6.5, §7, §7.1 amended) | Found in Phase 7: PostgreSQL rejects U+0000 in text and JSON, so one such record failed on every run and stopped the identity's discovery; normalized titles and matching unchanged; approved by architect |
| 53 | 2026-10-13 | Password recovery added to scope (owner-approved exception to §3.2): professors recover by a 6-digit code emailed to their account address (10-minute expiry, 5 attempts, 60 s cooldown, 5 codes per hour, keyed HMAC storage, identical public responses, only active linked professors); the administrator only through a command-line utility; no HTTP admin reset, no SMS | Project owner decision before Phase 8 implementation; §3.2, §15.3, §15.4, §19 amended |
| 54 | 2026-10-13 | Recovery state stored as five columns on `users` (`password_reset_code_hash`, `_expires_at`, `_attempts`, `_last_sent_at`, `_send_count`), additive migration; no new table (still 9) | At most one active code per user; atomic single-row conditional updates suffice for cooldown, hourly limit, attempts and single-use consumption; §6.1 amended |
| 55 | 2026-10-13 | Recovery email via Nodemailer over generic SMTP configured by environment variables (no provider preset or provider API); missing configuration → recovery answers 503; tests use an in-memory mailer and Nodemailer's stream transport | Free start with a Gmail app password, later institute SMTP by configuration only; §4, §15.4 amended |
| 56 | 2026-10-13 | Admin account created and reset only with `npm run admin -- create/reset-password` (hidden prompt or `--password-stdin` with `--confirm`; email confirmation; single admin; same policy and hashing); replaces the earlier proposal of an initial admin password in environment variables | Owner decision; passwords never in arguments, environment files or output; §15.2, §15.4 amended |
| 57 | 2026-10-13 | Sessions: HS256 JWT (issuer/audience/algorithm pinned), 8 hours, in the `cse_session` HttpOnly SameSite=Lax cookie (Secure in production); every request reloads the user from the database; the token carries a fingerprint of the password hash instead of a role, so any password change or reset ends all sessions | Approved Phase 8 design (no schema change for session invalidation, no refresh tokens); §15.2 amended |
| 58 | 2026-10-13 | Account rules: emails trimmed and lowercased, passwords never normalized; policy ≥ 10 characters, ≤ 72 UTF-8 bytes, not the current password; generic login errors with a dummy hash comparison; inactive linked professors cannot sign in or keep sessions, unlinked professor accounts can (until Phase 9 links them); temporary passwords limited to me/change-password/logout | Approved Phase 8 design; §15.2 amended |
| 59 | 2026-10-13 | Dependency-free in-memory per-IP rate limiting on login, change-password and recovery endpoints; optional `TRUST_PROXY`; distributed limiting deferred to deployment hardening | Owner decision (not all IP protection deferred to Phase 15); process-local limits documented |
| 60 | 2026-10-13 | Phase 8 is backend-only; the login, change-password and recovery screens are built in Phase 14 | Approved Phase 8 scope (§17 `/login` belongs to frontend integration) |
| 61 | 2026-10-13 | Recovery attempt budget shared across codes: a recovery window lasts until an hour has passed since the last code was sent; within it at most 5 verification attempts in total (a replacement code does not restore them) and at most 5 codes; the budget and the send counter restart together, in the same atomic `UPDATE` | Phase 8 security audit F2: resetting attempts per code allowed up to 25 guesses per hour per account; refines #53 (no new column); §15.4 amended |
| 62 | 2026-10-13 | State-changing `/api` requests with an `Origin` header other than `CORS_ORIGIN` are refused (403 `ORIGIN_NOT_ALLOWED`), including logout; requests without `Origin` are allowed | Phase 8 security audit F4: defence in depth beyond SameSite=Lax cookies and JSON-only bodies; CORS alone is not relied on; §15.2 amended |
| 63 | 2026-10-13 | Reset tokens are bound to one issuance of a code (code hash + send time); every password change (change-password, recovery, admin CLI reset) clears a pending code and its attempts, keeping send limits | Phase 8 security audit F3/F7: earlier reset tokens could outlive a password change or a reissued identical code; §15.4 amended |
| 64 | 2026-10-13 | While a recovery window's attempt budget is used up, a recovery request issues nothing: no code generated or sent, no send slot used, last-send time and budget unchanged (same public response); enforced in the same atomic `UPDATE` | Follow-up to #61: sending unusable codes advanced the last-send time and could extend the lockout; §15.4 amended |
| 65 | 2026-10-13 | bcrypt cost 12 everywhere, except cost 4 when `NODE_ENV=test` **and** the configured database name (URL path of `DATABASE_URL`) ends in `_test`; unverifiable configuration fails closed to 12 | Defence in depth after the Phase 8 audit: `NODE_ENV=test` alone could have stored weak hashes in a real database |
| 66 | 2026-10-14 | Professor accounts: creating a professor creates its PROFESSOR user atomically; an account can be added to an existing professor without one; the temporary password is generated (CSPRNG, ≈100 bits), returned once in the response (`Cache-Control: no-store`), never stored in plain text or logged, and handed over by the administrator; no onboarding email; no admin endpoint to reset professor passwords (deferred; email recovery is the recovery path) | Owner decisions D1–D3 (Phase 9) |
| 67 | 2026-10-14 | `GET/PATCH /api/me/profile`: a professor reads their own profile and may edit only their own name; department, designation, email, status and identities are administrator-managed; the profile is derived from the session | Owner decision D4; §15.1 clarified |
| 68 | 2026-10-14 | Identity preview → save: preview validates with the existing source clients and writes nothing; a signed 15-minute token bound to professor, source and normalized submitted identifier is required to save, with no further external request (`verified_at` = preview time); the submitted ID is stored (merged OpenAlex IDs are shown, not substituted, #33); previews use a 20 s timeout and one retry, synchronization clients unchanged | Owner decisions D5, D6, D8 |
| 69 | 2026-10-14 | ORCID identity preview shows the public display name from the anonymous `/v3.0/{orcid}/person` endpoint (credit name, else given + family; absent if not public), plus works count, recent works and profile link; recorded fixtures added | Owner decision D7 (no OAuth or credentials needed); §13.5 clarified |
| 70 | 2026-10-14 | A professor's login email change is normalized, validated, unique, and clears any pending recovery code in the same transaction (send limits kept); the professor list is unpaginated and ordered by name | Owner decisions D9, D10 |
| 71 | 2026-10-14 | Professor deactivation changes only the professor's flag: identity flags and all relationships (including PENDING) are kept; sign-in and synchronization are already refused for inactive professors | Consistent with §6.10 (deactivation keeps all data) and §12.4 (cleanup applies to identities) |
| 72 | 2026-10-14 | Every professor decision carries `status` and `expectedStatus` and is one conditional update on relationship, owner, visible publication and expected status; a stale or concurrent change answers 409 `STATUS_CONFLICT` with the current status | Owner decision D1 (Phase 10): concurrent or stale decisions must not silently overwrite each other |
| 73 | 2026-10-14 | Requesting the status a relationship already has answers 409 `INVALID_TRANSITION`; decisions never move a relationship back to PENDING | Owner decision D2; §11 lists no same-status or to-PENDING transition |
| 74 | 2026-10-14 | Bulk approval takes 1–500 unique relationship IDs and approves only the professor's visible PENDING ones in one conditional update, answering `{ approved, skipped }` without identifying skipped IDs; no bulk rejection | Owner decision D3; §11 "bulk approval is supported" |
| 75 | 2026-10-14 | Relationships to SUPPRESSED publications are hidden from the professor (not listed, not counted, decisions 404, skipped in bulk); the list is paged (`limit` 50/200, `offset`) and ordered PENDING first, newest year (unknown last), title, id; `total` is filtered, `counts` unfiltered; the verified list is `status=APPROVED` on the same endpoint | Owner decisions D4–D6; §6.4 (suppressed = hidden), §11 (verified list) |
| 76 | 2026-10-14 | Professor-facing items expose relationship `id`, `status`, `origin`, `decidedAt`, `createdAt` and publication `id`, `title`, `year`, `venue`, `typeFamily`, `doi`, `authorNamesDisplay` plus distinct source types; nothing else | Owner decision D7 |

Superseded/rejected (kept for history): per-source `SyncJob` table (replaced by SyncRun/SyncTask); `SourceRecordProfessor` table (rejected; replaced by `discovered_via_identity_id`); repository layer (rejected); DBLP pid-XML/search/mirror access (rejected); MANUAL outranking API metadata (rejected); Levenshtein/`pg_trgm` fuzzy thresholds (rejected for now; fuzzy matching deferred); advisory-lock requirement (deferred).
