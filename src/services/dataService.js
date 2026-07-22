// Every screen in the app talks to *this* module, never to fhirClient or localStore
// directly. Writes land in local storage immediately (so the UI and autosave never
// block on network), and are mirrored to the AWS-hosted HAPI FHIR server in the
// background. Reads prefer the server when it's reachable (so a second device / the
// clinic's other machines see up-to-date data) and fall back to the local mirror when
// it isn't.

import * as fhir from './fhirClient'
import * as local from './localStore'
import { logAuditEvent } from './auditService'

const listeners = new Set()
let online = false

export function onSyncStatusChange(cb) {
  listeners.add(cb)
  return () => listeners.delete(cb)
}

function emitStatus() {
  const status = { online, pending: local.outboxCount() }
  listeners.forEach((cb) => cb(status))
}

export async function checkConnectivity() {
  online = await fhir.ping()
  emitStatus()
  return online
}

/**
 * Save a resource: write-through to local storage first, then attempt the server.
 * If the server write fails (offline, timeout, validation), the write is queued in
 * the outbox and retried by the sync worker — nothing is lost.
 */
export async function saveResource(resourceType, resource, { auditAction = 'write' } = {}) {
  const isNew = !resource.id
  const stamped = local.put(resourceType, resource)

  try {
    const ok = online || (await checkConnectivity())
    if (!ok) throw new Error('offline')

    const serverResult = isNew
      ? await fhir.createResource(resourceType, stripLocalMeta(stamped))
      : await fhir.updateResource(resourceType, stamped.id, stripLocalMeta(stamped))

    if (isNew) {
      local.replaceLocalId(resourceType, stamped.id, serverResult)
    } else {
      local.markSynced(resourceType, stamped.id)
    }
    logAuditEvent({ action: auditAction, resourceType, resourceId: serverResult.id, outcome: 'success' })
    emitStatus()
    return serverResult
  } catch (e) {
    local.enqueueOutbox({
      op: isNew ? 'create' : 'update',
      resourceType,
      localId: stamped.id,
      resource: stripLocalMeta(stamped),
    })
    logAuditEvent({ action: auditAction, resourceType, resourceId: stamped.id, outcome: 'queued-offline' })
    emitStatus()
    return stamped
  }
}

function stripLocalMeta(resource) {
  const { _localId, _synced, ...rest } = resource
  return rest
}

/**
 * Submit an entire encounter (Encounter + Observations + Condition + MedicationRequest
 * + AllergyIntolerance + Immunization + DocumentReference + Provenance) as one FHIR
 * transaction Bundle when online, for atomicity; otherwise queue each resource locally
 * and let the sync worker replay them individually.
 */
export async function saveEncounterBundle(resources) {
  // resources: array of { resourceType, resource }
  resources.forEach(({ resourceType, resource }) => local.put(resourceType, resource))

  const ok = online || (await checkConnectivity())
  if (!ok) {
    resources.forEach(({ resourceType, resource }) =>
      local.enqueueOutbox({ op: resource.id?.startsWith('local-') ? 'create' : 'update', resourceType, localId: resource.id, resource: stripLocalMeta(resource) })
    )
    logAuditEvent({ action: 'sign-encounter', resourceType: 'Encounter', outcome: 'queued-offline' })
    emitStatus()
    return { queued: true }
  }

  const bundle = {
    resourceType: 'Bundle',
    type: 'transaction',
    entry: resources.map(({ resourceType, resource }) => ({
      fullUrl: resource.id?.startsWith('local-') ? `urn:uuid:${resource.id}` : undefined,
      resource: stripLocalMeta(resource),
      request: {
        method: resource.id?.startsWith('local-') ? 'POST' : 'PUT',
        url: resource.id?.startsWith('local-') ? resourceType : `${resourceType}/${resource.id}`,
      },
    })),
  }

  try {
    const result = await fhir.submitBundle(bundle)
    logAuditEvent({ action: 'sign-encounter', resourceType: 'Encounter', outcome: 'success' })
    emitStatus()
    return result
  } catch (e) {
    resources.forEach(({ resourceType, resource }) =>
      local.enqueueOutbox({ op: resource.id?.startsWith('local-') ? 'create' : 'update', resourceType, localId: resource.id, resource: stripLocalMeta(resource) })
    )
    logAuditEvent({ action: 'sign-encounter', resourceType: 'Encounter', outcome: 'queued-error' })
    emitStatus()
    return { queued: true, error: e.message }
  }
}

