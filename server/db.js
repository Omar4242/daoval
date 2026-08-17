// Postgres connection pool + schema bootstrap.
//
// Storage model: one table, `fhir_resources`, holding every FHIR resource as a JSONB
// blob keyed by (resource_type, id) — this mirrors the shape of the old db.json file
// closely on purpose, so store.js's logic barely changes. It is NOT a real FHIR
// database engine (no per-field indexing, no FHIR search grammar) — it's "the demo
// backend, but durable and real." If Daoval outgrows this, the next step is a real
// HAPI FHIR JPA server (see README), not a bigger version of this table.

import pg from 'pg'

const { Pool } = pg

if (!process.env.DATABASE_URL) {
  throw new Error(
    'DATABASE_URL is not set. Example: postgres://daoval:PASSWORD@localhost:5432/daoval'
  )
}

// SSL: required for any managed Postgres reached over the network (RDS, etc). Disabled
// only for a same-host/same-compose-network connection where the traffic never leaves
// the box. Controlled explicitly via PGSSL rather than sniffed from the hostname.
const useSSL = process.env.PGSSL === 'require'

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: useSSL ? { rejectUnauthorized: false } : false,
  max: Number(process.env.PG_POOL_MAX) || 10,
})

pool.on('error', (err) => {
  // A background/idle client error should not crash the whole server.
  console.error('daoval-server: unexpected Postgres pool error', err)
})

