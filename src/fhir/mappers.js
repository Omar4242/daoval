import { VITALS_CONFIG } from './codes'

export function buildPatientResource(form, existingId) {
  return {
    resourceType: 'Patient',
    id: existingId,
    name: [{ text: form.fullName, use: 'official' }],
    identifier: [{ system: 'urn:daoval:national-id', value: form.nationalId }],
    birthDate: form.dateOfBirth,
    gender: form.sex,
    telecom: form.phone ? [{ system: 'phone', value: form.phone, use: 'mobile' }] : [],
    address: form.address ? [{ text: form.address }] : [],
    contact: form.emergencyContactName
      ? [
          {
            name: { text: form.emergencyContactName },
            telecom: form.emergencyContactPhone ? [{ system: 'phone', value: form.emergencyContactPhone }] : [],
          },
        ]
      : [],
    communication: form.primaryLanguage
      ? [{ language: { coding: [{ system: 'urn:ietf:bcp:47', code: form.primaryLanguage }] } }]
      : [],
    maritalStatus: form.maritalStatus
      ? { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/v3-MaritalStatus', code: form.maritalStatus }] }
      : undefined,
  }
}

export function buildConsentResource(patientId, existingId) {
  return {
    resourceType: 'Consent',
    id: existingId,
    status: 'active',
    scope: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/consentscope', code: 'treatment' }] },
    category: [{ coding: [{ system: 'http://loinc.org', code: '59284-0', display: 'Consent to treat' }] }],
    patient: { reference: `Patient/${patientId}` },
    dateTime: new Date().toISOString(),
  }
}

export function buildEncounterResource(patientId, meta, existingId) {
  return {
    resourceType: 'Encounter',
    id: existingId,
    status: 'in-progress',
    class: {
      system: 'http://terminology.hl7.org/CodeSystem/v3-ActCode',
      code: meta.encounterType === 'ambulatory' ? 'AMB' : meta.encounterType === 'emergency' ? 'EMER' : 'IMP',
    },
    subject: { reference: `Patient/${patientId}` },
    period: { start: meta.dateTime },
    reasonCode: [
      meta.reasonCoded
        ? { coding: [{ system: 'http://hl7.org/fhir/sid/icd-10-cm', code: meta.reasonCoded.code, display: meta.reasonCoded.display }] }
        : { text: meta.reasonFreeText },
    ],
  }
}

export function buildVitalsObservations(patientId, encounterId, vitals) {
  return VITALS_CONFIG.filter((v) => vitals[v.key] !== '' && vitals[v.key] != null).map((v) => ({
    resourceType: 'Observation',
    id: vitals[`${v.key}_id`],
    status: 'final',
    category: [{ coding: [{ system: 'http://terminology.hl7.org/CodeSystem/observation-category', code: 'vital-signs' }] }],
    code: { coding: [{ system: 'http://loinc.org', code: v.loinc, display: v.label }] },
    subject: { reference: `Patient/${patientId}` },
    encounter: { reference: `Encounter/${encounterId}` },
    effectiveDateTime: new Date().toISOString(),
    valueQuantity: { value: Number(vitals[v.key]), unit: v.unit },
  }))
}

export function buildSocialHistoryObservation(patientId, encounterId, smokingStatus, existingId) {
  if (!smokingStatus) return null
  return {
    resourceType: 'Observation',
    id: existingId,
    status: 'final',
    category: [{ coding: [{ system: 'http://terminology.hl7.org/CodeSystem/observation-category', code: 'social-history' }] }],
    code: { coding: [{ system: 'http://snomed.info/sct', code: '77176002', display: 'Smoking status' }] },
    subject: { reference: `Patient/${patientId}` },
    encounter: { reference: `Encounter/${encounterId}` },
    valueCodeableConcept: { coding: [{ system: 'http://snomed.info/sct', code: smokingStatus.code, display: smokingStatus.display }] },
  }
}

export function buildAllergyResource(patientId, allergy, existingId) {
  return {
    resourceType: 'AllergyIntolerance',
    id: existingId,
    clinicalStatus: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/allergyintolerance-clinical', code: 'active' }] },
    verificationStatus: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/allergyintolerance-verification', code: allergy.verificationStatus }] },
    criticality: allergy.criticality,
    code: { coding: [{ system: 'http://snomed.info/sct', code: allergy.substance.code, display: allergy.substance.display }] },
    patient: { reference: `Patient/${patientId}` },
    reaction: allergy.reaction ? [{ manifestation: [{ text: allergy.reaction }] }] : [],
  }
}

export function buildConditionResource(patientId, encounterId, dx, existingId) {
  return {
    resourceType: 'Condition',
    id: existingId,
    clinicalStatus: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/condition-clinical', code: dx.clinicalStatus }] },
    code: { coding: [{ system: 'http://hl7.org/fhir/sid/icd-10-cm', code: dx.diagnosis.code, display: dx.diagnosis.display }] },
    subject: { reference: `Patient/${patientId}` },
    encounter: { reference: `Encounter/${encounterId}` },
  }
}

export function buildMedicationRequestResource(patientId, encounterId, med, existingId) {
  return {
    resourceType: 'MedicationRequest',
    id: existingId,
    status: 'active',
    intent: 'order',
    medicationCodeableConcept: { coding: [{ system: 'http://www.nlm.nih.gov/research/umls/rxnorm', code: med.drug.code, display: med.drug.display }] },
    subject: { reference: `Patient/${patientId}` },
    encounter: { reference: `Encounter/${encounterId}` },
    dosageInstruction: [
      {
        text: `${med.dose} ${med.unit}, ${med.frequency}, for ${med.duration} day(s)`,
        timing: { repeat: { boundsDuration: { value: Number(med.duration), unit: 'd' } }, code: { coding: [{ code: med.frequency }] } },
        doseAndRate: [{ doseQuantity: { value: Number(med.dose), unit: med.unit } }],
      },
    ],
  }
}

export function buildImmunizationResource(patientId, encounterId, imm, existingId) {
  return {
    resourceType: 'Immunization',
    id: existingId,
    status: 'completed',
    vaccineCode: { coding: [{ system: 'http://hl7.org/fhir/sid/cvx', code: imm.vaccine.code, display: imm.vaccine.display }] },
    patient: { reference: `Patient/${patientId}` },
    encounter: { reference: `Encounter/${encounterId}` },
    occurrenceDateTime: imm.adminDate,
  }
}

export function buildDocumentReferenceResource(patientId, encounterId, { title, text, kind }, existingId) {
  return {
    resourceType: 'DocumentReference',
    id: existingId,
    status: 'current',
    type: { text: kind },
    subject: { reference: `Patient/${patientId}` },
    context: { encounter: [{ reference: `Encounter/${encounterId}` }] },
    description: title,
    content: [
      {
        attachment: {
          contentType: 'text/plain',
          data: typeof btoa === 'function' ? btoa(unescape(encodeURIComponent(text || ''))) : '',
          title,
        },
      },
    ],
  }
}

export function buildProvenanceResource(encounterId, practitioner, existingId) {
  return {
    resourceType: 'Provenance',
    id: existingId,
    target: [{ reference: `Encounter/${encounterId}` }],
    recorded: new Date().toISOString(),
    agent: [
      {
        who: { reference: `Practitioner/${practitioner.id}`, display: practitioner.name },
        onBehalfOf: undefined,
      },
    ],
    signature: [
      {
        type: [{ system: 'urn:iso-astm:E1762-95:2013', code: '1.2.840.10065.1.12.1.1', display: "Author's Signature" }],
        when: new Date().toISOString(),
        who: { display: practitioner.name },
      },
    ],
  }
}

// ---------------- directory resources ----------------
//
// Organization / Location / Practitioner are not decorative lookup rows: ingested data
// gets attributed to them, so their identity has to survive re-ingestion from an
// external system. That stability lives in `identifier`, the cross-system business key,
// and not in `id`, which is a local surrogate assigned on write like every other
// builder in this file.
//
// Search caveat, recorded here so it isn't rediscovered as a mystery bug: store.js's
// `name` search parameter assumes a HumanName[] (it reads r.name[0].text, then
// .given/.family). Organization.name and Location.name are plain strings in FHIR R4, so
// r.name[0] is the string's first *character* and every field read off it is undefined.
// `?name=` therefore matches nothing for those two and returns an empty set rather than
// an error. Practitioner.name is a HumanName[] and does work. Until store.js handles
// both shapes explicitly, and fails loudly on a shape it doesn't recognise instead of
// silently filtering to zero, look these up with `?identifier=`, which works for all
// three.

export function buildOrganizationResource(org, existingId) {
  return {
    resourceType: 'Organization',
    id: existingId,
    identifier: [{ system: 'urn:daoval:organization', value: org.key }],
    active: org.active !== false,
    name: org.name,
    // Caller-supplied only: alternate spellings and transliterations of the same
    // facility name, which is what makes an inbound record match an existing org.
    alias: org.alias?.length ? org.alias : undefined,
    type: [
      {
        coding: [
          {
            system: 'http://terminology.hl7.org/CodeSystem/organization-type',
            code: 'prov',
            display: 'Healthcare Provider',
          },
        ],
      },
    ],
    telecom: org.phone ? [{ system: 'phone', value: org.phone }] : [],
    address: org.address ? [{ text: org.address }] : [],
    partOf: org.partOfId ? { reference: `Organization/${org.partOfId}` } : undefined,
  }
}

export function buildLocationResource(location, existingId) {
  return {
    resourceType: 'Location',
    id: existingId,
    identifier: [{ system: 'urn:daoval:location', value: location.key }],
    status: location.status || 'active',
    name: location.name,
    // 'instance' = this specific department in this specific hospital, as opposed to
    // 'kind', which would describe a class of place.
    mode: 'instance',
    type: location.roleCode
      ? [{ coding: [{ system: 'http://terminology.hl7.org/CodeSystem/v3-RoleCode', code: location.roleCode, display: location.name }] }]
      : [{ text: location.name }],
    physicalType: [
      {
        coding: [
          {
            system: 'http://terminology.hl7.org/CodeSystem/location-physical-type',
            code: location.physicalType || 'wa',
          },
        ],
      },
    ],
    managingOrganization: { reference: `Organization/${location.organizationId}` },
    partOf: location.partOfId ? { reference: `Location/${location.partOfId}` } : undefined,
  }
}

// Takes no existingId, unlike the rest of this file: a practitioner's resource id is
// deliberately the same UUID as their users row. auditService.js and
// buildProvenanceResource already emit `Practitioner/${user.id}` into every AuditEvent
// and Provenance, so reusing the id makes those references resolve, including for
// records written before any Practitioner resource existed.
export function buildPractitionerResource(user) {
  return {
    resourceType: 'Practitioner',
    id: user.id,
    identifier: [{ system: 'urn:daoval:user-id', value: user.id }],
    active: user.active !== false,
    // users.name is a single free-text field, so there's no reliable family/given split
    // to make here. Guessing one from whitespace would mangle names that don't follow a
    // given-then-family order. text alone is honest, and store.js's name search reads
    // name[0].text first anyway.
    name: [{ text: user.name }],
    telecom: user.email ? [{ system: 'email', value: user.email }] : [],
  }
}

export function buildAmendmentDocumentReference(patientId, originalEncounterId, { text, reasonCode }, existingId) {
  return {
    resourceType: 'DocumentReference',
    id: existingId,
    status: 'current',
    type: { text: 'Amendment' },
    subject: { reference: `Patient/${patientId}` },
    context: { encounter: [{ reference: `Encounter/${originalEncounterId}` }] },
    relatesTo: [{ code: 'appends', target: { reference: `Encounter/${originalEncounterId}` } }],
    description: reasonCode,
    content: [
      {
        attachment: {
          contentType: 'text/plain',
          data: typeof btoa === 'function' ? btoa(unescape(encodeURIComponent(text || ''))) : '',
        },
      },
    ],
  }
}
