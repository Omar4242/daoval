import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import TraceRule from '../components/TraceRule'

export default function ChangePassword() {
  const { user, submitPasswordChange, signOut } = useAuth()
  const navigate = useNavigate()
  const [currentPassword, setCurrentPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [error, setError] = useState('')
  const [submitting, setSubmitting] = useState(false)

  async function submit(e) {
    e.preventDefault()
    setError('')
    if (newPassword.length < 12) return setError('New password must be at least 12 characters.')
    if (newPassword !== confirm) return setError('Passwords do not match.')

    setSubmitting(true)
    const res = await submitPasswordChange(currentPassword, newPassword)
    setSubmitting(false)
    if (!res.ok) return setError(res.error)
    navigate(user?.role === 'administrator' ? '/admin/users' : '/dashboard', { replace: true })
  }

  return (
    <div
      className="app-shell"
      style={{
        alignItems: 'center',
        justifyContent: 'center',
        display: 'flex',
        background: 'radial-gradient(60% 50% at 50% 0%, var(--primary-soft) 0%, var(--paper) 70%)',
      }}
    >
      <div style={{ width: 400 }}>
        <div style={{ textAlign: 'center', marginBottom: 10 }}>
          <div className="brand" style={{ justifyContent: 'center', fontSize: 26, marginBottom: 10 }}>
            Set a new password
          </div>
          <p className="hint" style={{ fontSize: 13.5 }}>
            {user?.name}, you're signed in with a temporary password. Set your own before continuing.
          </p>
        </div>
        <TraceRule />
        <div className="card">
          <form onSubmit={submit}>
            <div className="field" style={{ marginBottom: 12 }}>
              <label>Temporary password <span className="req">*</span></label>
              <input
                type="password"
                value={currentPassword}
                onChange={(e) => setCurrentPassword(e.target.value)}
                autoFocus
                required
              />
            </div>
            <div className="field" style={{ marginBottom: 12 }}>
              <label>New password <span className="req">*</span></label>
              <input type="password" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} required />
              <span className="hint">At least 12 characters.</span>
            </div>
            <div className="field" style={{ marginBottom: 16 }}>
              <label>Confirm new password <span className="req">*</span></label>
              <input type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} required />
            </div>
            {error && <p className="err-text" style={{ marginBottom: 12 }}>{error}</p>}
            <button className="btn btn-primary btn-block" type="submit" disabled={submitting}>
              {submitting ? 'Saving…' : 'Set password & continue'}
            </button>
            <button type="button" className="btn btn-ghost btn-block" style={{ marginTop: 8 }} onClick={signOut}>
              Sign out instead
            </button>
          </form>
        </div>
      </div>
    </div>
  )
}
