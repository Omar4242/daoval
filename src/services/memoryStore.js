// In-memory resource store + offline outbox. Everything the app writes goes here
// first (source of truth for the UI, works fully offline for the lifetime of this
// tab), then dataService mirrors it to the FHIR server and reconciles the
// server-assigned id back in.
//
// This is intentionally NOT persisted to disk (no localStorage/IndexedDB/etc): a
// hard refresh or closed tab loses whatever hasn't reached the server yet. That's a
// deliberate tradeoff, not an oversight — see PROJECT_STATUS.md.
//
// Shape (module-level, one instance per page load):
//   collections: { [ResourceType]: { [id]: resource } }
//   outbox:      [ { op, resourceType, localId, resource, attempts, lastError, queuedAt } ]

const collections = new Map() // resourceType -> Map(id -> resource)
let outbox = []

function collectionFor(resourceType) {
  let col = collections.get(resourceType)
  if (!col) {
    col = new Map()
    collections.set(resourceType, col)
  }
  return col
}

export function genLocalId(resourceType) {
  return `local-${resourceType}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

export function put(resourceType, resource) {
  const id = resource.id || genLocalId(resourceType)
  const stamped = { ...resource, id }
  collectionFor(resourceType).set(id, stamped)
  return stamped
}

export function get(resourceType, id) {
  return collectionFor(resourceType).get(id) || null
}

export function list(resourceType) {
  return [...collectionFor(resourceType).values()]
}

export function remove(resourceType, id) {
  collectionFor(resourceType).delete(id)
}

/** Simple substring/field search across a collection (mirrors what a FHIR search would return). */
export function query(resourceType, predicate) {
  return list(resourceType).filter(predicate)
}

// ---------------- outbox (offline write queue) ----------------

export function enqueueOutbox(entry) {
  outbox.push({ attempts: 0, lastError: null, queuedAt: new Date().toISOString(), ...entry })
}

export function getOutbox() {
  return outbox
}

export function setOutbox(box) {
  outbox = box
}

export function outboxCount() {
  return outbox.length
}

// ---------------- reconciling a local id with a server-assigned id ----------------

export function replaceLocalId(resourceType, localId, serverResource) {
  const col = collectionFor(resourceType)
  col.delete(localId)
  col.set(serverResource.id, { ...serverResource, _localId: localId, _synced: true })
}

export function markSynced(resourceType, id) {
  const col = collectionFor(resourceType)
  const existing = col.get(id)
  if (existing) {
    existing._synced = true
    col.set(id, existing)
  }
}
