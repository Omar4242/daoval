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

    -- Migrating an already-deployed users table: add the department column and widen
    -- the role constraint to include 'technician'. Safe to run repeatedly.
    ALTER TABLE users ADD COLUMN IF NOT EXISTS department text;
    ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
    ALTER TABLE users ADD CONSTRAINT users_role_check
      CHECK (role IN ('administrator', 'doctor', 'nurse', 'technician'));

    -- Every account belongs to a hospital/clinic/healthcare center. Administrators
    -- state theirs at account creation; doctors/nurses/technicians inherit it from
    -- the administrator who provisions them (see server/index.js POST /auth/admin/users).
    ALTER TABLE users ADD COLUMN IF NOT EXISTS organization text;

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
