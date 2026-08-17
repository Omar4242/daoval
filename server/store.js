// Resource store backed by Postgres (see db.js). Same exported surface as the old
// JSON-file version (createResource, updateResource, readResource, listResources,
// searchResources, seedIfEmpty) but every function is now async because it's a real
// database round-trip. server/index.js awaits all of these.

import { randomUUID } from 'crypto'
import { pool, migrate } from './db.js'
import { isScopedResourceType } from './resourceTypes.js'

export async function load() {
  await migrate()
}

// ---------- tenancy scope ----------
//
// Every read below takes an organization scope as a required positional argument,
// separate from the params bag. That separation is the whole point, and it is worth
// being explicit about why, because the obvious implementation is wrong here.
//
// searchResources starts from every row of a type and *subtracts* using whichever
// params are present; a param nobody recognises simply doesn't narrow anything. If
// the organization scope were one more optional key in that bag, forgetting it — or
// resolving it to undefined — would return the unfiltered set. The permissive base
// case is not a bug that can be guarded, it is the shape of the function.
//
// So the unfiltered path is deleted rather than guarded. A caller supplies either a
// real organization id or SYSTEM_SCOPE, and anything else throws before a query is
// built. There is no argument value that means "no opinion": omitting the scope is a
// programming error and surfaces as a 500 on the first request from that call site,
// not as a silent full-table read that looks like it works.
//
// SYSTEM_SCOPE is deliberate, greppable, and internal-only — `grep -rn SYSTEM_SCOPE
// server/` lists every unscoped read in the codebase. It is a Symbol precisely so no
// string arriving from a request body, query param, or JWT claim can ever equal it.
export const SYSTEM_SCOPE = Symbol('SYSTEM_SCOPE')

// Throws unless the scope is usable. Note what is NOT here: no null branch, no
// default, no "unknown scope means everything". null and undefined fall through to
// the throw, which is the behaviour the route layer depends on.
//
// LOAD-BEARING: a null scope must never be translated into `organization_id IS NULL`.
// That would turn "we could not work out who is asking" into a query that matches
// every unstamped row — the exact leak this function exists to prevent. Unstamped
// rows are unreachable, not public.
function assertScope(scope, callSite) {
  if (scope === SYSTEM_SCOPE) return
  if (typeof scope === 'string' && scope.trim() !== '') return
  throw new Error(
    `${callSite}: an organization scope is required. Pass an organization id, or ` +
      `SYSTEM_SCOPE for a deliberate server-internal read. Got ${
        scope === null ? 'null' : typeof scope
      }. This is a call-site bug, not a data problem — no rows were read.`
  )
}

// The SQL fragment applying the scope, plus the value to bind. Two cases produce no
// predicate, and they are different from each other:
//
//   - SYSTEM_SCOPE: the caller has deliberately asked for an unscoped read.
//   - a directory resource type: not PHI, shared across organizations by design (see
//     resourceTypes.js). The scope is still asserted, so if a type ever moves out of
//     the directory set, every call site is already passing a real one.
//
// Neither case is reachable by omission — assertScope has already run.
function scopePredicate(resourceType, scope, nextParamIndex) {
  if (scope === SYSTEM_SCOPE) return { sql: '', values: [] }
  if (!isScopedResourceType(resourceType)) return { sql: '', values: [] }
  return { sql: ` AND organization_id = $${nextParamIndex}`, values: [scope.trim()] }
}

// The organization_id a write should record. SYSTEM_SCOPE writes NULL, which is
// unreachable by every scoped reader rather than visible to all of them — see the
// column comment in db.js.
function scopeColumnValue(scope, callSite) {
  assertScope(scope, callSite)
  return scope === SYSTEM_SCOPE ? null : scope.trim()
}

export async function createResource(resourceType, resource, scope, forcedId) {
  const id = forcedId || resource.id || randomUUID()
  const organizationId = scopeColumnValue(scope, `createResource(${resourceType})`)
  const stamped = {
    ...resource,
    id,
    resourceType,
    meta: { ...(resource.meta || {}), versionId: '1', lastUpdated: new Date().toISOString() },
  }
  await pool.query(
    `INSERT INTO fhir_resources (resource_type, id, version_id, data, last_updated, organization_id)
     VALUES ($1, $2, 1, $3, now(), $4)
     ON CONFLICT (resource_type, id)
     DO UPDATE SET version_id = fhir_resources.version_id + 1,
                    data = $3,
                    last_updated = now()`,
    [resourceType, id, stamped, organizationId]
  )
  return stamped
}

