# Daoval — technical summary

## Stack

**Frontend:** React 18 + Vite, React Router. Plain CSS (no UI kit) with a design-token
system in `src/index.css` — teal/paper clinical palette, Source Serif 4 + IBM Plex
Sans/Mono, an ECG-waveform "trace rule" as the signature visual motif.

**Backend:** Node.js, no framework — a small dependency-light HTTP server
(`server/index.js`) implementing a FHIR-ish REST surface plus a real `/auth/*` API.

**Database:** PostgreSQL 16. One JSONB table (`fhir_resources`) holding all clinical
resources (Patient, Encounter, Observation, etc.), plus `users`, `login_challenges`,
and `access_log` tables for auth and audit.

**Auth:** bcrypt password hashing, email one-time codes as MFA, JWT sessions in an
HttpOnly/Secure/SameSite cookie. AWS SES for sending the codes (not yet wired to real
AWS credentials — currently logs codes to the server console in dev mode).

**Infrastructure:** Single AWS EC2 instance (t3.small, 2GB RAM — resized up from the
original t3.micro once memory pressure was a concern), Docker Compose running three
containers — Postgres, the Node backend, and Caddy (serves the built React app +
reverse-proxies `/fhir/*` and `/auth/*` to the backend + automatic TLS via Let's
Encrypt). DuckDNS for the domain (free), since a paid domain wasn't set up yet.

## What's done

1. **Deployment.** Moved off the original JSON-file demo backend onto real Postgres,
   containerized the whole stack, and got it running on AWS behind HTTPS. Confirmed
   working end to end: health check, patient search, resource creation, and the
   transaction-bundle flow used for signing a full clinical encounter.
2. **Real authentication.** Replaced the hardcoded mock login table with actual
   provisioned accounts: bcrypt-hashed passwords, real email-based MFA codes
   (hashed at rest, 10-minute expiry, attempt-limited), JWT session cookies, and
   login throttling (8 failed attempts locks an email for 15 minutes). Tested:
   correct login, wrong password, wrong code, and the rate limit all behave
   correctly.
3. **Roles and administration.** Added `administrator` / `doctor` / `nurse` roles.
   Administrators get their own panel to create new accounts (with a one-time
   temporary password) and see everyone provisioned so far. A doctor account was
   confirmed unable to reach the administrator API (403), proving the role check
   actually enforces something rather than just hiding a button.
4. **First administrator.** Since there's no admin to begin with, `create-admin.js`
   is a one-time script you run directly on the server to create the first one.
   Every administrator after that is added through the app itself.
5. **Welcome screen.** Single sign-in form ("Welcome to Daoval") that routes people
   to the right place — the admin panel or the clinical dashboard — based on the
   account's actual stored role, decided server-side after authentication. (Deliberately
   not a pre-login "pick your role" button, which would just be cosmetic and easy to
   game.)
6. **Visual design pass (partial).** Added real interaction depth across the shared
   CSS: hover/press states with transitions on buttons, cards, and list rows; a
   proper focus ring; richer shadows. Gave the welcome screen a real hero moment —
   the ECG trace line now draws itself in once on load, like a monitor powering on —
   kept as the one animated flourish in the app rather than scattered everywhere.

## What still needs work

**Blocking, before this touches real patient data:**
- ~~SES isn't wired up~~ **Resolved differently than planned.** AWS SES's free tier
  was discontinued for new accounts before this got built, and Brevo (the free
  alternative tried first) had sign-up friction. Landed on **Mailjet** via generic
  SMTP (`nodemailer`) instead — free tier, 6,000 emails/month. Not yet confirmed
  actually delivering in production; last known status was mid-setup.
- **A real domain.** Still on the free DuckDNS subdomain. Fine for testing, not
  something to put in front of real patients or run a real clinic brand on. (Cloudflare
  Registrar, ~$10/year, was the earlier recommendation.)
- **The organizational side of HIPAA is still untouched.** Signing the AWS BAA,
  encrypting the disk, and now real auth are the technical floor — a documented risk
  assessment, written policies, workforce training, and a breach-notification
  procedure haven't been discussed at all yet, and no code changes substitute for
  them.
- **A real PHI access-control gap existed and was fixed.** `/fhir/*` (actual patient
  data) had no session check at all, and the frontend never even sent the session
  cookie to those endpoints — meaning clinical data was reachable without being
  logged in, despite login/MFA existing. Both sides are now fixed: the backend
  requires a valid session on every `/fhir/*` route, and `fhirClient.js` sends
  credentials on every request. Confirmed with a real request test (401 without a
  session, 200 with one) before shipping.
