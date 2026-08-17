# Tenancy migration — cutover runbook

Daoval used to be implicitly single-tenant: any signed-in clinician could read every
patient row in the database. Two branches change that — one enforces organization-scoped
PHI access, the other links existing accounts so they can pass that check.

This document is the order they have to happen in. **The order is not cosmetic.** Getting
it wrong either leaves patient data readable across facilities, or takes it dark with no
route back except running the rest of the sequence.

Read this whole file before starting. Every script is dry-run by default and writes
nothing until `--apply`.

---

## Why the app goes dark, and why that is correct

Scope resolves through one chain:

```
users.location_id -> Location -> managingOrganization -> Organization
```

An account with a NULL `location_id` has no resolvable organization, so it is refused all
patient data with a 403. **Every account provisioned before the directory work has
`location_id = NULL`.** The moment enforcement deploys, every one of those clinicians is
locked out.

That is fail-closed behaving correctly, not a regression. The alternative — treating "I
could not work out who is asking" as "show them everything" — is the leak this whole
migration exists to close.

Separately, a row in `fhir_resources` with a NULL `organization_id` matches no
organization's scope, so it is invisible to everyone rather than visible to all. Existing
patient rows are in that state until stamped.

Both conditions are ended by the sequence below. Neither ends on its own.

---

## Sequence

### Step 0 — an administrator sets up the directory (manual, in the app)

**No script. Nothing below works without this.**

Administrators are *not* locked out: they only need directory resources
(`Organization` / `Location` / `Practitioner`), which are shared across organizations by
design and are never scoped. So there is always a working human at the top of this
sequence.

An administrator signs in and:
1. Creates the Organization for the facility, and **claims** it.
2. Creates a Location for every department that staff belong to.

If this is skipped, step 1 has nothing to attribute accounts to and step 3 has nothing to
link them to. Both refuse rather than guess.

### Step 1 — attribute accounts to an Organization

```
docker compose exec -T backend node server/backfill-user-organizations.js
docker compose exec -T backend node server/backfill-user-organizations.js --apply
```

Sets `users.organization_id`. **Does not restore anyone's access on its own.**

Refuses any account it cannot attribute from evidence, and prints the `--map` line needed
to resolve each one. If exactly one claimed Organization exists it takes the sole-
organization fast path and says so explicitly, including the justification.

### Step 2 — create Practitioner resources

```
docker compose exec -T backend node server/backfill-practitioners.js
docker compose exec -T backend node server/backfill-practitioners.js --apply
```

Creates one Practitioner per account with `Practitioner.id = users.id`, which makes the
`Practitioner/<user.id>` references that every AuditEvent and Provenance has always
carried resolve retroactively. Reports how many resolved before and after.

References naming accounts that no longer exist stay dangling and are reported as such.
That is honest — no Practitioner can be created for a user row that is gone.

### Step 3 — link clinicians to a Location

```
docker compose exec -T backend node server/link-user-locations.js
docker compose exec -T backend node server/link-user-locations.js --apply
```

Sets `users.location_id`. **This is the step that ends the go-dark.**

Requires step 1. Matches `users.department` exactly against Location names *within the
account's own organization*. Refuses ambiguous departments, unknown departments, and any
`--map` pointing at another facility's Location.

No re-login is needed. `resolveFacility` reads the live user row rather than the session
token, so a clinician holding a valid session picks this up on their very next request.

### Step 4 — re-run the resource stamp

```
docker compose exec -T backend node server/backfill-organization-id.js
docker compose exec -T backend node server/backfill-organization-id.js --apply
```

**Easy to skip, and skipping it is the catch in this whole runbook.**

This script correctly exited 1 before an Organization existed — it had nothing to
attribute rows to and refused to guess. It must be re-run after step 0 or the existing
patient rows stay invisible even once clinicians have regained access.

The symptom of skipping it is precise and misleading: clinicians get **HTTP 200 with an
empty result set** instead of a 403. Access is restored, the app looks like it works, and
there are no patients in it.

> **Precondition, and it differs from step 1's.** This script's sole-organization fallback
> counts **all** `Organization` resources, whereas step 1 counts **claimed** ones. A stray
> unclaimed Organization therefore blocks it, and unlike step 1 it has no `--map` escape.
> If it refuses for this reason, either remove the stray Organization or attribute the
> rows deliberately before continuing.

---

## Verifying a clinician actually regained access

The column being set is not the same claim as access being restored — the Location it
points at still has to resolve to an organization. Check the chain, not the column:

```sql
SELECT count(*) FROM users u
JOIN fhir_resources l ON l.resource_type = 'Location' AND l.id = u.location_id
WHERE u.role <> 'administrator'
  AND l.data->'managingOrganization'->>'reference' LIKE 'Organization/%';

SELECT count(*) FROM users WHERE role <> 'administrator' AND location_id IS NULL;
```

Then confirm over HTTP as a real clinician. `GET /fhir/Patient` should return **200 with a
non-zero total**. The three outcomes are distinguishable on purpose:

| Response | Meaning |
|---|---|
| 403, *"not linked to a department"* | Step 3 has not taken effect for this account |
| 200, `total = 0` | Access restored, but **step 4 was skipped** — rows are unstamped |
| 200, `total > 0` | Migration complete for this account |

To confirm step 2, take any `who.reference` from an existing AuditEvent or Provenance and
fetch it — `GET /fhir/Practitioner/<id>` should return 200 rather than 404.

---

## Notes

- Every script is idempotent. A second `--apply` writes 0.
- Every script exits non-zero when it could not finish the job, so a partial run cannot be
  mistaken for a clean one by whatever drives the deploy.
- None of these run on server boot. Nothing that writes existing rows belongs in
  `migrate()`.
- Suspended accounts are backfilled too. They fail login on the suspension check, which
  fires before the tenancy check, and skipping them would leave them broken on reinstate.
- What this migration does **not** close: a clinician who guesses another facility's
  resource id can still overwrite its body via PUT. That predates this work. The
  organization column is written once and preserved on update, so such a write cannot move
  a row between facilities, but the body is not protected. Closing it is a separate change.
