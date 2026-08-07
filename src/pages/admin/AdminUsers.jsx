import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { useAuth } from '../../context/AuthContext'
import * as authApi from '../../services/authApi'
import * as fhir from '../../services/fhirClient'
import TraceRule from '../../components/TraceRule'
import Brand from '../../components/Brand'

// Departments used to be a hardcoded list of strings here. They are Location resources
// now, managed on the departments screen, so this picker is sourced from whatever that
// facility actually set up. Talks to fhirClient rather than dataService for the same
// reason AdminLocations does: dataService logs an AuditEvent per save, and
// administrators are not permitted to write AuditEvent.

function generateTempPassword() {
  // Not meant to be memorable — the recipient is expected to change it at first
  // sign-in (see force_password_change on the users table for that follow-up step).
  const bytes = crypto.getRandomValues(new Uint8Array(12))
  return Array.from(bytes, (b) => b.toString(36).padStart(2, '0')).join('').slice(0, 16) + 'Aa1!'
}

export default function AdminUsers() {
  const { user, signOut } = useAuth()
  const [users, setUsers] = useState([])
  const [locations, setLocations] = useState([])
  const [loading, setLoading] = useState(true)
  const [form, setForm] = useState({ email: '', name: '', role: 'doctor', locationId: '', organization: '' })
  const [tempPassword, setTempPassword] = useState('')
  const [error, setError] = useState('')
  const [lastCreated, setLastCreated] = useState(null)
  const [statusBusyId, setStatusBusyId] = useState(null)

  async function refresh() {
    setLoading(true)
    const res = await authApi.listAdminUsers()
    if (res.ok) setUsers(res.users)

    // Locations are needed for two things: the picker below, and resolving the
    // location_id on existing rows to a readable name in the roster.
    const claim = await authApi.getClaimedOrganization()
    if (claim.ok && claim.organizationId) {
      try {
        const found = await fhir.searchResource('Location', { organization: claim.organizationId })
        setLocations(found)
        setForm((f) => (f.locationId ? f : { ...f, locationId: found[0]?.id || '' }))
      } catch (e) {
        setError(`Could not load departments: ${e.message}`)
      }
    }
    setLoading(false)
  }

  // Read precedence, deliberately explicit rather than reading one column and hoping.
  // A Location reference wins where one is set. The free-text department column is
  // only consulted for accounts created before departments became resources, and those
  // accounts are left exactly as they are. Never both, and never blank for a new
  // account whose department column is NULL by design.
  function departmentLabel(u) {
    if (u.location_id) {
      return locations.find((l) => l.id === u.location_id)?.name || 'Unknown department'
    }
    return u.department || null
  }

  useEffect(() => {
    refresh()
  }, [])

  function openForm() {
    setTempPassword(generateTempPassword())
    setError('')
    setLastCreated(null)
  }

  async function submit(e) {
    e.preventDefault()
    setError('')
    const payload = {
      ...form,
      locationId: form.role === 'administrator' ? null : form.locationId,
      organization: form.role === 'administrator' ? form.organization.trim() : undefined,
    }
    const res = await authApi.createAdminUser({ ...payload, tempPassword })
    if (!res.ok) return setError(res.error)
    setLastCreated({ email: form.email, tempPassword })
    setForm({ email: '', name: '', role: 'doctor', locationId: locations[0]?.id || '', organization: '' })
    setTempPassword('')
    refresh()
  }

  async function toggleStatus(u) {
    setStatusBusyId(u.id)
    setError('')
    const res = await authApi.setUserStatus(u.id, !u.active)
    setStatusBusyId(null)
    if (!res.ok) return setError(res.error)
    refresh()
  }

  const needsDepartment = form.role !== 'administrator'
  const needsOrganization = form.role === 'administrator'

  return (
    <div className="app-shell">
      <div className="topbar">
        <Brand label="ADMINISTRATOR" />
        <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
          <Link className="btn btn-ghost" to="/admin/locations">
            Departments and wards
          </Link>
          <span style={{ fontSize: 13.5, color: 'var(--ink-soft)' }}>{user?.name}</span>
          <button className="btn btn-ghost" onClick={signOut}>
            Sign out
          </button>
        </div>
      </div>
      <div className="page">
        <h1>Healthcare workers</h1>
        <p className="hint" style={{ marginBottom: 18 }}>
          Add doctors, nurses, technicians, and other administrators. New accounts sign in with the temporary
          password shown once below, then set their own password.
        </p>
        <TraceRule />

        <div className="card" style={{ marginBottom: 24 }}>
          <h3 style={{ marginBottom: 14 }}>Add someone</h3>
          <form onSubmit={submit}>
            <div style={{ display: 'flex', gap: 12, marginBottom: 12 }}>
              <div className="field" style={{ flex: 1 }}>
                <label>Full name <span className="req">*</span></label>
                <input
                  type="text"
                  value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                  onFocus={openForm}
                  required
                />
              </div>
              <div className="field" style={{ flex: 1 }}>
                <label>Email <span className="req">*</span></label>
                <input
                  type="email"
                  value={form.email}
                  onChange={(e) => setForm({ ...form, email: e.target.value })}
                  onFocus={openForm}
                  required
                />
              </div>
              <div className="field" style={{ width: 160 }}>
                <label>Role <span className="req">*</span></label>
                <select value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })}>
                  <option value="doctor">Doctor</option>
                  <option value="nurse">Nurse</option>
                  <option value="technician">Technician</option>
                  <option value="administrator">Administrator</option>
                </select>
              </div>
              {needsDepartment && (
                <div className="field" style={{ width: 200 }}>
                  <label>Department <span className="req">*</span></label>
                  <select
                    value={form.locationId}
                    onChange={(e) => setForm({ ...form, locationId: e.target.value })}
                    disabled={locations.length === 0}
                  >
                    {locations.length === 0 ? (
                      <option value="">No departments yet</option>
                    ) : (
                      locations.map((l) => (
                        <option key={l.id} value={l.id}>
                          {l.name}
                        </option>
                      ))
                    )}
                  </select>
                </div>
              )}
              {needsOrganization && (
                <div className="field" style={{ flex: 1 }}>
                  <label>Hospital / clinic / healthcare center <span className="req">*</span></label>
                  <input
                    type="text"
                    value={form.organization}
                    onChange={(e) => setForm({ ...form, organization: e.target.value })}
                    onFocus={openForm}
                    placeholder="e.g. Riverside General Hospital"
                    required
                  />
                </div>
              )}
            </div>
            {!needsOrganization && (
              <p className="hint" style={{ marginBottom: 12 }}>
                They'll be added to {user?.organization || 'your'} organization, same as your account.
              </p>
            )}
            {needsDepartment && locations.length === 0 && (
              <p className="hint" style={{ marginBottom: 12 }}>
                No departments set up yet. Add them on{' '}
                <Link to="/admin/locations">Departments and wards</Link> first, then come back.
              </p>
            )}
            {tempPassword && (
              <p className="hint" style={{ marginBottom: 12 }}>
                Temporary password (shown once — share it with them directly, not by email):{' '}
                <span className="mono">{tempPassword}</span>
              </p>
            )}
            {error && <p className="err-text" style={{ marginBottom: 12 }}>{error}</p>}
            <button className="btn btn-primary" type="submit">
              Create account
            </button>
          </form>
          {lastCreated && (
            <p className="hint" style={{ marginTop: 14 }}>
              Created {lastCreated.email}. Temporary password: <span className="mono">{lastCreated.tempPassword}</span>
            </p>
          )}
        </div>

        <h3 style={{ margin: '26px 0 12px' }}>All accounts</h3>
        {loading ? (
          <div className="card empty-state">Loading…</div>
        ) : users.length === 0 ? (
          <div className="card empty-state">No accounts yet.</div>
        ) : (
          users.map((u) => (
            <div key={u.id} className="list-row">
              <div>
                <strong>{u.name}</strong>
                <div className="mono hint">
                  {u.email} · {u.role}
                  {departmentLabel(u) ? ` · ${departmentLabel(u)}` : ''}
                  {u.organization ? ` · ${u.organization}` : ''}
                </div>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                <span className="hint">{u.active ? 'Active' : 'Suspended'}</span>
                {u.id !== user?.id && (
                  <button
                    className="btn btn-ghost"
                    disabled={statusBusyId === u.id}
                    onClick={() => toggleStatus(u)}
                  >
                    {u.active ? 'Suspend' : 'Reinstate'}
                  </button>
                )}
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  )
}
