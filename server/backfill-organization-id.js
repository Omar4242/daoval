// One-shot backfill of fhir_resources.organization_id onto rows that predate the
// column. This is the only part of the org-scoping work that writes existing rows.
//
// Run it BEFORE deploying the commit that enforces scoped reads. Enforcement makes an
// unstamped row invisible to every organization, so the order matters: stamp first,
// verify, then enforce. Doing it the other way round takes existing patient data dark
// between the two deploys.
//
// Usage — dry run first, always. It is the default and it writes nothing:
//
//   docker compose exec -T backend node server/backfill-organization-id.js
//   docker compose exec -T backend node server/backfill-organization-id.js --apply
//
// Exit codes: 0 when every row ended up stamped, 1 when any row could not be
// attributed. Non-zero on leftovers is deliberate — a partial backfill must not look
// like a clean run to whatever is driving the deploy.
//
// ---------------------------------------------------------------------------
// A NOTE ON WHY THIS IS MORE CAREFUL THAN THE CURRENT DATABASE JUSTIFIES
//
// At the time of writing the live database holds two Patient rows and nothing else.
// Every rule below would be satisfied by a script that simply wrote one organization
// onto everything, and it would look correct.
//
// It is written for the database this will actually meet: thousands of resources,
// several organizations, clinical rows whose only link to a facility is the encounter
// they belong to, and rows with no derivable owner at all. Those cases do not exist
// yet, so they cannot be tested against production — which is exactly why the logic
// must be conservative rather than convenient. The rule throughout: derive an
// organization from evidence in the data, never guess, and leave a row alone when
// there is no evidence.
// ---------------------------------------------------------------------------

import { pool, migrate } from './db.js'

const APPLY = process.argv.includes('--apply')

// Reads a well-formed 'Organization/<id>' reference and nothing else. A reference of
// the wrong type, or an empty id, is treated as no evidence rather than coerced —
// mis-attributing a row to the wrong facility is worse than leaving it unattributed,
// because an unattributed row is merely invisible while a mis-attributed one is
// visible to people who should not see it.
function organizationIdFromReference(ref) {
  if (typeof ref !== 'string' || !ref.startsWith('Organization/')) return null
  const id = ref.slice('Organization/'.length).trim()
  return id === '' ? null : id
}

// Tier 1: the row states its own owner.
//
// An Organization owns itself — that is not a convention invented here, it is the only
// answer that keeps the column meaningful for the resource that defines the facility.
function directOrganizationId(row) {
  const { resource_type: type, id, data } = row
  if (type === 'Organization') return id
  return (
    organizationIdFromReference(data?.managingOrganization?.reference) ||
    organizationIdFromReference(data?.serviceProvider?.reference) ||
    organizationIdFromReference(data?.organization?.reference) ||
    null
  )
}

// Tier 2: the row belongs to an encounter, and the encounter states its owner.
//
// This is the tier that matters at real scale and is invisible at current scale. An
// Observation, Condition, MedicationRequest or DocumentReference carries no facility of
// its own — it inherits from the Encounter it was recorded in. Without this, every
// clinical row in a multi-organization database would fall through to tier 3 and be
// left unstamped, which is to say invisible.
function encounterReferenceOf(data) {
  const ref =
    data?.encounter?.reference ||
    data?.context?.reference ||
    (Array.isArray(data?.encounter) ? data.encounter[0]?.reference : null)
  if (typeof ref !== 'string' || !ref.startsWith('Encounter/')) return null
  const id = ref.slice('Encounter/'.length).trim()
  return id === '' ? null : id
}

