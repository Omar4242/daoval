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

// Same small FHIR-ish search surface as the demo backend supported — enough for this
// app's frontend (name/identifier/patient-reference lookups + date sort), not a
// general FHIR search implementation.
export async function searchResources(resourceType, params) {
  let results = await listResources(resourceType)

  if (params.name) {
    const term = params.name.toLowerCase()
    results = results.filter((r) => {
      const name = r.name?.[0]
      const text = name?.text || [name?.given?.join(' '), name?.family].filter(Boolean).join(' ')
      return (text || '').toLowerCase().includes(term)
    })
  }

  if (params.identifier) {
    const term = params.identifier.toLowerCase()
    results = results.filter((r) => (r.identifier || []).some((i) => (i.value || '').toLowerCase().includes(term)))
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
