# Daoval interoperability data plan

Scope: what Daoval sends to and receives from *other* hospital systems — not the
internal encounter-documentation data model, which already exists and is solid
(see "What's already there" below).

## The real problem this has to solve

Egyptian hospitals — like most healthcare systems outside a few countries with strong
national FHIR mandates — are not going to be running clean FHIR APIs. Realistically,
what's out there is a mix of:
- Legacy HL7v2 feeds (ADT admit/discharge/transfer, ORU lab results) — still the most
  common hospital integration protocol worldwide, FHIR's adoption curve
  notwithstanding
- Proprietary vendor APIs or flat CSV/Excel exports
- No electronic interface at all — paper or a closed system with no external access

This means Daoval's interoperability layer isn't "connect to hospital FHIR servers."
It's closer to: **an integration engine that ingests whatever a given hospital
actually exposes, and normalizes it into the FHIR-shaped internal model Daoval
already uses.** That's a materially different (harder) build than assuming FHIR on
both ends, and it changes what "data points" means — the priority isn't only which
FHIR fields to send, it's which fields survive translation from whatever the source
system actually has.

## What's already there

The encounter-authoring flow already produces a solid internal FHIR-shaped record on
sign: `Patient`, `Encounter`, `Observation`, `Condition`, `AllergyIntolerance`,
`MedicationRequest`, `Immunization`, `DocumentReference`, `Provenance`, `Consent`.
That's a real foundation — it's *what Daoval knows about a patient*. What doesn't
exist yet is anything that talks to a system outside Daoval.

## Data domains to exchange, in priority order

### 1. Patient identity — the hardest and most important problem first
Before any other resource can be exchanged, Daoval has to answer "is this the same
patient the other system means?" Two hospitals rarely share a patient ID.

- **Resource:** `Patient`
- **Key data points:** national ID (Egypt's national ID is the strongest natural
  matching key available), full name (Arabic + transliterated), date of birth, sex,
  phone number, and an `identifier` array that records *which source system* each ID
  came from — this is what makes matching auditable instead of a guess.
- **This needs its own matching strategy** (deterministic match on national ID first,
  probabilistic fallback on name+DOB+phone) before anything else in this plan is
  trustworthy. Get this wrong and every other resource links to the wrong patient.

### 2. Organizational identity — who Daoval is talking to
- **Resources:** `Organization` (the hospital/clinic itself), `Location` (department/
  ward — ties directly into the department field just added to staff accounts),
  `Practitioner` + `PractitionerRole` (the clinician, and which org/department they're
  acting within)
- **Not yet modeled at all in the current schema.** Right now Daoval has no concept
  of "which hospital" a record came from — everything is implicitly single-tenant.
  This has to exist before Daoval can meaningfully say "this data came from Hospital
  A vs. Hospital B."

### 3. Encounter history — admissions, transfers, discharges
- **Resource:** `Encounter`, sourced from ADT feeds where the origin system is HL7v2
- **Key data points:** admit/discharge/transfer timestamps, encounter class
  (inpatient/outpatient/emergency), attending practitioner, location/ward, reason for
  visit
- This is usually the *first* thing a hospital integration engine handles, because
  ADT is the most standardized legacy feed — worth building the HL7v2-to-FHIR mapping
  for this resource first as the proof of concept for the whole ingestion pipeline.

### 4. Diagnostic results — labs and imaging
- **Resources:** `Observation` (labs, vitals) and `DiagnosticReport` (imaging reads,
  pathology)
- **Key data points:** LOINC-coded test name, value + unit, reference range,
  abnormal flag, result status (preliminary/final/corrected), performing lab/facility
- Sourced from ORU (HL7v2) feeds where available. This is the highest clinical value
  per data point — a missed abnormal lab is a bigger risk than a missing allergy
  note — so it's worth prioritizing over less urgent domains even though it's not the
  easiest to build.

### 5. Medications
- **Resource:** `MedicationRequest` / `MedicationStatement`
- **Key data points:** drug (ideally RxNorm-coded, though Egypt-market drugs won't
  reliably map to RxNorm — a local formulary code table is realistically needed
  alongside it), dose, route, start/stop dates, prescribing practitioner
- High value, but also the domain most prone to silent data loss in translation —
  worth flagging that a mismatched or dropped medication is a genuine safety risk,
  not just missing metadata.

### 6. Problem list / diagnoses
- **Resource:** `Condition`
- **Key data points:** ICD-10 code, onset date, clinical status (active/resolved),
  verification status

### 7. Allergies
- **Resource:** `AllergyIntolerance`
- **Key data points:** substance, reaction, severity, verification status
- Small data footprint, disproportionately high safety value — cheap to prioritize.

### 8. Documents / reports as a fallback tier
- **Resource:** `DocumentReference`
- For any source system that can't be structurally mapped (many won't be, especially
  smaller clinics), falling back to attaching a PDF/scanned report as a
  `DocumentReference` is a legitimate lower tier — not real interoperability, but
  better than losing the data entirely, and a realistic near-term need given how many
  Egyptian facilities will have no structured export at all.

## Exchange mechanisms — how data actually moves

This needs to support more than one pattern, because different source systems will
only offer one or the other:

- **Inbound HL7v2 listener** (MLLP over TCP) for hospitals still on ADT/ORU feeds —
  this is the integration engine piece, and realistically the highest-effort item on
  this whole list.
- **FHIR REST client** for any hospital that does expose FHIR — straightforward given
  Daoval's backend already speaks FHIR-shaped JSON.
- **Bulk file ingestion** (CSV/Excel drop, scheduled import) as the lowest-common-
  denominator fallback for systems with no live interface at all.
- **Outbound**: Daoval should also be able to *push* — e.g., notify a receiving
  hospital's system of a new encounter — but this is lower priority than getting
  inbound ingestion working, since Daoval's core value proposition is unifying
  fragmented *incoming* records first.

## Cross-cutting requirements, not optional

- **Terminology mapping tables.** ICD-10/LOINC/RxNorm/SNOMED are the target codes,
  but source systems will use local or vendor-specific codes. A mapping table (source
  code → target code, with an "unmapped" bucket that surfaces for manual review
  rather than silently dropping data) is required infrastructure, not a nice-to-have.
- **Provenance on everything ingested.** Every resource pulled from an external
  system needs a `Provenance` record — which system, when, matched to which patient
  identifier — both for clinical trust (a clinician needs to know if a lab result
  came from a system they trust) and for the HIPAA audit trail already partially
  built (the `access_log` table and `AuditEvent` writes).
- **Consent scope.** The `Consent` resource already exists in the internal model —
  cross-hospital data sharing needs it actually enforced (which external systems is
  a given patient's data allowed to be pulled from/pushed to), not just recorded.

## Suggested build order

1. `Organization` / `Location` / `Practitioner` — foundational identity, blocks
   everything else, and directly extends the department field just added to staff
   accounts.
2. Patient matching strategy — the single highest-risk piece to get wrong.
3. HL7v2 ADT ingestion (`Encounter`) — proves out the integration-engine pattern with
   the most standardized legacy feed available.
4. HL7v2 ORU ingestion (`Observation`/`DiagnosticReport`) — highest clinical value
   per data point.
5. Everything else (medications, conditions, allergies, documents) — lower-risk,
   can be added incrementally once the pipeline pattern from steps 3–4 exists.

This is a genuinely large build — the HL7v2 listener and terminology mapping alone
are each roughly comparable in scope to everything built so far in this project. Not
a discouragement, just calibrating expectations: this is the actual "interoperability
platform" part of Daoval's mission statement, and it's appropriately the biggest
piece of work on the roadmap.
