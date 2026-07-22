# Daoval — Doctor Input Frontend

A React implementation of the Daoval doctor-facing app: patient search, registration, and
clinical encounter documentation, built from the v1.1 (HIPAA/FHIR R4) specification.

## Stack

- **React 18 + Vite**, React Router for the 8-screen flow in the spec.
- **No UI kit** — plain CSS with design tokens in `src/index.css`.
- **Storage: local-first, server-synced.** Every write lands in `localStorage`
  immediately (so the UI, autosave, and offline use never block on network), then is
  mirrored to a **HAPI FHIR R4 server** — the one you'll run on AWS — in the background.
  A small outbox/sync worker replays anything that couldn't reach the server yet.

## Getting started (working demo, two terminals)

**Terminal 1 — backend** (zero dependencies, nothing to `npm install` for this part):

```bash
npm run server
```

This starts `server/index.js`, a small FHIR-ish REST server on
`http://localhost:3001/fhir`, backed by a JSON file at `server/data/db.json`. It seeds
two demo patients on first run so search works immediately. Delete
`server/data/db.json` any time to reset to a clean slate.

**Terminal 2 — frontend:**

```bash
npm install
cp .env.example .env   # already points VITE_FHIR_BASE_URL at localhost:3001
npm run dev
```

Open the URL Vite prints (usually `http://localhost:5173`). Sign in with the mock,
provisioned-account-style login (spec section 3 — no self-signup):
`dr.hassan@daoval-clinic.test` / `Cl1nic!Passw0rd` / MFA code `123456`.

Try it end to end: search "Mona" or "Karim" (the seeded patients) → open the chart →
+ New encounter → fill it in (pick a diagnosis from the Assessment typeahead dropdown —
it must resolve to a code, per spec) → Review & sign. Then check
`server/data/db.json` — you'll see the real `Encounter`, `Observation`, `Condition`,
`Provenance`, and `AuditEvent` resources that were written.

Stop either process and the frontend keeps working entirely offline (writes queue
locally and drain into the backend once it's back) — that's the local-first behavior
described below, now actually exercisable against a real server round-trip.

## Where storage happens

- **`src/services/fhirClient.js`** — a thin wrapper around the HAPI FHIR REST API
  (`create`, `update`, `read`, `search`, transaction `Bundle` submit, and a `/metadata`
  ping used for online/offline detection). This is the only file that knows the HAPI
  FHIR wire format.
- **`src/services/localStore.js`** — a `localStorage`-backed mirror per resource type,
  plus an **outbox** queue of writes that haven't reached the server yet.
- **`src/services/dataService.js`** — the module every screen actually calls
  (`saveResource`, `saveEncounterBundle`, `findPatients`, `getPatient`,
  `getEncountersForPatient`). It writes local first, tries the server, queues on
  failure, and runs a background interval (`VITE_SYNC_INTERVAL_MS`, default 15s) that
  drains the outbox once connectivity returns.
- **`src/fhir/mappers.js`** — builds the actual FHIR R4 resources (Patient, Encounter,
  Observation, Condition, MedicationRequest, AllergyIntolerance, Immunization,
  DocumentReference, Provenance, Consent) from form state, matching the field→resource
  mapping tables in the spec.
- **`src/services/auditService.js`** — every read/write is logged as a FHIR
  `AuditEvent` (spec section 11), including break-glass access with
  `AuditEvent.purposeOfEvent`.

A full encounter is submitted as a single FHIR **transaction Bundle** at Sign & Finalize
(`saveEncounterBundle`), so all its resources (vitals, allergies, diagnoses,
medications, immunizations, Provenance) either land together or are queued together —
no half-signed encounters.

## The included demo backend

`server/index.js` + `server/store.js` is a small, dependency-free Node HTTP server that
implements exactly the FHIR REST surface `src/services/fhirClient.js` calls:

- `GET /fhir/metadata` — capability check, used for online/offline detection
- `POST /fhir/{ResourceType}` — create
- `PUT /fhir/{ResourceType}/{id}` — update
- `GET /fhir/{ResourceType}/{id}` — read
- `GET /fhir/{ResourceType}?name=...&identifier=...&patient=...&_sort=-date&_count=N` — search
- `POST /fhir` with a `Bundle` body — transaction bundle (used for atomic encounter signing)
- CORS + `OPTIONS` preflight handling, since it's a different origin/port from Vite

Data persists to `server/data/db.json`, a flat JSON file loaded into memory and
rewritten after every write. That's plenty for demoing and local development; it is
**not** what you'd run in a clinic — no auth, no real search semantics, no FHIR
validation, single-writer. It exists so this project runs as a real working full-stack
demo without needing Docker, Java, or a live AWS account.

Swap it for a real server by changing exactly one thing: `VITE_FHIR_BASE_URL` in
`.env`. Nothing in the frontend needs to change, because it already only talks to that
one FHIR-shaped surface — see the AWS deployment path below for the production version.

## Deploying a HAPI FHIR server on AWS

The frontend is server-agnostic (any FHIR R4-conformant server works), but here's the
straightforward path with **HAPI FHIR JPA Server** on AWS:

1. **Database**: Amazon RDS for PostgreSQL (HAPI FHIR JPA server supports Postgres out
   of the box). Put it in a private subnet.
2. **Compute**: Run the `hapiproject/hapi:latest` image on **ECS Fargate** (simplest to
   operate) or EKS if you already run Kubernetes. Point `hapi.properties` /
   `HAPI_FHIR_...` env vars at the RDS instance.
3. **Networking**: An **Application Load Balancer** in front of the ECS service, with
   an ACM TLS certificate — HIPAA requires encryption in transit, so don't skip this.
   Point `VITE_FHIR_BASE_URL` at `https://<your-alb-domain>/fhir`.
4. **Storage for attachments**: if `DocumentReference.content.attachment` payloads grow
   large, configure HAPI FHIR's binary storage to use an **S3 bucket** (via HAPI's
   `DatabaseBlobBinaryStorageSvc` alternative, `S3BinaryStorageSvc`) rather than storing
   large base64 blobs in Postgres.