export async function findPatients(searchTerm) {
  const ok = online || (await checkConnectivity())
  if (ok) {
    try {
      const byName = await fhir.searchResource('Patient', { name: searchTerm, _count: 20 })
      const byId = await fhir.searchResource('Patient', { identifier: searchTerm, _count: 20 })
      const merged = dedupeById([...byName, ...byId])
      merged.forEach((p) => local.put('Patient', p))
      return merged
    } catch {
      // fall through to local
    }
  }
  const term = searchTerm.toLowerCase()
  return local.query('Patient', (p) => {
    const name = (p.name?.[0]?.text || `${p.name?.[0]?.given?.join(' ')} ${p.name?.[0]?.family}` || '').toLowerCase()
    const ids = (p.identifier || []).map((i) => i.value).join(' ')
    return name.includes(term) || ids.includes(term)
  })
}

export async function getPatient(id) {
  const ok = online || (await checkConnectivity())
  if (ok) {
    try {
      const p = await fhir.readResource('Patient', id)
      local.put('Patient', p)
      return p
    } catch {
      /* fall back to local */
    }
  }
  return local.get('Patient', id)
}

export async function getEncountersForPatient(patientId) {
  const ok = online || (await checkConnectivity())
  if (ok) {
    try {
      const encs = await fhir.searchResource('Encounter', { patient: patientId, _sort: '-date', _count: 50 })
      encs.forEach((e) => local.put('Encounter', e))
      return encs
    } catch {
      /* fall back */
    }
  }
  return local.query('Encounter', (e) => e.subject?.reference === `Patient/${patientId}`).sort(
    (a, b) => new Date(b.period?.start || 0) - new Date(a.period?.start || 0)
  )
}

export function getLocal(resourceType, id) {
  return local.get(resourceType, id)
}

export function listLocal(resourceType, predicate) {
  return predicate ? local.query(resourceType, predicate) : local.list(resourceType)
}

function dedupeById(arr) {
  const seen = new Map()
  arr.forEach((r) => seen.set(r.id, r))
  return [...seen.values()]
}

// ---------------- background sync worker ----------------

let workerHandle = null

export function startSyncWorker() {
  if (workerHandle) return
  const intervalMs = Number(import.meta.env.VITE_SYNC_INTERVAL_MS) || 15000
  const tick = async () => {
    const ok = await checkConnectivity()
    if (ok) await drainOutbox()
  }
  tick()
  workerHandle = setInterval(tick, intervalMs)
}

export function stopSyncWorker() {
  clearInterval(workerHandle)
  workerHandle = null
}

async function drainOutbox() {
  const box = local.getOutbox()
  if (box.length === 0) return
  const remaining = []
  for (const entry of box) {
    try {
      const payload = entry.resource
      const result =
        entry.op === 'create'
          ? await fhir.createResource(entry.resourceType, payload)
          : await fhir.updateResource(entry.resourceType, entry.localId, payload)
      if (entry.op === 'create') {
        local.replaceLocalId(entry.resourceType, entry.localId, result)
      } else {
        local.markSynced(entry.resourceType, entry.localId)
      }
      logAuditEvent({ action: 'sync-replay', resourceType: entry.resourceType, resourceId: result.id, outcome: 'success' })
    } catch (e) {
      remaining.push({ ...entry, attempts: entry.attempts + 1, lastError: e.message })
    }
  }
  local.setOutbox(remaining)
  emitStatus()
}

export function currentStatus() {
  return { online, pending: local.outboxCount() }
}
