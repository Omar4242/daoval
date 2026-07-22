// Every read/write of patient data is logged as a FHIR AuditEvent, per spec section 11.
// Written through the same local-first path as clinical data so audit entries survive
// being offline too, and get flushed to the server by the same sync worker.

import * as local from './localStore'

let currentUser = null

export function setAuditUser(user) {
  currentUser = user
}

export function logAuditEvent({ action, resourceType, resourceId, outcome, purposeOfEvent }) {
  const event = {
    resourceType: 'AuditEvent',
    type: { system: 'http://terminology.hl7.org/CodeSystem/audit-event-type', code: 'rest' },
    action: mapAction(action),
    recorded: new Date().toISOString(),
    outcome: outcome === 'success' ? '0' : outcome === 'queued-offline' ? '4' : '8',
    outcomeDesc: outcome,
    agent: [
      {
        who: currentUser ? { display: currentUser.name, reference: `Practitioner/${currentUser.id}` } : { display: 'unknown' },
        requestor: true,
      },
    ],
    entity: resourceId
      ? [{ what: { reference: `${resourceType}/${resourceId}` } }]
      : [{ what: { display: resourceType } }],
    purposeOfEvent: purposeOfEvent ? [{ text: purposeOfEvent }] : undefined,
  }
  // Fire-and-forget: write locally (appended, never surfaced as UI state) and queue for
  // the same background sync worker that flushes clinical resources, so AuditEvents end
  // up on the FHIR server too (spec section 11 requires this, not just a local log).
  const stamped = local.put('AuditEvent', { ...event, id: local.genLocalId('AuditEvent') })
  local.enqueueOutbox({ op: 'create', resourceType: 'AuditEvent', localId: stamped.id, resource: stamped })
}

function mapAction(action) {
  if (!action) return 'R'
  if (action.startsWith('write') || action.includes('save') || action.includes('sign')) return 'C'
  if (action.includes('update') || action.includes('amend')) return 'U'
  if (action.includes('read') || action.includes('view') || action.includes('search')) return 'R'
  return 'E'
}

/** Break-glass: doctor accessing a patient outside their schedule/recent list must give a reason. */
export function logBreakGlass({ patientId, reason }) {
  logAuditEvent({
    action: 'read',
    resourceType: 'Patient',
    resourceId: patientId,
    outcome: 'success',
    purposeOfEvent: `BREAK-GLASS: ${reason}`,
  })
}