5. **Auth**: put the FHIR server behind OAuth2/SMART-on-FHIR (e.g. Amazon Cognito as
   the authorization server, or Keycloak on ECS) and set `VITE_FHIR_AUTH_TOKEN` — or
   better, wire a real token-refresh flow into `fhirClient.js` instead of a static env
   token, which is dev-only.
6. **Audit/logging**: HAPI FHIR can write `AuditEvent` resources itself for every REST
   call (`hapi.fhir.enable_repository_validating_interceptor` + logging interceptors);
   combine with this app's own `AuditEvent` writes from `auditService.js`, and ship
   ALB/ECS logs to **CloudWatch** with a retention policy that matches your HIPAA
   documentation requirements.
7. **Backups**: RDS automated backups + snapshots; treat FHIR data with the same backup
   rigor as any PHI database.

None of the above needs to change frontend code — everything is driven by
`VITE_FHIR_BASE_URL`, `VITE_FHIR_AUTH_TOKEN`, and `VITE_TENANT_ID` in `.env`.

## What's implemented vs. stubbed

Implemented per spec: all 8 screens, field-level validation, out-of-range **warn, never
block** vitals, identity-confirmation search gate, duplicate National ID check, sticky
patient context banner, autosave (2s debounce) with local draft recovery on refresh,
signed-record immutability with amendment-only edits, attestation gate, idle-timeout
re-auth modal (not a redirect — draft state is preserved), and break-glass modal writing
to `AuditEvent.purposeOfEvent`.

Stubbed, ready to swap for real integrations:
- **ICD-10 / SNOMED / RxNorm / CVX typeaheads** (`src/fhir/codes.js`) use small sample
  lists. Point `CodeTypeahead` at a real terminology service (e.g. a FHIR `$expand` on
  your HAPI FHIR server's `ValueSet`, or an external terminology API) for production.
  - **MFA / account provisioning** is a mock table in `AuthContext.jsx` standing in for
  admin-provisioned accounts + a real MFA provider (e.g. Cognito, Okta, or a TOTP
  library).
- **RBAC** — the "doctor" role is assumed throughout; `PatientProfile`'s admin-only
  edit button is disabled as a placeholder for a real role check.

## Project structure

```
server/
  index.js        zero-dependency FHIR-ish REST backend (npm run server)
  store.js        JSON-file-backed resource store + search
  data/db.json    generated on first run; delete to reset
src/
  services/       fhirClient.js, localStore.js, dataService.js, auditService.js
  fhir/           codes.js (value sets), mappers.js (form → FHIR resource)
  context/        AuthContext, PatientContext
  components/     PatientBanner, SyncStatus, CodeTypeahead, BreakGlassModal, ReauthModal
  pages/          SignIn, Dashboard, SearchResults, RegisterPatient, PatientProfile,
                   ReviewSign, ViewAmend, NewEncounter/ (Vitals, History, Allergies,
                   Exam, Assessment, Plan, PreventiveCare)
```
