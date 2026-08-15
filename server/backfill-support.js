// Shared mechanics for the one-shot backfill scripts. Deliberately small: only the
// parts that are identical across all of them (argument parsing, the transactional
// apply, the exit convention) live here. Every rule about *what* a given backfill
// assigns stays in that backfill's own file, so an operator can read one script
// end to end and know what it will do without following imports.
//
// Conventions all backfills share:
//   - dry run is the default; --apply writes
//   - only rows that are currently unset are considered, so re-running is a no-op
//   - exit 0 when the job is complete, 1 when anything was left undone
//
// The exit code is load-bearing: a partial backfill must not look like a clean run to
// whatever is driving the deploy.

export function parseArgs(argv) {
  const apply = argv.includes('--apply')

  // --map "Some Organization Name=org-id" may be repeated. Split on the FIRST '=' only,
  // because facility names are free text and may well contain one.
  const map = new Map()
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] !== '--map') continue
    const raw = argv[i + 1]
    if (!raw) throw new Error('--map needs a value, e.g. --map "Cairo General Hospital=org-abc123"')
    const eq = raw.indexOf('=')
    if (eq === -1) throw new Error(`--map value must be "<organization string>=<organization id>", got: ${raw}`)
    const key = raw.slice(0, eq).trim()
    const value = raw.slice(eq + 1).trim()
    if (!key || !value) throw new Error(`--map value must have both sides non-empty, got: ${raw}`)
    map.set(key, value)
  }
  return { apply, map }
}

// Groups a set of decisions into a stable, countable report. Used identically by every
// backfill's dry run and apply output, so the two are directly comparable — an operator
// checks that what applied is what the dry run said would apply.
export function printGroupedPlan(decisions, { apply }) {
  const counts = new Map()
  for (const d of decisions) {
    const k = `${d.group} -> ${d.assigned ?? '(left alone)'}`
    counts.set(k, (counts.get(k) || 0) + 1)
  }
  console.log(apply ? 'APPLYING:' : 'DRY RUN — no rows will be written:')
  for (const [k, n] of [...counts.entries()].sort()) console.log(`  ${String(n).padStart(6)}  ${k}`)
  console.log('')
}

// One transaction for the whole backfill. A half-applied identity migration would leave
// some accounts linked and others not, with no way to tell afterwards which run did
// what — and for the Location link specifically, that is the difference between a
// clinician having access and not.
export async function applyInTransaction(pool, work) {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const written = await work(client)
    await client.query('COMMIT')
    return written
  } catch (e) {
    await client.query('ROLLBACK')
    throw e
  } finally {
    client.release()
  }
}

// Every backfill ends the same way, so the exit convention can't drift between them.
export function run(main, pool) {
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
}
