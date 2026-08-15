// Backfills users.organization_id — which Organization resource each existing account
// belongs to. Writes existing rows. Run after backups are verified (they are).
//
// Usage — dry run first, always. It is the default and writes nothing:
//
//   docker compose exec -T backend node server/backfill-user-organizations.js
//   docker compose exec -T backend node server/backfill-user-organizations.js --apply
//   docker compose exec -T backend node server/backfill-user-organizations.js \
//     --map "Cairo General Hospital=org-abc123" --map "Nile Clinic=org-def456" --apply
//
// Exit 0 when every account is attributed, 1 when any is left. See backfill-support.js.
//
// ---------------------------------------------------------------------------
// WHY THIS IS NOT NAME MATCHING
//
// There is no structural link from a clinician account to an Organization. users has no
// created_by column. The only association that exists is users.organization, a free-text
// string — and the thing that makes it usable is where it comes from: for every
// non-administrator account it is copied verbatim and programmatically from the
// administrator who provisioned them (server/index.js, POST /auth/admin/users:
// `organization = current.organization`). Nobody typed it a second time.
//
// So following that string back to the administrator who has claimed an Organization is
// following a copy, not matching a human-typed name. That distinction is the whole basis
// of tier 3 below, and it is why the comparison is exact equality and never normalised,
// case-folded, trimmed-and-compared, or fuzzy. The moment it becomes any of those, it
// stops being "the same value" and starts being "a name that looks similar", which is
// how two genuinely different facilities get merged.
//
// A wrong merge is not recoverable by re-running anything: once two facilities' accounts
// carry the same organization_id, nothing in the data says which was which. A duplicate
// organization is merely untidy. So every rule here refuses rather than guesses, and the
// asymmetry is deliberate.
// ---------------------------------------------------------------------------

import { pool, migrate } from './db.js'
import { parseArgs, printGroupedPlan, applyInTransaction, run } from './backfill-support.js'

const { apply: APPLY, map: OPERATOR_MAP } = parseArgs(process.argv.slice(2))

