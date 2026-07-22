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

**Infrastructure:** Single AWS EC2 instance (t3.micro), Docker Compose running three
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
- **SES isn't actually wired up.** MFA codes only print to the server console right
  now. Needs an IAM role (or access keys) on the EC2 instance, a verified sender
  identity in SES, and — worth flagging clearly — SES starts in **sandbox mode**,
  meaning it can only email addresses you've individually verified until you request
  production access from AWS. That request needs to go in before this is usable with
  real, unpredictable email addresses.
- **A real domain.** Still on the free DuckDNS subdomain. Fine for testing, not
  something to put in front of real patients or run a real clinic brand on. (Cloudflare
  Registrar, ~$10/year, was the earlier recommendation.)
- **The organizational side of HIPAA is still untouched.** Signing the AWS BAA,
  encrypting the disk, and now real auth are the technical floor — a documented risk
  assessment, written policies, workforce training, and a breach-notification
  procedure haven't been discussed at all yet, and no code changes substitute for
  them.
- **Password reset / forgot-password flow doesn't exist.** Right now if someone loses
  their temporary password, an administrator has to notice and re-provision them
  manually — there's no self-service reset.
- **`force_password_change` is a column that isn't enforced yet.** New accounts get a
  temporary password but aren't actually required to change it at first login — that
  needs a frontend gate.

**Not blocking, but incomplete:**
- **Instance sizing.** Currently on t3.micro (1GB RAM), which is tight for Postgres +
  Node + a Vite build running together — a swap file was recommended as a stopgap.
  Worth confirming it's stable under real use, or resizing to t3.small.
- **Terminology data** (`src/fhir/codes.js`) is still a small sample list of
  ICD-10/SNOMED/RxNorm codes, not a real terminology service.
- **The visual design pass only touched shared tokens + the sign-in screen.**
  Dashboard and the clinical documentation pages (encounter entry, review & sign,
  etc.) haven't had the same treatment yet — they'll inherit the improved button/card/
  input styling automatically, but haven't been individually reviewed.
- **No automated backups yet.** The `pg_dump`-to-S3 script from the deployment guide
  hasn't actually been set up as a running cron job on the instance.
- **CloudTrail** (account-level infrastructure audit logging) was documented in the
  deployment guide but not yet turned on.

## Suggested next order

1. Wire real SES + request production access (unblocks actually testing MFA as a
   real user would experience it).
2. Enforce `force_password_change` on first login.
3. Backups + CloudTrail (cheap, one-time setup, and the kind of thing you don't want
   to remember only after losing data).
4. Real domain, once ready to stop treating this as a test deployment.
5. Finish the visual pass across the remaining pages.
6. The HIPAA organizational program — separate from all of the above, and on your
   own timeline, but it's the piece with no technical shortcut.