export async function migrate() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS fhir_resources (
      resource_type   text NOT NULL,
      id              text NOT NULL,
      version_id      integer NOT NULL DEFAULT 1,
      data            jsonb NOT NULL,
      last_updated    timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (resource_type, id)
    );

    CREATE INDEX IF NOT EXISTS fhir_resources_type_idx
      ON fhir_resources (resource_type);

    -- Speeds up the patient/subject-reference search used by encounter history.
    CREATE INDEX IF NOT EXISTS fhir_resources_subject_idx
      ON fhir_resources USING gin ((data -> 'subject'));
    CREATE INDEX IF NOT EXISTS fhir_resources_patient_ref_idx
      ON fhir_resources USING gin ((data -> 'patient'));

    -- No index for the ?organization= search param: filtering happens in Node, not SQL,
    -- so add a GIN index on managingOrganization/serviceProvider when/if that moves.

    -- Which organization owns this row. This is the tenancy boundary for PHI reads:
    -- store.js filters on it in SQL, before any of the Node-side search-param logic
    -- runs, so a caller can only ever narrow within their own organization.
    --
    -- Deliberately a real column rather than a value read out of the JSONB. The FHIR
    -- body already spells facility three different ways (serviceProvider on Encounter,
    -- managingOrganization on Location, a plain organization reference elsewhere), and
    -- an access-control predicate must not depend on getting that spelling right per
    -- resource type. It is also NOT the same thing as Encounter.serviceProvider: that
    -- field is clinical attribution (where care happened), this column is authorization
    -- (who may read the row). They agree for Encounters; only this column gates access.
    --
    -- Nullable with no default, which makes this a catalog-only change: existing rows
    -- are not rewritten and read back NULL. Verified against postgres:16-alpine
    -- (16.14), the image this deploys on, using a 50k-row (21MB) copy of this table:
    -- relfilenode 16385 before and after, 2.438ms, atthasmissing false.
    --
    -- NULL is unreachable, not permissive. Scoped reads compare organization_id = $scope,
    -- and NULL is never equal to anything in SQL, so an unstamped row is invisible to
    -- every organization rather than visible to all of them. A null scope must never be
    -- translated into "IS NULL" — see the guard in store.js, which throws first.
    ALTER TABLE fhir_resources ADD COLUMN IF NOT EXISTS organization_id text;

    -- Supports the scoped read predicate (resource_type, organization_id). Built in
    -- 58ms on the same 50k-row copy.
    CREATE INDEX IF NOT EXISTS fhir_resources_org_idx
      ON fhir_resources (resource_type, organization_id);

    -- Append-only audit trail. auditService.js already writes AuditEvent resources
    -- into fhir_resources; this table additionally captures raw HTTP-level access,
    -- which is what HIPAA's audit-control requirement actually asks for (who touched
    -- what, when, from where) independent of whether the app layer remembered to log it.
    CREATE TABLE IF NOT EXISTS access_log (
      id           bigserial PRIMARY KEY,
      occurred_at  timestamptz NOT NULL DEFAULT now(),
      method       text NOT NULL,
      path         text NOT NULL,
      status       integer NOT NULL,
      remote_addr  text,
      user_ref     text
    );
    -- Real, provisioned accounts. Self-signup is intentionally not supported —
    -- administrators create doctor/nurse accounts; the very first administrator is
    -- created by create-admin.js directly on the server (see README/DEPLOYMENT).
    CREATE TABLE IF NOT EXISTS users (
      id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      email                  text UNIQUE NOT NULL,
      name                   text NOT NULL,
      password_hash          text NOT NULL,
      role                   text NOT NULL CHECK (role IN ('administrator', 'doctor', 'nurse', 'technician')),
      department             text,
      organization           text,
      active                 boolean NOT NULL DEFAULT true,
      force_password_change  boolean NOT NULL DEFAULT false,
      created_at             timestamptz NOT NULL DEFAULT now()
    );

    -- One-time email codes for login and idle-timeout re-auth. Codes are stored
    -- hashed (never plaintext) so a database read alone can't be used to sign in.
    CREATE TABLE IF NOT EXISTS login_challenges (
      id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      code_hash    text NOT NULL,
      purpose      text NOT NULL CHECK (purpose IN ('login', 'reauth', 'reset')),
      attempts     integer NOT NULL DEFAULT 0,
      consumed     boolean NOT NULL DEFAULT false,
      expires_at   timestamptz NOT NULL,
      created_at   timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS login_challenges_user_idx ON login_challenges (user_id);

    -- Which Organization resource an administrator has claimed as their facility.
    --
    -- Deliberately its own table rather than a users.organization_id column. Populating
    -- a column would mean writing rows that already exist, which is out of scope until
    -- backups are verified. This table only ever gets new rows inserted into it and
    -- never reads or writes a users row.
    --
    -- It runs strictly parallel to the free-text users.organization string. Nothing
    -- here writes back to that string or tries to keep the two in sync: reconciling
    -- them is a later job, and doing it implicitly would be exactly the silent
    -- facility-merge this design exists to avoid.
    --
    -- This is acknowledged debt, and the fold-in path is known: once backups are
    -- verified and existing rows can be written, this becomes users.organization_id.
    --
    -- One claim per administrator (user_id is the primary key). Two administrators at
    -- the same facility get one row each pointing at the same organization_id, which
    -- is the correct shape: the claim belongs to the person, not the facility.
    CREATE TABLE IF NOT EXISTS organization_admins (
      user_id          uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      organization_id  text NOT NULL,
      created_at       timestamptz NOT NULL DEFAULT now()
    );

    -- Migrating an already-deployed users table: add the department column and widen
    -- the role constraint to include 'technician'. Safe to run repeatedly.
    ALTER TABLE users ADD COLUMN IF NOT EXISTS department text;
    ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
    ALTER TABLE users ADD CONSTRAINT users_role_check
      CHECK (role IN ('administrator', 'doctor', 'nurse', 'technician'));

    -- Which Location (department or ward) a staff account belongs to.
    --
    -- Nullable with no default, which makes this a catalog-only change: existing rows
    -- are not rewritten and simply read back NULL. Verified against postgres:16-alpine
    -- (16.14), the image this deploys on, using a 50k-row copy of this table:
    -- relfilenode unchanged before and after, 2.7ms, atthasmissing false.
    --
    -- Runs in parallel with the older free-text users.department. Accounts created from
    -- here on set location_id and leave department NULL; accounts that predate this keep
    -- their department string and leave location_id NULL. Nothing backfills either
    -- direction. Readers must therefore apply the precedence explicitly rather than
    -- picking one column: location_id first, falling back to department. See
    -- AdminUsers.jsx for the display side of that.
    ALTER TABLE users ADD COLUMN IF NOT EXISTS location_id text;

    -- Every account belongs to a hospital/clinic/healthcare center. Administrators
    -- state theirs at account creation; doctors/nurses/technicians inherit it from
    -- the administrator who provisions them (see server/index.js POST /auth/admin/users).
    ALTER TABLE users ADD COLUMN IF NOT EXISTS organization text;

    -- Which Organization resource this account belongs to, as a resolved id rather than
    -- the free-text organization string above.
    --
    -- This is the fold-in the organization_admins comment anticipated: that table exists
    -- because populating a users column meant writing existing rows, which was out of
    -- scope until backups were verified. They are verified now. organization_admins is
    -- deliberately NOT dropped here — collapsing it is the same class of debt as the
    -- free-text columns and does not ride along with a data migration.
    --
    -- Bookkeeping only. It is NOT part of the access-control path: PHI scope resolves
    -- location_id -> Location -> managingOrganization, and that chain is untouched by
    -- this work. Do not "simplify" the scope resolution to read this column without
    -- redoing the end-to-end enforcement tests that cover the existing one.
    ALTER TABLE users ADD COLUMN IF NOT EXISTS organization_id text;

    -- Records that a Practitioner resource exists for this account.
    --
    -- Its value is always the same as users.id, by design — see buildPractitionerResource
    -- in src/fhir/mappers.js, which reuses the account id so the Practitioner/<user.id>
    -- references that auditService.js and buildProvenanceResource have always emitted
    -- resolve to a real resource. So the column stores no new *identifier*; what it
    -- stores is the fact that the resource was created, which is not derivable from the
    -- users row alone and otherwise requires a cross-table lookup into fhir_resources.
    --
    -- DRIFT PATH, stated because a denormalized marker always has one: nothing deletes
    -- Practitioner resources today, so the column cannot currently go stale. That is a
    -- property of the current feature set, not a guarantee. Whenever a delete path
    -- appears — an admin removing a departed clinician from the directory, a
    -- de-provisioning flow, or an external-system sync that reconciles by deleting rows
    -- it no longer sees — it must clear this column in the same operation, or the column
    -- will claim a resource that no longer exists.
    ALTER TABLE users ADD COLUMN IF NOT EXISTS practitioner_id text;

    -- force_password_change was originally created as a text column and never
    -- actually used. Convert it to a real boolean, defaulting existing (unset) rows
    -- to false — nobody currently deployed was ever put through a forced-change
    -- flow, so false is correct for all of them.
    DO $$
    BEGIN
      IF (SELECT data_type FROM information_schema.columns
          WHERE table_name = 'users' AND column_name = 'force_password_change') = 'text' THEN
        ALTER TABLE users ALTER COLUMN force_password_change DROP DEFAULT;
        ALTER TABLE users ALTER COLUMN force_password_change TYPE boolean
          USING (force_password_change IS NOT NULL AND force_password_change != '');
        UPDATE users SET force_password_change = false WHERE force_password_change IS NULL;
        ALTER TABLE users ALTER COLUMN force_password_change SET NOT NULL;
        ALTER TABLE users ALTER COLUMN force_password_change SET DEFAULT false;
      END IF;
    END $$;

    -- Widen an already-deployed login_challenges table to allow the 'reset' purpose
    -- (forgot-password flow). Safe to run repeatedly.
    ALTER TABLE login_challenges DROP CONSTRAINT IF EXISTS login_challenges_purpose_check;
    ALTER TABLE login_challenges ADD CONSTRAINT login_challenges_purpose_check
      CHECK (purpose IN ('login', 'reauth', 'reset'));
  `)
}

export async function logAccess({ method, path, status, remoteAddr, userRef }) {
  try {
    await pool.query(
      `INSERT INTO access_log (method, path, status, remote_addr, user_ref)
       VALUES ($1, $2, $3, $4, $5)`,
      [method, path, status, remoteAddr || null, userRef || null]
    )
  } catch (e) {
    // Never let audit logging take down a request.
    console.error('daoval-server: failed to write access_log row', e)
  }
}