- **A second PHI access-control gap existed and was fixed: cross-organization
  reads.** Requiring a session fixed "logged out people can read patient data"; it
  did not fix "any logged-in clinician can read *every* organization's patient
  data." `GET /fhir/Patient` returned every patient row in the database regardless
  of which facility the caller worked at. `fhir_resources` now carries an
  `organization_id` column, reads are filtered on it in SQL, and the store's read
  functions take the scope as a required argument that throws when absent — the
  unfiltered code path was deleted rather than guarded, because the store's search
  starts from every row and subtracts, so a missing filter would otherwise have
  returned everything while looking like working code.

  Three things are true about the fix, and the third matters: it closes
  cross-organization reads, it refuses writes from an account whose organization
  can't be determined, and it does **not** close cross-organization writes to a
  *guessed* resource id. That last hole predates this work and is still open — a
  clinician who knows another facility's Encounter id can still overwrite its
  body. What is guaranteed is that such a write cannot move the row between
  organizations, because `organization_id` is written once and preserved on every
  later write. Closing it properly is its own change, deliberately separated
  because a target-row owner check touches the facility-stamp coupling documented
  in `server/index.js`.

  Directory resources (`Organization`, `Location`, `Practitioner`) are
  deliberately shared across organizations — they carry no PHI, and scoping them
  would deadlock setup, since a new administrator could not read back the
  Organization they just created in order to claim it.

  **Unstamped rows are unreachable, not public.** A row with a NULL
  `organization_id` matches no organization's scope, so anything that predates the
  column is invisible until backfilled by `server/backfill-organization-id.js`.
  That script derives ownership from evidence in the data and refuses to guess
  when there isn't any; it exits non-zero if any row is left unattributed.
- **Interoperability with other hospital systems doesn't exist yet.** See
  `INTEROPERABILITY_PLAN.md` — this is the largest remaining piece of Daoval's actual
  mission (unifying fragmented EHRs) and hasn't been started. Currently Daoval only
  knows about data entered directly into it.

**Not blocking, but incomplete:**
- **Terminology data** (`src/fhir/codes.js`) is still a small sample list of
  ICD-10/SNOMED/RxNorm codes, not a real terminology service.
- **The visual design pass only touched shared tokens + the sign-in screen.**
  Dashboard and the clinical documentation pages (encounter entry, review & sign,
  etc.) haven't had the same treatment yet — they'll inherit the improved button/card/
  input styling automatically, but haven't been individually reviewed.
- **Self-service password reset doesn't exist.** If someone forgets their password
  (as opposed to still being on a never-changed temporary one, which is now enforced
  — see below), an administrator has to manually re-provision their account. Discussed
  and deliberately deferred — the manual workaround is genuinely fine at this scale.

## Recently resolved (this session)

- **`force_password_change` is now actually enforced**, not just a dead column.
  Admin-created accounts start with the flag set; login reports it; the frontend
  redirects to a mandatory change-password screen; and — the part that actually
  matters — the *backend* independently rejects `/fhir/*` requests from an account
  with the flag still set (403), so this isn't just a UI redirect someone could route
  around by calling the API directly. Tested end to end: create account → login with
  temp password → blocked from patient data → wrong-current-password rejected →
  correct change succeeds → immediate access granted.
- **Nightly Postgres backups to S3** — real script (`scripts/backup-to-s3.sh`),
  IAM-role-based (no access keys on disk), encrypted, with a tested restore path
  (`scripts/restore-from-s3.sh`). Setup steps in `BACKUPS.md`. Not yet confirmed
  actually scheduled via cron on the live instance — script exists and is reviewed,
  but "is it in the crontab and has it run" hasn't been verified back.
- **CloudTrail is on.**
- **Instance resized** to t3.small (2GB RAM) from the original t3.micro (1GB), which
  was tight running Postgres + Node + a Vite build together.

## Suggested next order

1. Confirm Mailjet is actually delivering MFA emails in production (last known status:
   mid-setup after Brevo sign-up issues).
2. Confirm the backup cron job is actually scheduled and has produced at least one
   real backup in S3 — and do one test restore, per the "a backup you've never
   restored isn't verified" note in `BACKUPS.md`.
3. Real domain, once ready to stop treating this as a test deployment.
4. Finish the visual pass across the remaining pages.
5. Start on interoperability (see `INTEROPERABILITY_PLAN.md`) — the largest remaining
   build, and the actual core of Daoval's mission statement.
6. The HIPAA organizational program — separate from all of the above, and on your
   own timeline, but it's the piece with no technical shortcut.