async function main() {
  await migrate()

  const { rows: allRows } = await pool.query(
    `SELECT resource_type, id, data, organization_id FROM fhir_resources ORDER BY resource_type, id`
  )
  const unstamped = allRows.filter((r) => r.organization_id === null)

  // Idempotent by construction: only NULL rows are considered, and the UPDATE below
  // repeats that condition. Re-running after a successful apply is a no-op, and a row
  // already stamped is never re-tenanted — consistent with the store, where the column
  // is written once and preserved on every subsequent write.
  console.log(`rows in fhir_resources : ${allRows.length}`)
  console.log(`already stamped        : ${allRows.length - unstamped.length}`)
  console.log(`candidates (NULL org)  : ${unstamped.length}`)

  const organizations = allRows.filter((r) => r.resource_type === 'Organization')
  console.log(`Organization resources : ${organizations.length}`)
  console.log('')

  if (unstamped.length === 0) {
    console.log('Nothing to do.')
    return 0
  }

  const assignment = new Map() // "type/id" -> organization id
  const key = (r) => `${r.resource_type}/${r.id}`

  // --- tier 1 ---
  for (const row of unstamped) {
    const org = directOrganizationId(row)
    if (org) assignment.set(key(row), org)
  }

  // --- tier 2 ---
  // Resolved against every Encounter, not only the ones stamped in this run, so a row
  // whose Encounter was already stamped by an earlier partial run still resolves.
  const encounterOrg = new Map()
  for (const row of allRows) {
    if (row.resource_type !== 'Encounter') continue
    const org = row.organization_id || assignment.get(key(row)) || directOrganizationId(row)
    if (org) encounterOrg.set(row.id, org)
  }
  for (const row of unstamped) {
    if (assignment.has(key(row))) continue
    const encounterId = encounterReferenceOf(row.data)
    if (!encounterId) continue
    const org = encounterOrg.get(encounterId)
    if (org) assignment.set(key(row), org)
  }

  // --- tier 3: the sole-organization fallback ---
  //
  // Only when the deployment is unambiguously single-tenant. One Organization means
  // there is exactly one answer any row could have, so assigning it is reading the
  // data rather than guessing about it.
  //
  // Two or more Organizations and this stops. There is no tiebreak worth having:
  // the free-text users.organization string is not a key and never was, row creation
  // order says nothing, and "most common" would quietly hand one hospital's records to
  // another. A human decides, or the rows stay unattributed.
  const remaining = unstamped.filter((r) => !assignment.has(key(r)))
  if (remaining.length > 0) {
    if (organizations.length === 1) {
      const soleOrg = organizations[0].id
      console.log(`sole-organization fallback: ${remaining.length} row(s) -> ${soleOrg}`)
      console.log(`  (single-tenant deployment, so this is the only answer available)`)
      for (const row of remaining) assignment.set(key(row), soleOrg)
    } else if (organizations.length === 0) {
      console.log(`NO fallback available: there are no Organization resources yet.`)
      console.log(`  ${remaining.length} row(s) have no derivable owner and will be LEFT ALONE.`)
    } else {
      console.log(`NO fallback applied: ${organizations.length} Organizations exist, so there is`)
      console.log(`  no unambiguous owner. ${remaining.length} row(s) will be LEFT ALONE.`)
      console.log(`  Attribute them deliberately rather than letting this script guess.`)
    }
    console.log('')
  }

  // --- report ---
  const byTypeOrg = new Map()
  for (const row of unstamped) {
    const org = assignment.get(key(row)) || '(left unstamped)'
    const k = `${row.resource_type} -> ${org}`
    byTypeOrg.set(k, (byTypeOrg.get(k) || 0) + 1)
  }
  console.log(APPLY ? 'APPLYING:' : 'DRY RUN — no rows will be written:')
  for (const [k, n] of [...byTypeOrg.entries()].sort()) console.log(`  ${String(n).padStart(6)}  ${k}`)
  console.log('')

  const leftovers = unstamped.length - assignment.size
  if (!APPLY) {
    console.log(`Would stamp ${assignment.size} row(s); ${leftovers} would remain unstamped.`)
    console.log('Re-run with --apply to write.')
    return leftovers > 0 ? 1 : 0
  }

  // One transaction: a half-applied backfill would leave some records visible and
  // others dark with no way to tell which run did what.
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    let written = 0
    for (const [k, org] of assignment) {
      const idx = k.indexOf('/')
      const type = k.slice(0, idx)
      const id = k.slice(idx + 1)
      const res = await client.query(
        `UPDATE fhir_resources SET organization_id = $1
         WHERE resource_type = $2 AND id = $3 AND organization_id IS NULL`,
        [org, type, id]
      )
      written += res.rowCount
    }
    await client.query('COMMIT')
    console.log(`Wrote ${written} row(s).`)
  } catch (e) {
    await client.query('ROLLBACK')
    throw e
  } finally {
    client.release()
  }

  const { rows: after } = await pool.query(
    `SELECT count(*)::int AS n FROM fhir_resources WHERE organization_id IS NULL`
  )
  console.log(`Rows still unstamped after apply: ${after[0].n}`)
  if (after[0].n > 0) {
    console.log('')
    console.log('WARNING: those rows are invisible to every organization once scoped')
    console.log('reads are enforced. That is fail-closed behaving correctly, not a bug,')
    console.log('but do not deploy enforcement until you have decided they should stay')
    console.log('unreachable.')
  }
  return after[0].n > 0 ? 1 : 0
}

main()
  .then(async (code) => {
    await pool.end()
    process.exit(code)
  })
  .catch(async (e) => {
    console.error(e)
    await pool.end()
    process.exit(1)
  })
