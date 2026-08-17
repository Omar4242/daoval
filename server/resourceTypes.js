// Which FHIR resource types are facility directory (who and where) rather than
// clinical record (what happened to a patient).
//
// This set has two consumers that must never disagree, which is why it lives here
// rather than in either of them:
//
//   1. server/index.js — role access. Directory types are the only ones an
//      administrator may touch under /fhir/*, and the only ones a clinician may not
//      write.
//   2. server/store.js — tenancy. Directory types are read unscoped; everything else
//      is scoped to the caller's organization.
//
// If those two ever drift apart, the result is a tenancy bug: a type the route treats
// as clinical but the store treats as directory would be readable across
// organizations.
//
// Deliberately an exact allowlist rather than a "not clinical" heuristic, so adding a
// new resource type never silently widens either role's access.
//
// TRIPWIRE: PractitionerRole is not here yet, so administrators are currently refused
// it and clinicians can write it. Add it to this set when PractitionerRole lands, or
// admins will not be able to manage the resource that links practitioners to
// departments. Note the second consequence now that tenancy reads this too: adding a
// type here also makes it readable across organizations, so only add types that are
// genuinely directory data and carry no PHI.
export const DIRECTORY_RESOURCE_TYPES = new Set(['Organization', 'Location', 'Practitioner'])

// Tenancy is the complement of the directory, not its own allowlist. A resource type
// nobody has thought about yet is therefore scoped by default: a new clinical type
// added later is confined to one organization until someone deliberately lists it
// above. The inverse (an allowlist of scoped types) would leak any type somebody
// forgot to add, which is the wrong way for this to fail.
export function isScopedResourceType(resourceType) {
  return !DIRECTORY_RESOURCE_TYPES.has(resourceType)
}