// organization_id is absent from both DO UPDATE SET lists here and in createResource,
// and that omission is the point rather than an oversight.
//
// The column is written once, when the row is first inserted, and never rewritten. A
// row therefore cannot be moved between organizations by writing to it — not by an
// amend, not by an upsert against an existing id, not by a request that supplies a
// different organization than the one that created the row. Re-attributing a record to
// a different facility is a correction, and a correction should be a deliberate,
// visible operation rather than a side effect of saving an edit.
//
// This is the same discipline the facility stamp in index.js prescribes for
// serviceProvider, arrived at independently for the authorization column: preserve on
// update, stamp only when absent. It is deliberately not implemented by reading the
// row and deciding in Node — the SQL simply has no way to express the overwrite.
//
// Note what this does NOT do: it does not check that the row being updated already
// belongs to the caller's organization. A cross-organization write to a guessed id
// remains possible exactly as it was before this branch, and closing it is its own
// change. What is guaranteed here is narrower and worth stating precisely — such a
// write cannot silently re-tenant the row it lands on.
export async function updateResource(resourceType, id, resource, scope) {
  const organizationId = scopeColumnValue(scope, `updateResource(${resourceType}/${id})`)
  const existing = await pool.query(
    `SELECT version_id FROM fhir_resources WHERE resource_type = $1 AND id = $2`,
    [resourceType, id]
  )
  const prevVersion = existing.rows[0]?.version_id || 0
  const stamped = {
    ...resource,
    id,
    resourceType,
    meta: { ...(resource.meta || {}), versionId: String(prevVersion + 1), lastUpdated: new Date().toISOString() },
  }
  await pool.query(
    `INSERT INTO fhir_resources (resource_type, id, version_id, data, last_updated, organization_id)
     VALUES ($1, $2, $3, $4, now(), $5)
     ON CONFLICT (resource_type, id)
     DO UPDATE SET version_id = $3, data = $4, last_updated = now()`,
    [resourceType, id, prevVersion + 1, stamped, organizationId]
  )
  return stamped
}

// Returns null both for "no such row" and for "that row belongs to another
// organization" — the caller cannot tell the two apart, which is why the route layer
// answers 404 rather than 403 for a cross-organization id. A 403 would confirm the
// resource exists somewhere, which is itself a disclosure across a tenancy boundary.
export async function readResource(resourceType, id, scope) {
  assertScope(scope, `readResource(${resourceType}/${id})`)
  const { sql, values } = scopePredicate(resourceType, scope, 3)
  const res = await pool.query(
    `SELECT data FROM fhir_resources WHERE resource_type = $1 AND id = $2${sql}`,
    [resourceType, id, ...values]
  )
  return res.rows[0]?.data || null
}

export async function listResources(resourceType, scope) {
  assertScope(scope, `listResources(${resourceType})`)
  const { sql, values } = scopePredicate(resourceType, scope, 2)
  const res = await pool.query(
    `SELECT data FROM fhir_resources WHERE resource_type = $1${sql}`,
    [resourceType, ...values]
  )
  return res.rows.map((r) => r.data)
}

// FHIR R4 spells `name` two different ways depending on the resource. Patient and
// Practitioner use HumanName[]; Organization and Location use a plain string.
//
// This used to read r.name[0].text unconditionally. Against a string that yields the
// string's *first character*, whose .text/.given/.family are all undefined, so the
// filter evaluated false for every row: ?name= matched nothing at all for Organization
// and Location and returned an empty searchset rather than an error. An empty result
// that looks like "no matches" is the worst possible failure here, because it reads as
// a data problem rather than a code one.
//
// Both shapes are handled explicitly now, and anything else throws rather than quietly
// filtering to zero. The throw surfaces as a 500 naming the offending resource, which
// is the intended loud failure.
//
// Scope note: for the array shape this still reads only the first entry, exactly as
// before. Matching across every historical name a person has (maiden, previous) would
// be a real change to clinical search behaviour, and that is a separate decision rather
// than a rider on a shape fix.
function nameText(resource) {
  const name = resource?.name
  if (name == null) return ''
  // Checked before any indexing: indexing into a string is precisely the bug above.
  if (typeof name === 'string') return name
  if (Array.isArray(name)) {
    const first = name[0]
    if (first == null) return ''
    if (typeof first === 'string') return first
    if (typeof first === 'object') {
      return first.text || [first.given?.join(' '), first.family].filter(Boolean).join(' ')
    }
  }
  throw new Error(
    `searchResources: unsupported name shape on ${resource?.resourceType}/${resource?.id}: ` +
      `expected a string or HumanName[], got ` +
      `${Array.isArray(name) ? `array of ${typeof name[0]}` : typeof name}`
  )
}

