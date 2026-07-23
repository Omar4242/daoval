import { useEffect, useState } from 'react'
import { useNavigate, Link } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import { listLocal } from '../services/dataService'
import { patientDisplayName, maskedNationalId } from '../context/PatientContext'
import SyncStatus from '../components/SyncStatus'
import TraceRule from '../components/TraceRule'
import Brand from '../components/Brand'

export default function Dashboard() {
  const { user, signOut } = useAuth()
  const navigate = useNavigate()
  const [search, setSearch] = useState('')
  const [recent, setRecent] = useState([])

  useEffect(() => {
    // Recent/today's patients: encounters touched locally, most recent first.
    const encounters = listLocal('Encounter').sort(
      (a, b) => new Date(b.period?.start || 0) - new Date(a.period?.start || 0)
    )
    const patients = listLocal('Patient')
    const seen = new Set()
    const ordered = []
    encounters.forEach((e) => {
      const pid = e.subject?.reference?.split('/')[1]
      if (pid && !seen.has(pid)) {
        const p = patients.find((pp) => pp.id === pid)
        if (p) {
          ordered.push(p)
          seen.add(pid)
        }
      }
    })
    setRecent(ordered.slice(0, 8))
  }, [])

  function submitSearch(e) {
    e.preventDefault()
    if (search.trim().length < 2) return
    navigate(`/search?q=${encodeURIComponent(search.trim())}`)
  }

  return (
    <div className="app-shell">
      <div className="topbar">
        <Brand label="DOCTOR PORTAL" />
        <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
          <SyncStatus />
          <span style={{ fontSize: 13.5, color: 'var(--ink-soft)' }}>{user?.name}</span>
          <button className="btn btn-ghost" onClick={signOut}>
            Sign out
          </button>
        </div>
      </div>
      <div className="page">
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 16 }}>
          <div>
            <h1>Find a patient</h1>
            <p className="hint" style={{ marginBottom: 18 }}>
              Search by name, National ID, or MRN — or open someone from your recent list below.
            </p>
          </div>
          <Link to="/register" className="btn btn-primary" style={{ flexShrink: 0 }}>
            Register new patient
          </Link>
        </div>
        <TraceRule />
        <form onSubmit={submitSearch} className="card" style={{ display: 'flex', gap: 10 }}>
          <input
            type="text"
            style={{ flex: 1, fontSize: 14, padding: '10px 12px', border: '1px solid var(--line-strong)', borderRadius: 4 }}
            placeholder="Patient name, National ID, or MRN…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            autoFocus
          />
          <button className="btn btn-primary" type="submit" disabled={search.trim().length < 2}>
            Search
          </button>
        </form>

        <h3 style={{ margin: '26px 0 12px' }}>Recent &amp; today's patients</h3>
        {recent.length === 0 ? (
          <div className="card empty-state">
            No recent patients yet. Search above, or{' '}
            <Link to="/register">register a new patient</Link> to get started.
          </div>
        ) : (
          recent.map((p) => (
            <div key={p.id} className="list-row" onClick={() => navigate(`/patient/${p.id}`)}>
              <div>
                <strong>{patientDisplayName(p)}</strong>
                <div className="mono hint">DOB {p.birthDate} · {maskedNationalId(p)}</div>
              </div>
              <span className="btn btn-ghost">Open →</span>
            </div>
          ))
        )}
      </div>
    </div>
  )
}
