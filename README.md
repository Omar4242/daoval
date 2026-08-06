# Daoval — Doctor Input Frontend

A React implementation of the Daoval doctor-facing app: patient search, registration, and
clinical encounter documentation, built from the v1.1 (HIPAA/FHIR R4) specification —
plus a Postgres-backed Node backend with real authentication.

## Stack

- **Frontend:** React 18 + Vite, React Router. No UI kit — plain CSS with design tokens
  in `src/index.css`.
- **Backend:** Node 20, no framework — `server/index.js` is a single `node:http` server
  exposing a FHIR-ish REST surface at `/fhir/*` and an auth API at `/auth/*`.
- **Database:** PostgreSQL 16. All clinical resources live in one JSONB table
  (`fhir_resources`); `users`, `login_challenges`, and `access_log` handle auth and audit.
- **Auth:** bcrypt passwords, emailed one-time codes as MFA, JWT sessions in an
  HttpOnly/Secure/SameSite=Strict cookie.
- **Storage model (frontend):** in-memory-first, server-synced. Every write lands in an
  in-memory mirror immediately (so the UI and autosave never block on network), then is
  mirrored to the backend. An outbox/sync worker replays anything that couldn't get
  through. **This mirror does not survive a page refresh** — no localStorage, no
  IndexedDB. It's session-only durability, not offline persistence across reloads.

## Running it

The whole stack runs under Docker Compose — Postgres, the Node backend, and Caddy
(static frontend + reverse proxy + automatic TLS):

```bash
cp .env.production.example .env    # then fill in POSTGRES_PASSWORD and JWT_SECRET
docker compose up --build
```

Both `POSTGRES_PASSWORD` and `JWT_SECRET` are required — the backend refuses to start
without `JWT_SECRET` (`server/authService.js:11-14`) or `DATABASE_URL`
(`server/db.js:14-18`). Generate the secret with `openssl rand -base64 48`.

Everything is served from one origin: Caddy routes `/fhir/*`, `/auth/*`, and `/healthz`
to the backend and serves the built SPA for everything else (see `Caddyfile`).

There is no separate schema step. `migrate()` in `server/db.js` runs on every boot and
is written to be idempotent (`CREATE TABLE IF NOT EXISTS` / `ADD COLUMN IF NOT EXISTS`).
There is no migration tool and no version table — schema changes are appended to that
one function and must stay safely re-runnable.

### Creating the first administrator

There's no self-signup, and the admin UI itself requires an administrator session — so
the first account is created directly on the server:

```bash
read -s -p "Password (min 12 chars): " ADMIN_PASSWORD; echo
docker compose exec -T \
  -e ADMIN_EMAIL="you@example.com" \
  -e ADMIN_NAME="Your Name" \
  -e ADMIN_ORGANIZATION="Riverside General Hospital" \
  -e ADMIN_PASSWORD="$ADMIN_PASSWORD" \
  backend node server/create-admin.js
```

Every account after that is provisioned through the app by an administrator, who sets a
one-time temporary password the recipient is forced to change at first sign-in.

### Signing in

Password, then a 6-digit code emailed to the same address. While `SMTP_HOST`/`SMTP_FROM`
are unset and `NODE_ENV=development`, codes are **printed to the backend log** instead of
emailed — `docker compose logs backend`. With `NODE_ENV=production` and no SMTP
configured, login deliberately fails rather than silently skipping MFA.

### A note on `npm run dev`

The two-terminal Vite + `npm run server` workflow **does not currently work for
authentication**. `src/services/authApi.js` calls `/auth/*` as a relative path, and
`vite.config.js` defines no dev proxy — so those requests hit the Vite dev server on
:5173 and 404. Since `/fhir/*` now requires a valid session cookie, that makes the app
unusable that way. Use Docker Compose, or add a `server.proxy` entry to `vite.config.js`
pointing `/auth` and `/fhir` at `http://localhost:3001`.

## Where storage happens

- **`src/services/fhirClient.js`** — thin wrapper around the backend's REST surface
  (`create`, `update`, `read`, `search`, transaction `Bundle` submit, and a `/metadata`
  ping used for online/offline detection). The only file that knows the wire format.
  Sends `credentials: 'include'` on every call — without it the session cookie is
  dropped and every request looks signed-out.
- **`src/services/memoryStore.js`** — in-memory mirror per resource type, plus an
  **outbox** queue of writes that haven't reached the server. Lives only for the current
  page load.
- **`src/services/dataService.js`** — the module every screen actually calls
  (`saveResource`, `saveEncounterBundle`, `findPatients`, `getPatient`,
  `getEncountersForPatient`). Writes to the mirror first, tries the server, queues on
  failure, and runs a background interval (`VITE_SYNC_INTERVAL_MS`, default 15s) that
  drains the outbox once connectivity returns.
- **`src/fhir/mappers.js`** — builds the FHIR R4 resources (Patient, Encounter,
  Observation, Condition, MedicationRequest, AllergyIntolerance, Immunization,
  DocumentReference, Provenance, Consent) from form state.
- **`src/services/auditService.js`** — every read/write is logged as a FHIR `AuditEvent`
  (spec section 11), including break-glass access via `AuditEvent.purposeOfEvent`.

A full encounter is submitted as a single FHIR **transaction Bundle** at Sign & Finalize
(`saveEncounterBundle`), so all its resources land together or queue together — no
half-signed encounters.

