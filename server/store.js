// Resource store backed by Postgres (see db.js). Same exported surface as the old
// JSON-file version (createResource, updateResource, readResource, listResources,
// searchResources, seedIfEmpty) but every function is now async because it's a real
// database round-trip. server/index.js awaits all of these.

import { randomUUID } from 'crypto'
import { pool, migrate } from './db.js'

export async function load() {
  await migrate()
}

export async function createResource(resourceType, resource, forcedId) {
  const id = forcedId || resource.id || randomUUID()
  const stamped = {
    ...resource,
    id,
    resourceType,
    meta: { ...(resource.meta || {}), versionId: '1', lastUpdated: new Date().toISOString() },
  }
  await pool.query(
    `INSERT INTO fhir_resources (resource_type, id, version_id, data, last_updated)
     VALUES ($1, $2, 1, $3, now())
     ON CONFLICT (resource_type, id)
     DO UPDATE SET version_id = fhir_resources.version_id + 1,
                    data = $3,
                    last_updated = now()`,
    [resourceType, id, stamped]
  )
  return stamped
}

export async function updateResource(resourceType, id, resource) {
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
    `INSERT INTO fhir_resources (resource_type, id, version_id, data, last_updated)
     VALUES ($1, $2, $3, $4, now())
     ON CONFLICT (resource_type, id)
     DO UPDATE SET version_id = $3, data = $4, last_updated = now()`,
    [resourceType, id, prevVersion + 1, stamped]
  )
  return stamped
}

export async function readResource(resourceType, id) {
  const res = await pool.query(
    `SELECT data FROM fhir_resources WHERE resource_type = $1 AND id = $2`,
    [resourceType, id]
  )
  return res.rows[0]?.data || null
}

export async function listResources(resourceType) {
  const res = await pool.query(
    `SELECT data FROM fhir_resources WHERE resource_type = $1`,
    [resourceType]
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
export async function searchResources(resourceType, params) {
  let results = await listResources(resourceType)

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

export async function seedIfEmpty() {
  const existing = await listResources('Patient')
  if (existing.length > 0) return
  const p1 = await createResource('Patient', {
    name: [{ text: 'Mona Adel Ibrahim', use: 'official' }],
    identifier: [{ system: 'urn:daoval:national-id', value: '29001011234567' }],
    birthDate: '1990-01-01',
    gender: 'female',
    telecom: [{ system: 'phone', value: '+20 10 1234 5678', use: 'mobile' }],
    address: [{ text: 'Giza, Egypt' }],
    communication: [{ language: { coding: [{ system: 'urn:ietf:bcp:47', code: 'ar' }] } }],
  })
  const p2 = await createResource('Patient', {
    name: [{ text: 'Karim Youssef Fathy', use: 'official' }],
    identifier: [{ system: 'urn:daoval:national-id', value: '28805152233445' }],
    birthDate: '1988-05-15',
    gender: 'male',
    telecom: [{ system: 'phone', value: '+20 11 9876 5432', use: 'mobile' }],
    address: [{ text: 'Cairo, Egypt' }],
  })
  console.log(`daoval-server: seeded demo patients ${p1.id}, ${p2.id}`)
}
