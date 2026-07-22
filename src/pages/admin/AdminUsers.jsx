import { useEffect, useState } from 'react'
import { useAuth } from '../../context/AuthContext'
import * as authApi from '../../services/authApi'
import TraceRule from '../../components/TraceRule'

// A starting list, not a hard boundary — the backend only requires a non-empty
// string, so this can be edited here without a migration if a hospital's structure
// doesn't match it.
const DEPARTMENTS = [
  'Emergency',
  'Internal Medicine',
  'Surgery',
  'Pediatrics',
  'Obstetrics & Gynecology',
  'Cardiology',
  'ICU',
  'Radiology',
  'Laboratory',
  'Pharmacy',
  'Outpatient Clinic',
]

function generateTempPassword() {
  // Not meant to be memorable — the recipient is expected to change it at first
  // sign-in (see force_password_change on the users table for that follow-up step).
  const bytes = crypto.getRandomValues(new Uint8Array(12))
  return Array.from(bytes, (b) => b.toString(36).padStart(2, '0')).join('').slice(0, 16) + 'Aa1!'
}

export default function AdminUsers() {
  const { user, signOut } = useAuth()
  const [users, setUsers] = useState([])
  const [loading, setLoading] = useState(true)
  const [form, setForm] = useState({ email: '', name: '', role: 'doctor', department: DEPARTMENTS[0] })
  const [tempPassword, setTempPassword] = useState('')
  const [error, setError] = useState('')
  const [lastCreated, setLastCreated] = useState(null)

  async function refresh() {
    setLoading(true)
    const res = await authApi.listAdminUsers()
    if (res.ok) setUsers(res.users)
    setLoading(false)
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
    const payload = { ...form, department: form.role === 'administrator' ? null : form.department }
    const res = await authApi.createAdminUser({ ...payload, tempPassword })
    if (!res.ok) return setError(res.error)
    setLastCreated({ email: form.email, tempPassword })
    setForm({ email: '', name: '', role: 'doctor', department: DEPARTMENTS[0] })
    setTempPassword('')
    refresh()
  }

  const needsDepartment = form.role !== 'administrator'

  return (
    <div className="app-shell">
      <div className="topbar">
        <div className="brand">
          Daoval <small>ADMINISTRATOR</small>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
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
                  <select value={form.department} onChange={(e) => setForm({ ...form, department: e.target.value })}>
                    {DEPARTMENTS.map((d) => (
                      <option key={d} value={d}>
                        {d}
                      </option>
                    ))}
                  </select>
                </div>
              )}
            </div>
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
                  {u.department ? ` · ${u.department}` : ''}
                </div>
              </div>
              <span className="hint">{u.active ? 'Active' : 'Deactivated'}</span>
            </div>
          ))
        )}
      </div>
    </div>
  )
}
