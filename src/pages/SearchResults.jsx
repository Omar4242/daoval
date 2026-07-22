import { useEffect, useState } from 'react'
import { useNavigate, useSearchParams, Link } from 'react-router-dom'
import { findPatients, listLocal } from '../services/dataService'
import { logBreakGlass } from '../services/auditService'
import { patientDisplayName, maskedNationalId } from '../context/PatientContext'
import BreakGlassModal from '../components/BreakGlassModal'
import TraceRule from '../components/TraceRule'

export default function SearchResults() {
  const [params] = useSearchParams()
  const q = params.get('q') || ''
  const navigate = useNavigate()
  const [results, setResults] = useState([])
  const [loading, setLoading] = useState(true)
  const [breakGlassTarget, setBreakGlassTarget] = useState(null)

  useEffect(() => {
    setLoading(true)
    findPatients(q).then((r) => {
      setResults(r)
      setLoading(false)
    })
  }, [q])

  function isRecentOrScheduled(patientId) {
    // Heuristic standing in for a real schedule feed: "recent" = has a local encounter already.
    return listLocal('Encounter').some((e) => e.subject?.reference === `Patient/${patientId}`)
  }

  function openChart(patient) {
    if (!isRecentOrScheduled(patient.id)) {
      setBreakGlassTarget(patient)
      return
    }
    navigate(`/patient/${patient.id}`)
  }

  return (
    <div className="app-shell">
      <div className="topbar">
        <div className="brand">
          Daoval <small>DOCTOR PORTAL</small>
        </div>
        <Link to="/dashboard" className="btn btn-ghost">
          ← Dashboard
        </Link>
      </div>
      <div className="page">
        <h1>Search results</h1>
        <p className="hint" style={{ marginBottom: 18 }}>
          For &ldquo;{q}&rdquo;. Confirm identity before opening a chart — even for a single exact match.
        </p>
        <TraceRule />

        {loading && <p className="hint">Searching…</p>}

        {!loading && results.length === 0 && (
          <div className="card empty-state">
            <p style={{ marginBottom: 14 }}>No matching patients found.</p>
            <Link to={`/register?name=${encodeURIComponent(q)}`} className="btn btn-primary">
              Register new patient
            </Link>
          </div>
        )}

        {results.map((p) => (
          <div key={p.id} className="list-row" onClick={() => openChart(p)}>
            <div>
              <strong>{patientDisplayName(p)}</strong>
              <div className="mono hint">
                DOB {p.birthDate || '—'} · {maskedNationalId(p)} · MRN {p.id}
              </div>
            </div>
            <button className="btn btn-secondary" onClick={(e) => { e.stopPropagation(); openChart(p) }}>
              Open chart
            </button>
          </div>
        ))}

        {!loading && results.length > 0 && (
          <p className="hint" style={{ marginTop: 16 }}>
            Not who you're looking for?{' '}
            <Link to={`/register?name=${encodeURIComponent(q)}`}>Register a new patient</Link>
          </p>
        )}
      </div>

      {breakGlassTarget && (
        <BreakGlassModal
          patientName={patientDisplayName(breakGlassTarget)}
          onCancel={() => setBreakGlassTarget(null)}
          onConfirm={(reason) => {
            logBreakGlass({ patientId: breakGlassTarget.id, reason })
            navigate(`/patient/${breakGlassTarget.id}`)
          }}
        />
      )}
    </div>
  )
}
