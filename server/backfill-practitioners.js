// Creates one Practitioner resource per account, with Practitioner.id = users.id, and
// records that it exists in users.practitioner_id.
//
// Writes existing rows (the users.practitioner_id column). The Practitioner resources
// themselves are new rows, not edits to existing ones.
//
// Usage — dry run first, always. It is the default and writes nothing:
//
//   docker compose exec -T backend node server/backfill-practitioners.js
//   docker compose exec -T backend node server/backfill-practitioners.js --apply
//
// ---------------------------------------------------------------------------
// WHAT THIS RETROACTIVELY FIXES
//
// auditService.js and buildProvenanceResource have always written
// `Practitioner/${user.id}` into every AuditEvent and Provenance, and nothing has ever
// created a Practitioner resource — buildPractitionerResource exists in
// src/fhir/mappers.js but has no callers. So every one of those references has dangled
// since the audit trail was written.
//
// Reusing the account id as the resource id is what makes them resolve retroactively,
// including for records written long before any Practitioner existed. That is the entire
// reason for the id choice (see the comment above buildPractitionerResource), so this
// script proves it rather than asserting it: it reports how many distinct references in
// the existing audit trail resolve before and after.
//
// SHAPE DUPLICATION, deliberate and flagged:
// The canonical builder is buildPractitionerResource in src/fhir/mappers.js. This script
// cannot import it. The backend image is built with `COPY server ./server` (see
// server/Dockerfile) and contains no src/ directory at all, and mappers.js additionally
// imports ./codes, which is frontend-only. The shape below is therefore a restatement,
// and the two can drift.
//
// If Practitioner's shape changes in mappers.js, change it here too. The drift is
// bounded and detectable: both produce resourceType, id, identifier, active, name and
// telecom, and a mismatch shows up as directory records that differ depending on whether
// they were created by this backfill or by the app. Removing the duplication properly
// means extracting the directory builders into a module both the server image and the
// frontend can import, which is a build-layout change and not part of a data migration.
// ---------------------------------------------------------------------------

import { pool, migrate } from './db.js'
import { printGroupedPlan, applyInTransaction, run, parseArgs } from './backfill-support.js'

const { apply: APPLY } = parseArgs(process.argv.slice(2))

// Restatement of buildPractitionerResource (src/fhir/mappers.js) — see header.
function practitionerResource(user) {
  return {
    resourceType: 'Practitioner',
    id: user.id,
    identifier: [{ system: 'urn:daoval:user-id', value: user.id }],
    active: user.active !== false,
    // users.name is a single free-text field, so there is no reliable family/given split
    // to make. Guessing one from whitespace would mangle names that do not follow a
    // given-then-family order.
    name: [{ text: user.name }],
    telecom: user.email ? [{ system: 'email', value: user.email }] : [],
    meta: { versionId: '1', lastUpdated: new Date().toISOString() },
  }
}

// Every Practitioner reference the existing audit trail already points at.
async function referencedPractitionerIds() {
  const { rows } = await pool.query(
    `SELECT data FROM fhir_resources WHERE resource_type IN ('AuditEvent', 'Provenance')`
  )
  const ids = new Set()
  for (const r of rows) {
    for (const agent of r.data?.agent || []) {
      const ref = agent?.who?.reference
      if (typeof ref === 'string' && ref.startsWith('Practitioner/')) {
        const id = ref.slice('Practitioner/'.length).trim()
        if (id) ids.add(id)
      }
    }
  }
  return ids
}

async function existingPractitionerIds() {
  const { rows } = await pool.query(`SELECT id FROM fhir_resources WHERE resource_type = 'Practitioner'`)
  return new Set(rows.map((r) => r.id))
}

