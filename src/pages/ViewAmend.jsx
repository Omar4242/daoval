import { useEffect, useState } from 'react'
import { useParams, Link } from 'react-router-dom'
import { getPatient, getLocal, saveResource, listLocal } from '../services/dataService'
import { buildAmendmentDocumentReference } from '../fhir/mappers'
import { usePatientContext } from '../context/PatientContext'
import { AMENDMENT_REASON_CODES } from '../fhir/codes'
import PatientBanner from '../components/PatientBanner'
import SyncStatus from '../components/SyncStatus'
import TraceRule from '../components/TraceRule'
import Brand from '../components/Brand'

export default function ViewAmend() {
  const { patientId, encounterId } = useParams()
  const { patient, setPatient } = usePatientContext()
  const [encounter, setEncounter] = useState(null)
  const [related, setRelated] = useState([])
  const [amendments, setAmendments] = useState([])
  const [showForm, setShowForm] = useState(false)
  const [text, setText] = useState('')
  const [reason, setReason] = useState('')
  const [saving, setSaving] = useState(false)

  function refresh() {
    const enc = getLocal('Encounter', encounterId)
    setEncounter(enc)
    setRelated({
      vitals: listLocal('Observation', (o) => o.encounter?.reference === `Encounter/${encounterId}` && o.category?.[0]?.coding?.[0]?.code === 'vital-signs'),
      conditions: listLocal('Condition', (c) => c.encounter?.reference === `Encounter/${encounterId}`),
      meds: listLocal('MedicationRequest', (m) => m.encounter?.reference === `Encounter/${encounterId}`),
      allergies: listLocal('AllergyIntolerance', () => true),
      docs: listLocal('DocumentReference', (d) => d.context?.encounter?.[0]?.reference === `Encounter/${encounterId}` && !d.relatesTo),
    })
    setAmendments(listLocal('DocumentReference', (d) => d.relatesTo?.[0]?.target?.reference === `Encounter/${encounterId}`))
  }

  useEffect(() => {
    getPatient(patientId).then(setPatient)
    refresh()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [patientId, encounterId])

  async function submitAmendment(e) {
    e.preventDefault()
    if (text.trim().length < 10) return
    setSaving(true)
    await saveResource('DocumentReference', buildAmendmentDocumentReference(patientId, encounterId, { text, reasonCode: reason }), {
      auditAction: 'amend',
    })
    setSaving(false)
    setText('')
    setReason('')
    setShowForm(false)
    refresh()
  }

  function decodeDoc(doc) {
    try {
      return decodeURIComponent(escape(atob(doc.content?.[0]?.attachment?.data || '')))
    } catch {
      return ''
    }
  }

  if (!encounter) {
    return (
      <div className="app-shell">
        <div className="page">
          <p className="hint">Loading…</p>
        </div>
      </div>
    )
  }

  return (
    <div className="app-shell">
      <div className="topbar">
        <Brand label="DOCTOR PORTAL" />
        <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
          <SyncStatus />
          <Link to={`/patient/${patientId}`} className="btn btn-ghost">
            ← Back to chart
          </Link>
        </div>
      </div>
      <PatientBanner patient={patient} />
      <div className="page">
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 4 }}>
          <h1>Signed encounter</h1>
          <span className="badge badge-signed">Signed</span>
        </div>
        <p className="hint" style={{ marginBottom: 16 }}>
          {encounter.period?.start ? new Date(encounter.period.start).toLocaleString() : '—'} · Read-only. Corrections
          happen through an amendment below — the original is never rewritten.
        </p>
        <TraceRule />

        <div className="card">
          <div className="summary-block">
            <div className="summary-label">Reason for visit</div>
            <p>{encounter.reasonCode?.[0]?.text || encounter.reasonCode?.[0]?.coding?.[0]?.display}</p>
          </div>
          <div className="summary-block">
            <div className="summary-label">Vitals</div>
            <p className="mono">
              {related.vitals?.length ? related.vitals.map((v) => `${v.code?.coding?.[0]?.display}: ${v.valueQuantity?.value}${v.valueQuantity?.unit}`).join(' · ') : 'None recorded'}
            </p>
          </div>
          <div className="summary-block">
            <div className="summary-label">Assessment</div>
            <ul>
              {related.conditions?.map((c) => (
                <li key={c.id}>
                  {c.code?.coding?.[0]?.display} ({c.code?.coding?.[0]?.code}) — {c.clinicalStatus?.coding?.[0]?.code}
                </li>
              ))}
            </ul>
          </div>
          <div className="summary-block">
            <div className="summary-label">Medications</div>
            <ul>
              {related.meds?.length ? related.meds.map((m) => <li key={m.id}>{m.dosageInstruction?.[0]?.text}</li>) : <li>None</li>}
            </ul>
          </div>
          {related.docs?.map((d) => (
            <div className="summary-block" key={d.id}>
              <div className="summary-label">{d.description}</div>
              <p>{decodeDoc(d)}</p>
            </div>
          ))}
        </div>

        <h3 style={{ margin: '22px 0 12px' }}>Amendments</h3>
        {amendments.length === 0 && <p className="hint">No amendments on this record.</p>}
        {amendments.map((a) => (
          <div className="card" key={a.id} style={{ borderLeft: '3px solid var(--accent)' }}>
            <div className="summary-label">{a.description || 'addendum'}</div>
            <p>{decodeDoc(a)}</p>
          </div>
        ))}

        {!showForm ? (
          <button className="btn btn-secondary" onClick={() => setShowForm(true)}>
            + Add amendment
          </button>
        ) : (
          <form className="card" onSubmit={submitAmendment}>
            <h3 style={{ marginBottom: 12 }}>New amendment</h3>
            <div className="field" style={{ marginBottom: 12, maxWidth: 260 }}>
              <label>Reason</label>
              <select value={reason} onChange={(e) => setReason(e.target.value)}>
                <option value="">Select…</option>
                {AMENDMENT_REASON_CODES.map((r) => (
                  <option key={r.code} value={r.display}>
                    {r.display}
                  </option>
                ))}
              </select>
            </div>
            <div className={`field ${text.length > 0 && text.length < 10 ? 'invalid' : ''}`} style={{ marginBottom: 12 }}>
              <label>Amendment text <span className="req">*</span></label>
              <textarea rows={4} value={text} onChange={(e) => setText(e.target.value)} />
              <span className="hint">Minimum 10 characters. This creates a new, separately timestamped note.</span>
            </div>
            <div style={{ display: 'flex', gap: 10 }}>
              <button className="btn btn-primary" type="submit" disabled={saving || text.trim().length < 10}>
                {saving ? 'Saving…' : 'Save amendment'}
              </button>
              <button className="btn btn-ghost" type="button" onClick={() => setShowForm(false)}>
                Cancel
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  )
}