// Same small FHIR-ish search surface as the demo backend supported — enough for this
// app's frontend (name/identifier/organization/patient-reference lookups + date sort),
// not a general FHIR search implementation.
//
// The scope is a separate argument sitting *before* params on purpose. Everything
// below narrows an already-scoped set: the filtering here runs in Node, over rows
// Postgres has already restricted to one organization, so no param — recognised,
// unrecognised, or absent — can widen the result past the tenancy boundary. The
// permissive "unknown param matches everything" behaviour survives, but "everything"
// now means everything in the caller's own organization.
export async function searchResources(resourceType, scope, params) {
  let results = await listResources(resourceType, scope)

  if (params.name) {
    const term = params.name.toLowerCase()
    results = results.filter((r) => nameText(r).toLowerCase().includes(term))
  }

  if (params.identifier) {
    const term = params.identifier.toLowerCase()
    results = results.filter((r) => (r.identifier || []).some((i) => (i.value || '').toLowerCase().includes(term)))
  }

  // Which organization a resource belongs to is spelled differently per resource type:
  // Location uses managingOrganization, Encounter uses serviceProvider, and the generic
  // spelling is a plain organization reference. All three are matched so callers don't
  // have to know which one applies to the type they're querying.
  //
  // Accepts either a bare id or a full 'Organization/<id>' reference, since both forms
  // turn up in practice. (params.patient below is bare-id only, kept as-is rather than
  // changed under this commit.)
  if (params.organization) {
    const ref = params.organization.startsWith('Organization/')
      ? params.organization
      : `Organization/${params.organization}`
    results = results.filter(
      (r) =>
        r.managingOrganization?.reference === ref ||
        r.serviceProvider?.reference === ref ||
        r.organization?.reference === ref
    )
  }

  if (params.patient) {
    results = results.filter((r) => r.subject?.reference === `Patient/${params.patient}` || r.patient?.reference === `Patient/${params.patient}`)
  }

  if (params._sort === '-date') {
    results = results.slice().sort((a, b) => {
      const da = new Date(a.period?.start || a.recorded || a.meta?.lastUpdated || 0).getTime()
      const db_ = new Date(b.period?.start || b.recorded || b.meta?.lastUpdated || 0).getTime()
      return db_ - da
    })
  }

  const count = Number(params._count) || undefined
  if (count) results = results.slice(0, count)

  return results
}

// Runs at boot, before any request exists, so there is no caller organization to scope
// to — hence SYSTEM_SCOPE. The seeds are created with organization_id NULL and are
// therefore invisible to every organization once scoped reads are enforced. That is
// accepted rather than worked around: these are demo rows, and giving the seed path
// its own way to invent an organization would be a second, untested code path for
// stamping tenancy. A real deployment gets its patients from RegisterPatient, not here.
export async function seedIfEmpty() {
  const existing = await listResources('Patient', SYSTEM_SCOPE)
  if (existing.length > 0) return
  const p1 = await createResource('Patient', {
    name: [{ text: 'Mona Adel Ibrahim', use: 'official' }],
    identifier: [{ system: 'urn:daoval:national-id', value: '29001011234567' }],
    birthDate: '1990-01-01',
    gender: 'female',
    telecom: [{ system: 'phone', value: '+20 10 1234 5678', use: 'mobile' }],
    address: [{ text: 'Giza, Egypt' }],
    communication: [{ language: { coding: [{ system: 'urn:ietf:bcp:47', code: 'ar' }] } }],
  }, SYSTEM_SCOPE)
  const p2 = await createResource('Patient', {
    name: [{ text: 'Karim Youssef Fathy', use: 'official' }],
    identifier: [{ system: 'urn:daoval:national-id', value: '28805152233445' }],
    birthDate: '1988-05-15',
    gender: 'male',
    telecom: [{ system: 'phone', value: '+20 11 9876 5432', use: 'mobile' }],
    address: [{ text: 'Cairo, Egypt' }],
  }, SYSTEM_SCOPE)
  console.log(`daoval-server: seeded demo patients ${p1.id}, ${p2.id}`)
}