async function main() {
  await migrate()

  const { rows: users } = await pool.query(
    `SELECT id, email, name, role, active, organization_id, practitioner_id FROM users ORDER BY created_at`
  )
  const already = await existingPractitionerIds()
  const referenced = await referencedPractitionerIds()

  const resolvedBefore = [...referenced].filter((id) => already.has(id)).length

  console.log(`accounts                        : ${users.length}`)
  console.log(`Practitioner resources present  : ${already.size}`)
  console.log(`practitioner_id already set     : ${users.filter((u) => u.practitioner_id !== null).length}`)
  console.log('')
  console.log(`distinct Practitioner refs in audit trail : ${referenced.size}`)
  console.log(`  resolving BEFORE this backfill          : ${resolvedBefore}`)
  console.log('')

  const pending = users.filter((u) => u.practitioner_id === null)
  if (pending.length === 0) {
    console.log('Nothing to do.')
    return 0
  }

  // Two distinct actions, kept apart because they are not the same risk. Creating a
  // resource is additive. Marking the column when a resource is already there is
  // bookkeeping catching up with reality — and it must NOT overwrite the existing
  // resource, which may have been edited by an administrator through the directory UI.
  const decisions = []
  for (const u of pending) {
    decisions.push({
      group: already.has(u.id) ? `${u.role} (resource exists, mark only)` : `${u.role} (create + mark)`,
      assigned: u.id,
      // Constant label: the assigned value is the account's own id, so grouping on it
      // would print one line per account and report nothing.
      display: 'Practitioner/<users.id>',
      user: u,
      create: !already.has(u.id),
    })
  }

  printGroupedPlan(decisions, { apply: APPLY })

  // Accounts that no longer exist cannot be given a Practitioner by definition. Named so
  // a leftover dangling reference after the run is understood rather than investigated.
  const userIds = new Set(users.map((u) => u.id))
  const orphanRefs = [...referenced].filter((id) => !userIds.has(id) && !already.has(id))
  const wouldResolve = [...referenced].filter((id) => already.has(id) || userIds.has(id)).length

  console.log(`  refs that WOULD resolve after this backfill : ${wouldResolve} of ${referenced.size}`)
  if (orphanRefs.length) {
    console.log(`  refs that will still dangle                 : ${orphanRefs.length}`)
    console.log(`    (they name accounts that no longer exist — no Practitioner can be`)
    console.log(`     created for a user row that is gone; this is honest, not a failure)`)
  }
  console.log('')

  if (!APPLY) {
    console.log(`Would create ${decisions.filter((d) => d.create).length} Practitioner resource(s)`)
    console.log(`and mark ${decisions.length} account(s).`)
    console.log('Re-run with --apply to write.')
    return 0
  }

  const written = await applyInTransaction(pool, async (client) => {
    let n = 0
    for (const d of decisions) {
      if (d.create) {
        // ON CONFLICT DO NOTHING, never DO UPDATE: if a Practitioner appeared between
        // the read above and this write, the existing resource wins. This script's job
        // is to fill a gap, not to overwrite directory data an administrator may have
        // curated.
        await client.query(
          `INSERT INTO fhir_resources (resource_type, id, version_id, data, last_updated, organization_id)
           VALUES ('Practitioner', $1, 1, $2, now(), $3)
           ON CONFLICT (resource_type, id) DO NOTHING`,
          [d.user.id, practitionerResource(d.user), d.user.organization_id]
        )
      }
      const res = await client.query(
        `UPDATE users SET practitioner_id = $1 WHERE id = $2 AND practitioner_id IS NULL`,
        [d.user.id, d.user.id]
      )
      n += res.rowCount
    }
    return n
  })
  console.log(`Marked ${written} account(s).`)

  // Prove the id choice did what it exists to do, rather than asserting it.
  const afterExisting = await existingPractitionerIds()
  const resolvedAfter = [...referenced].filter((id) => afterExisting.has(id)).length
  console.log('')
  console.log(`Practitioner refs in audit trail : ${referenced.size}`)
  console.log(`  resolved before                : ${resolvedBefore}`)
  console.log(`  resolved after                 : ${resolvedAfter}`)
  console.log(`  still dangling                 : ${referenced.size - resolvedAfter}`)

  const { rows: unmarked } = await pool.query(
    `SELECT count(*)::int AS n FROM users WHERE practitioner_id IS NULL`
  )
  console.log(`Accounts without a Practitioner  : ${unmarked[0].n}`)
  return unmarked[0].n > 0 ? 1 : 0
}

run(main, pool)
