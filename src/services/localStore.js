// Local persistence. Every write the app makes goes here first (source of truth for the
// UI, works fully offline), then dataService mirrors it to the HAPI FHIR server and
// reconciles the server-assigned id back into local storage.
//
// Storage shape:
//   daoval:res:<ResourceType>  -> { [localId]: resource }
//   daoval:outbox              -> [ { op, resourceType, localId, resource, attempts, lastError } ]

const NS = 'daoval'

function key(resourceType) {
  return `${NS}:res:${resourceType}`
}

function readCollection(resourceType) {
  try {
    return JSON.parse(localStorage.getItem(key(resourceType))) || {}
  } catch {
    return {}
  }
}

function writeCollection(resourceType, collection) {
  localStorage.setItem(key(resourceType), JSON.stringify(collection))
}

export function genLocalId(resourceType) {
  return `local-${resourceType}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

export function put(resourceType, resource) {
  const id = resource.id || genLocalId(resourceType)
  const stamped = { ...resource, id }
  const col = readCollection(resourceType)
  col[id] = stamped
  writeCollection(resourceType, col)
  return stamped
}

export function get(resourceType, id) {
  return readCollection(resourceType)[id] || null
}

export function list(resourceType) {
  return Object.values(readCollection(resourceType))
}

export function remove(resourceType, id) {
  const col = readCollection(resourceType)
  delete col[id]
  writeCollection(resourceType, col)
}

/** Simple substring/field search across a local collection (mirrors what a FHIR search would return). */
export function query(resourceType, predicate) {
  return list(resourceType).filter(predicate)
}

// ---------------- outbox (offline write queue) ----------------

function outboxKey() {
  return `${NS}:outbox`
}

export function enqueueOutbox(entry) {
  const box = getOutbox()
  box.push({ attempts: 0, lastError: null, queuedAt: new Date().toISOString(), ...entry })
  localStorage.setItem(outboxKey(), JSON.stringify(box))
}

export function getOutbox() {
  try {
    return JSON.parse(localStorage.getItem(outboxKey())) || []
  } catch {
    return []
  }
}

export function setOutbox(box) {
  localStorage.setItem(outboxKey(), JSON.stringify(box))
}

export function outboxCount() {
  return getOutbox().length
}

// ---------------- reconciling a local id with a server-assigned id ----------------

export function replaceLocalId(resourceType, localId, serverResource) {
  const col = readCollection(resourceType)
  delete col[localId]
  col[serverResource.id] = { ...serverResource, _localId: localId, _synced: true }
  writeCollection(resourceType, col)
}

export function markSynced(resourceType, id) {
  const col = readCollection(resourceType)
  if (col[id]) {
    col[id]._synced = true
    writeCollection(resourceType, col)
  }
}
