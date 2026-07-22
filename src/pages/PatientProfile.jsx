import { useEffect, useState } from 'react'
import { useParams, useNavigate, Link } from 'react-router-dom'
import { getPatient, getEncountersForPatient } from '../services/dataService'
import { usePatientContext, patientDisplayName, maskedNationalId } from '../context/PatientContext'
import PatientBanner from '../components/PatientBanner'
import SyncStatus from '../components/SyncStatus'
import TraceRule from '../components/TraceRule'
import Brand from '../components/Brand'

export default function PatientProfile() {
  const { patientId } = useParams()
  const navigate = useNavigate()
  const { setPatient } = usePatientContext()
  const [patient, setLocalPatient] = useState(null)
  const [encounters, setEncounters] = useState([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let active = true
    setLoading(true)
    Promise.all([getPatient(patientId), getEncountersForPatient(patientId)]).then(([p, encs]) => {
      if (!active) return
      setLocalPatient(p)
      setPatient(p)
      setEncounters(encs)
      setLoading(false)
    })
    return () => {
      active = false
    }
  }, [patientId, setPatient])

  if (loading) {
    return (
      <div className="app-shell">
        <div className="page">
          <p className="hint">Loading chart…</p>
        </div>
      </div>
    )
  }

  if (!patient) {
    return (
      <div className="app-shell">
        <div className="page">
          <p className="err-text">Patient not found.</p>
          <Link to="/dashboard">← Back to dashboard</Link>
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
          <Link to="/dashboard" className="btn btn-ghost">
            ← Dashboard
          </Link>
        </div>
      </div>
      <PatientBanner
        patient={patient}
        right={
          <button className="btn btn-primary" onClick={() => navigate(`/patient/${patientId}/encounter/new`)}>
            + New encounter
          </button>
        }
      />
      <div className="page">
        <h1>{patientDisplayName(patient)}</h1>
        <p className="hint mono" style={{ marginBottom: 18 }}>
          {patient.gender} · DOB {patient.birthDate} · {maskedNationalId(patient)} · MRN {patient.id}
        </p>
        <TraceRule />

        <div className="card field-grid" style={{ marginBottom: 24 }}>
          <div>
            <div className="summary-label">Phone</div>
            <p>{patient.telecom?.[0]?.value || '—'}</p>
          </div>
          <div>
            <div className="summary-label">Address</div>
            <p>{patient.address?.[0]?.text || '—'}</p>
          </div>
          <div>
            <div className="summary-label">Emergency contact</div>
            <p>{patient.contact?.[0]?.name?.text || '—'}</p>
          </div>
          <div>
            <div className="summary-label">Language</div>
            <p>{patient.communication?.[0]?.language?.coding?.[0]?.code || '—'}</p>
          </div>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
          <h3>Encounter history</h3>
          <button className="btn btn-ghost" title="Editing demographics is an admin-only tool, out of doctor scope" disabled>
            Edit demographics (admin only)
          </button>
        </div>

        {encounters.length === 0 ? (
          <div className="card empty-state">
            No encounters yet. <br />
            <button className="btn btn-primary" style={{ marginTop: 12 }} onClick={() => navigate(`/patient/${patientId}/encounter/new`)}>
              Start the first encounter
            </button>
          </div>
        ) : (
          encounters.map((e) => (
            <div
              key={e.id}
              className="list-row"
              onClick={() =>
                navigate(
                  e.status === 'finished' ? `/patient/${patientId}/encounter/${e.id}/view` : `/patient/${patientId}/encounter/${e.id}`
                )
              }
            >
              <div>
                <strong>{e.reasonCode?.[0]?.text || e.reasonCode?.[0]?.coding?.[0]?.display || 'Encounter'}</strong>
                <div className="mono hint">
                  {e.period?.start ? new Date(e.period.start).toLocaleString() : '—'} · {e.class?.code}
                </div>
              </div>
              <span className={`badge ${e.status === 'finished' ? 'badge-signed' : 'badge-draft'}`}>
                {e.status === 'finished' ? 'Signed' : 'Draft'}
              </span>
            </div>
          ))
        )}
      </div>
    </div>
  )
}