## The backend

### `/fhir/*` — clinical data

- `GET /fhir/metadata` — capability statement, used for online/offline detection
- `POST /fhir/{ResourceType}` — create
- `PUT /fhir/{ResourceType}/{id}` — update
- `GET /fhir/{ResourceType}/{id}` — read
- `GET /fhir/{ResourceType}?...` — search
- `POST /fhir` with a `Bundle` body — transaction bundle, with `urn:uuid:` reference
  rewriting so intra-bundle links survive server-assigned ids

**Every `/fhir/*` route requires a valid session cookie**, including `metadata`. On each
request the backend also re-checks the account against the database, so a suspension or
an unmet forced-password-change takes effect immediately rather than waiting out the
token's 12h expiry. Administrator accounts are refused (403) — they manage staff, not
patient records — and that's enforced server-side, not just hidden in the UI.

Resource storage is deliberately generic: one JSONB row per `(resource_type, id)`, no
per-type tables and no FHIR validation. `POST /fhir/{anything}` will persist. Note that
`createResource` upserts (`ON CONFLICT DO UPDATE`), so a POST carrying an existing id
overwrites rather than erroring.

Search is thin and worth knowing the limits of: `server/store.js` supports exactly
`name`, `identifier`, `patient`, `_sort=-date`, and `_count`, and filters in JavaScript
after loading the whole resource type. **Any other parameter is silently ignored** — you
get an unfiltered result set, not an error.

### `/auth/*` — accounts and sessions

`login` → `verify` (password, then emailed OTP), `logout`, `me`, `change-password`,
`forgot-password` → `reset-password`, `reauth/request` → `reauth/verify` for the
idle-timeout unlock, and administrator-only `admin/users` (list, create) and
`admin/users/{id}/status` (suspend/reinstate).

Hardening that's actually implemented: bcrypt cost 12; OTPs stored as SHA-256 hashes with
a 10-minute expiry and a 5-attempt limit; login codes and reauth codes are not
interchangeable; 8 failed logins lock an email for 15 minutes, with a separate 5-per-15
limit on password-reset requests; `forgot-password` always returns the same response
whether or not the account exists.

`/healthz` is the only route reachable without a session and outside `/fhir`.

## Deployment

Single small VM (EC2), Docker Compose, Caddy for TLS. Full walkthrough in
**`DEPLOYMENT.md`**; nightly encrypted `pg_dump` to S3 and CloudTrail setup in
**`BACKUPS.md`**.

Config is `.env` beside `docker-compose.yml` — see `.env.production.example`. The
frontend's `VITE_FHIR_BASE_URL` is baked in at build time and is just `/fhir` in this
deployment, because the SPA and the API share an origin behind Caddy.

## What's implemented vs. stubbed

Implemented per spec: all clinical screens, field-level validation, out-of-range **warn,
never block** vitals, identity-confirmation search gate, duplicate National ID check,
sticky patient context banner, autosave (2s debounce) with draft recovery, signed-record
immutability with amendment-only edits, attestation gate, idle-timeout re-auth modal
(a modal, not a redirect — draft state is preserved), and break-glass writing to
`AuditEvent.purposeOfEvent`.

Also real, and not stubs any more: authentication, MFA, provisioned accounts, and
role-based access control across `administrator` / `doctor` / `nurse` / `technician`.

Still stubbed or incomplete:

- **Terminology** (`src/fhir/codes.js`) — small sample ICD-10/SNOMED/RxNorm/CVX lists,
  not a real terminology service. Point `CodeTypeahead` at a `ValueSet/$expand` or an
  external terminology API for production.
- **Email delivery** — generic SMTP via `nodemailer`, provider-agnostic. Not yet
  confirmed delivering in production; codes log to the console until it is.
- **Edit demographics** on `PatientProfile` is still a disabled placeholder button.
- **`X-Tenant-Id`** — `fhirClient.js` sends this header (from `VITE_TENANT_ID`) on every
  request and the server never reads it. It does not partition anything today.
- **Organization scoping of clinical data** — staff accounts are scoped by organization,
  but `fhir_resources` has no tenant column and `/fhir/*` applies no organization filter.
  See `INTEROPERABILITY_PLAN.md`.

## Project structure

```
server/
  index.js        HTTP server: /fhir/*, /auth/*, /healthz
  db.js           Postgres pool + idempotent schema bootstrap (migrate())
  store.js        resource store over the fhir_resources JSONB table + search
  authService.js  bcrypt, OTP challenges, JWT sessions, user CRUD
  create-admin.js one-time first-administrator bootstrap
src/
  services/       fhirClient.js, memoryStore.js, dataService.js, auditService.js, authApi.js
  fhir/           codes.js (value sets), mappers.js (form → FHIR resource)
  context/        AuthContext, PatientContext
  components/     PatientBanner, SyncStatus, CodeTypeahead, BreakGlassModal, ReauthModal,
                    ProtectedRoute, Brand, TraceRule
  pages/          Landing, SignIn, ForgotPassword, ChangePassword, Dashboard,
                    SearchResults, RegisterPatient, PatientProfile, ReviewSign, ViewAmend,
                    NewEncounter/ (Vitals, History, Allergies, Exam, Assessment, Plan,
                    PreventiveCare), admin/AdminUsers
```