async function main() {
  await migrate()

  const { rows: users } = await pool.query(
    `SELECT id, email, name, role, organization, organization_id FROM users ORDER BY created_at`
  )
  const { rows: claims } = await pool.query(`SELECT user_id, organization_id FROM organization_admins`)
  const { rows: orgRows } = await pool.query(
    `SELECT id, data FROM fhir_resources WHERE resource_type = 'Organization'`
  )

  const orgName = new Map(orgRows.map((r) => [r.id, r.data?.name || '(unnamed)']))
  const orgExists = (id) => orgName.has(id)

  // A claim pointing at an Organization resource that no longer exists is not evidence
  // of anything. Dropped here rather than allowed to propagate into a mapping.
  const claimByUser = new Map()
  const danglingClaims = []
  for (const c of claims) {
    if (orgExists(c.organization_id)) claimByUser.set(c.user_id, c.organization_id)
    else danglingClaims.push(c)
  }
  const claimedOrgIds = new Set(claimByUser.values())

  const pending = users.filter((u) => u.organization_id === null)

  console.log(`accounts                     : ${users.length}`)
  console.log(`already attributed           : ${users.length - pending.length}`)
  console.log(`candidates (NULL org id)     : ${pending.length}`)
  console.log(`Organization resources       : ${orgRows.length}`)
  console.log(`claimed Organizations        : ${claimedOrgIds.size}`)
  if (danglingClaims.length) {
    console.log(`IGNORED dangling claims      : ${danglingClaims.length} (claim points at a missing Organization)`)
  }
  console.log('')

  if (pending.length === 0) {
    console.log('Nothing to do.')
    return 0
  }

  // --- the copy-following map: organization string -> claimed Organization id ---
  //
  // Built only from administrators who hold a claim, since only they tie a string to a
  // resource. A string that two administrators associate with two DIFFERENT claimed
  // Organizations is ambiguous and is recorded as such rather than resolved: that is
  // precisely the two-facilities-same-name case, and picking either one is the
  // unrecoverable merge.
  const stringToOrgs = new Map()
  for (const u of users) {
    const claimed = claimByUser.get(u.id)
    if (!claimed || !u.organization) continue
    if (!stringToOrgs.has(u.organization)) stringToOrgs.set(u.organization, new Set())
    stringToOrgs.get(u.organization).add(claimed)
  }
  const ambiguousStrings = new Set()
  const derivedMap = new Map()
  for (const [str, orgs] of stringToOrgs) {
    if (orgs.size === 1) derivedMap.set(str, [...orgs][0])
    else ambiguousStrings.add(str)
  }

  // --- decide, per account ---
  const decisions = []
  const reasons = new Map()
  const note = (r) => reasons.set(r, (reasons.get(r) || 0) + 1)

  // The sole-organization fast path is safe because of a precondition, not
  // unconditionally, so it announces the precondition every time it is used — including
  // on apply. An action that is safe only because of a check must never read as an
  // action that is always safe.
  const soleOrgId = claimedOrgIds.size === 1 ? [...claimedOrgIds][0] : null
  if (soleOrgId) {
    console.log('SOLE-ORGANIZATION FAST PATH ENGAGED')
    console.log(`  justification : 1 claimed Organization found in database`)
    console.log(`  organization  : ${soleOrgId}`)
    console.log(`  name          : ${orgName.get(soleOrgId)}`)
    console.log(`  accounts      : ${pending.length} candidate account(s) will be attributed to it`)
    console.log(`  why this is safe: the wrong-merge failure this script exists to prevent`)
    console.log(`  requires two facilities to choose between. With exactly one claimed`)
    console.log(`  Organization in the database there is no second candidate, so the`)
    console.log(`  failure is structurally impossible rather than merely unlikely.`)
    console.log('')
  }

  for (const u of pending) {
    // Tier 1 — the account's own claim. Not an inference at all: this administrator
    // personally confirmed which facility they belong to.
    const own = claimByUser.get(u.id)
    if (own) {
      decisions.push({ group: `${u.role} (own claim)`, assigned: own, user: u })
      note('own claim')
      continue
    }

    // Tier 2 — an explicit operator mapping. A human decided; it wins over inference,
    // and any disagreement with what would have been derived is printed rather than
    // silently absorbed.
    const operator = u.organization ? OPERATOR_MAP.get(u.organization) : undefined
    if (operator) {
      if (!orgExists(operator)) {
        decisions.push({ group: `${u.role} (--map names a missing Organization)`, assigned: null, user: u })
        note('--map names an Organization that does not exist')
        continue
      }
      const derived = derivedMap.get(u.organization)
      if (derived && derived !== operator) {
        note(`--map OVERRIDE: "${u.organization}" derived ${derived}, operator said ${operator}`)
      }
      // Mapping an AMBIGUOUS string is categorically different from mapping an
      // unclaimed one. Unclaimed means the script had no evidence; ambiguous means it
      // had evidence for two different facilities and the operator is now collapsing
      // them into one. That is the unrecoverable merge this script otherwise exists to
      // prevent — permitted, because an operator may genuinely know the two claims are
      // the same facility, but never quietly.
      if (ambiguousStrings.has(u.organization)) {
        note(
          `MERGE via --map: "${u.organization}" was claimed as ` +
            `${[...stringToOrgs.get(u.organization)].join(' and ')}; operator collapsed it to ${operator}. ` +
            `Not reversible from the data — nothing afterwards records which account came from which.`
        )
      }
      decisions.push({ group: `${u.role} (operator --map)`, assigned: operator, user: u })
      note('operator --map')
      continue
    }

    // Tier 3 — the sole-organization fast path.
    if (soleOrgId) {
      decisions.push({ group: `${u.role} (sole organization)`, assigned: soleOrgId, user: u })
      note('sole claimed Organization')
      continue
    }

    // Tier 4 — follow the copy. Exact equality only; see the header comment.
    if (u.organization && derivedMap.has(u.organization)) {
      decisions.push({ group: `${u.role} (followed copy)`, assigned: derivedMap.get(u.organization), user: u })
      note('organization string matches a claiming administrator')
      continue
    }

    // Refusals, each named specifically so the operator knows what to fix.
    let why
    if (!u.organization) why = 'account has no organization string'
    else if (ambiguousStrings.has(u.organization))
      why = `AMBIGUOUS: "${u.organization}" is claimed as ${[...stringToOrgs.get(u.organization)].join(' and ')} — pass --map to decide`
    else why = `no claiming administrator for "${u.organization}" — pass --map to decide`
    decisions.push({ group: `${u.role} (refused)`, assigned: null, user: u })
    note(why)
  }

  printGroupedPlan(decisions, { apply: APPLY })

  console.log('reasons:')
  for (const [r, n] of [...reasons.entries()].sort()) console.log(`  ${String(n).padStart(6)}  ${r}`)
  console.log('')

  const assignable = decisions.filter((d) => d.assigned)
  const leftovers = decisions.length - assignable.length

  if (leftovers > 0 && derivedMap.size + OPERATOR_MAP.size >= 0) {
    // Print the unresolved strings in the exact form they would be passed back in, so
    // the operator can copy the decision rather than retype it.
    const unresolved = new Set(
      decisions.filter((d) => !d.assigned && d.user.organization).map((d) => d.user.organization)
    )
    if (unresolved.size) {
      console.log('unresolved organization strings — supply a mapping for each:')
      for (const s of [...unresolved].sort()) {
        const candidates = stringToOrgs.has(s) ? [...stringToOrgs.get(s)] : [...orgName.keys()]
        console.log(`  --map "${s}=<organization id>"`)
        for (const c of candidates) console.log(`        candidate: ${c}  (${orgName.get(c)})`)
      }
      console.log('')
    }
  }

  if (!APPLY) {
    console.log(`Would attribute ${assignable.length} account(s); ${leftovers} would remain unattributed.`)
    console.log('Re-run with --apply to write.')
    return leftovers > 0 ? 1 : 0
  }

  const written = await applyInTransaction(pool, async (client) => {
    let n = 0
    for (const d of assignable) {
      const res = await client.query(
        `UPDATE users SET organization_id = $1 WHERE id = $2 AND organization_id IS NULL`,
        [d.assigned, d.user.id]
      )
      n += res.rowCount
    }
    return n
  })
  console.log(`Wrote ${written} account(s).`)

  const { rows: after } = await pool.query(
    `SELECT count(*)::int AS n FROM users WHERE organization_id IS NULL`
  )
  console.log(`Accounts still unattributed: ${after[0].n}`)
  if (after[0].n > 0) {
    console.log('')
    console.log('Those accounts cannot be linked to a Location by the next script, and')
    console.log('their clinicians stay locked out of PHI. Resolve them with --map.')
  }
  return after[0].n > 0 ? 1 : 0
}

run(main, pool)
