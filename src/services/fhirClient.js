// Thin client for a HAPI FHIR (R4) server, e.g. deployed on AWS behind an ALB.
// See README.md for how to point this at your AWS deployment.

const BASE_URL = import.meta.env.VITE_FHIR_BASE_URL || 'http://localhost:8080/fhir'
const AUTH_TOKEN = import.meta.env.VITE_FHIR_AUTH_TOKEN || ''
const TENANT_ID = import.meta.env.VITE_TENANT_ID || 'default'

function headers(extra = {}) {
  const h = {
    'Content-Type': 'application/fhir+json',
    Accept: 'application/fhir+json',
    'X-Tenant-Id': TENANT_ID,
    ...extra,
  }
  if (AUTH_TOKEN) h.Authorization = `Bearer ${AUTH_TOKEN}`
  return h
}

async function handle(res) {
  if (!res.ok) {
    let body = null
    try {
      body = await res.json()
    } catch {
      /* non-json error body */
    }
    const err = new Error(`FHIR ${res.status} ${res.statusText}`)
    err.status = res.status
    err.operationOutcome = body
    throw err
  }
  if (res.status === 204) return null
  return res.json()
}

/** True if the FHIR server responds to its capability statement. Used for online/offline detection. */
export async function ping(timeoutMs = 3000) {
  const controller = new AbortController()
  const t = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(`${BASE_URL}/metadata`, {
      headers: headers(),
      signal: controller.signal,
    })
    return res.ok
  } catch {
    return false
  } finally {
    clearTimeout(t)
  }
}

export async function createResource(resourceType, resource) {
  const res = await fetch(`${BASE_URL}/${resourceType}`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify(resource),
  })
  return handle(res)
}

export async function updateResource(resourceType, id, resource) {
  const res = await fetch(`${BASE_URL}/${resourceType}/${id}`, {
    method: 'PUT',
    headers: headers(),
    body: JSON.stringify(resource),
  })
  return handle(res)
}

export async function readResource(resourceType, id) {
  const res = await fetch(`${BASE_URL}/${resourceType}/${id}`, {
    headers: headers(),
  })
  return handle(res)
}

/** search: params is a plain object of FHIR search params, e.g. { name: 'Amir', _count: 20 } */
export async function searchResource(resourceType, params = {}) {
  const qs = new URLSearchParams(params).toString()
  const res = await fetch(`${BASE_URL}/${resourceType}?${qs}`, {
    headers: headers(),
  })
  const bundle = await handle(res)
  return (bundle?.entry || []).map((e) => e.resource)
}

/** Submit a batch/transaction Bundle in one round trip (used for multi-resource encounter save). */
export async function submitBundle(bundle) {
  const res = await fetch(`${BASE_URL}`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify(bundle),
  })
  return handle(res)
}

export const fhirBaseUrl = BASE_URL
