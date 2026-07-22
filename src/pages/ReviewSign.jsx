import { useEffect, useState } from 'react'
import { useParams, useNavigate, Link } from 'react-router-dom'
import { getPatient, getLocal, saveEncounterBundle } from '../services/dataService'
import { useAuth } from '../context/AuthContext'
import { usePatientContext } from '../context/PatientContext'
import PatientBanner from '../components/PatientBanner'
import SyncStatus from '../components/SyncStatus'
import TraceRule from '../components/TraceRule'
import {
  buildEncounterResource,
  buildVitalsObservations,
  buildSocialHistoryObservation,
  buildAllergyResource,
  buildConditionResource,
  buildMedicationRequestResource,
  buildImmunizationResource,
  buildDocumentReferenceResource,
  buildProvenanceResource,
} from '../fhir/mappers'

export default function ReviewSign() {
  const { patientId, encounterId } = useParams()
  const navigate = useNavigate()
  const { user } = useAuth()
  const { patient, setPatient } = usePatientContext()
  const [form, setForm] = useState(null)
  const [attested, setAttested] = useState(false)
  const [signing, setSigning] = useState(false)

  useEffect(() => {
    getPatient(patientId).then(setPatient)
    const enc = getLocal('Encounter', encounterId)
    if (enc?._draftForm) setForm(enc._draftForm)
  }, [patientId, encounterId, setPatient])

  if (!form) {
    return (
      <div className="app-shell">
        <div className="page">
          <p className="hint">Loading draft…</p>
        </div>
      </div>
    )
  }

  const checklist = [
    { label: 'Reason for visit', ok: !!(form.meta.reasonCoded || form.meta.reasonFreeText) },
    { label: 'Chief complaint', ok: !!form.history.chiefComplaint },
    {
      label: 'At least one diagnosis, coded',
      ok: form.assessment.length > 0 && form.assessment.every((a) => !!a.diagnosis),
    },
  ]
  const missingRequired = checklist.some((c) => !c.ok)

  async function sign() {
    setSigning(true)
    const enc = getLocal('Encounter', encounterId)
    const resources = []

    resources.push({
      resourceType: 'Encounter',
      resource: { ...buildEncounterResource(patientId, form.meta, encounterId), status: 'finished' },
    })

    buildVitalsObservations(patientId, encounterId, form.vitals).forEach((o) => resources.push({ resourceType: 'Observation', resource: o }))

    const social = buildSocialHistoryObservation(patientId, encounterId, form.preventive.smokingStatus)
    if (social) resources.push({ resourceType: 'Observation', resource: social })

    if (form.history.hpi) {
      resources.push({
        resourceType: 'DocumentReference',
        resource: buildDocumentReferenceResource(patientId, encounterId, { title: 'History of present illness', text: form.history.hpi, kind: 'HPI' }),
      })
    }
    if (form.exam.notes) {
      resources.push({
        resourceType: 'DocumentReference',
        resource: buildDocumentReferenceResource(patientId, encounterId, { title: 'Exam notes', text: form.exam.notes, kind: 'Exam' }),
      })
    }

    form.allergies
      .filter((a) => a.substance)
      .forEach((a) => resources.push({ resourceType: 'AllergyIntolerance', resource: buildAllergyResource(patientId, a) }))

    form.assessment
      .filter((d) => d.diagnosis)
      .forEach((d) => resources.push({ resourceType: 'Condition', resource: buildConditionResource(patientId, encounterId, d) }))

    form.plan.medications
      .filter((m) => m.drug)
      .forEach((m) => resources.push({ resourceType: 'MedicationRequest', resource: buildMedicationRequestResource(patientId, encounterId, m) }))

    form.preventive.immunizations
      .filter((i) => i.vaccine)
      .forEach((i) => resources.push({ resourceType: 'Immunization', resource: buildImmunizationResource(patientId, encounterId, i) }))

    resources.push({ resourceType: 'Provenance', resource: buildProvenanceResource(encounterId, user) })

    // Note: the finished Encounter resource built above has no _draftForm on it, so
    // this submission naturally clears the draft — no separate cleanup step needed.
    await saveEncounterBundle(resources)
    setSigning(false)
    navigate(`/patient/${patientId}/encounter/${encounterId}/view`)
  }

  return (
    <div className="app-shell">
      <div className="topbar">
        <div className="brand">
          Daoval <small>DOCTOR PORTAL</small>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
          <SyncStatus />
          <Link to={`/patient/${patientId}/encounter/${encounterId}`} className="btn btn-ghost">
            ← Back to editing
          </Link>
        </div>
      </div>
      <PatientBanner patient={patient} />
      <div className="page">
        <h1>Review &amp; sign</h1>
        <p className="hint" style={{ marginBottom: 16 }}>
          This is the legal attestation step. Once signed, nothing on this encounter can be edited — corrections happen
          through an amendment.
        </p>
        <TraceRule />

        <div className="card">
          <div className="summary-block">
            <div className="summary-label">Visit</div>
            <p>
              {form.meta.encounterType} · {new Date(form.meta.dateTime).toLocaleString()} ·{' '}
              {form.meta.reasonCoded ? `${form.meta.reasonCoded.display} (${form.meta.reasonCoded.code})` : form.meta.reasonFreeText}
            </p>
          </div>
          <div className="summary-block">
            <div className="summary-label">Vitals</div>
            <p className="mono">
              {Object.entries(form.vitals).filter(([, v]) => v !== '' && v != null).length === 0
                ? 'None recorded'
                : Object.entries(form.vitals)
                    .filter(([, v]) => v !== '' && v != null)
                    .map(([k, v]) => `${k}: ${v}`)
                    .join(' · ')}
            </p>
          </div>
          <div className="summary-block">
            <div className="summary-label">Chief complaint</div>
            <p>{form.history.chiefComplaint || <span className="err-text">Missing</span>}</p>
          </div>
          <div className="summary-block">
            <div className="summary-label">HPI</div>
            <p>{form.history.hpi || '—'}</p>
          </div>
          <div className="summary-block">
            <div className="summary-label">Allergies</div>
            <p>{form.allergies.filter((a) => a.substance).map((a) => a.substance.display).join(', ') || 'None documented'}</p>
          </div>
          <div className="summary-block">
            <div className="summary-label">Exam notes</div>
            <p>{form.exam.notes || '—'}</p>
          </div>
          <div className="summary-block">
            <div className="summary-label">Assessment</div>
            {form.assessment.length === 0 ? (
              <p className="err-text">No diagnosis added</p>
            ) : (
              <ul>
                {form.assessment.map((d, i) => (
                  <li key={i}>
                    {d.diagnosis?.display} ({d.diagnosis?.code}) — {d.clinicalStatus}
                  </li>
                ))}
              </ul>
            )}
          </div>
          <div className="summary-block">
            <div className="summary-label">Plan</div>
            {form.plan.medications.filter((m) => m.drug).length > 0 ? (
              <ul>
                {form.plan.medications
                  .filter((m) => m.drug)
                  .map((m, i) => (
                    <li key={i}>
                      {m.drug.display} — {m.dose} {m.unit}, {m.frequency}, {m.duration}d
                    </li>
                  ))}
              </ul>
            ) : (
              <p>No medications prescribed</p>
            )}
            {form.plan.followUpInstructions && <p>Follow-up: {form.plan.followUpInstructions}</p>}
            {form.plan.followUpDate && <p className="mono">Follow-up date: {form.plan.followUpDate}</p>}
          </div>
          <div className="summary-block">
            <div className="summary-label">Preventive care</div>
            <p>Smoking status: {form.preventive.smokingStatus?.display || '—'}</p>
            <p>
              Immunizations:{' '}
              {form.preventive.immunizations.filter((i) => i.vaccine).map((i) => i.vaccine.display).join(', ') || 'None'}
            </p>
          </div>
        </div>

        {missingRequired && (
          <div className="card" style={{ borderColor: 'var(--danger)', background: 'var(--danger-soft)' }}>
            <strong className="err-text">This encounter is missing required fields</strong>
            <ul style={{ marginTop: 8 }}>
              {checklist.map((c) => (
                <li key={c.label} className={c.ok ? '' : 'err-text'}>
                  {c.ok ? '✓' : '✗'} {c.label}
                  {c.label.startsWith('At least one diagnosis') && !c.ok && (
                    <span className="hint">
                      {' '}
                      — go back to Assessment and pick a diagnosis from the typeahead dropdown (it must match a code in
                      the list, not just be typed).
                    </span>
                  )}
                </li>
              ))}
            </ul>
          </div>
        )}

        <div className="attest-box">
          <input type="checkbox" style={{ marginTop: 3 }} checked={attested} onChange={(e) => setAttested(e.target.checked)} disabled={missingRequired} />
          <div>
            <strong>I confirm this record is accurate and complete.</strong>
            <p className="hint">This attestation is recorded to Provenance.agent with your identity and timestamp.</p>
          </div>
        </div>

        <button className="btn btn-primary" style={{ marginTop: 16 }} disabled={!attested || signing || missingRequired} onClick={sign}>
          {signing ? 'Signing…' : 'Sign & finalize'}
        </button>
      </div>
    </div>
  )
}
