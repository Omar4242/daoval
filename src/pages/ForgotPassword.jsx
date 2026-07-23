import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import TraceRule from '../components/TraceRule'

// Deliberately generic — this copy is shown whether or not an account exists for the
// entered email, so the page itself never tells a caller which emails are provisioned.
const REQUEST_SENT_COPY =
  "If that email has a Daoval account, we've sent a 6-digit code to it. Enter it below along with your new password."

export default function ForgotPassword() {
  const { requestPasswordReset, submitPasswordReset } = useAuth()
  const navigate = useNavigate()
  const [step, setStep] = useState('request') // 'request' | 'reset' | 'done'
  const [email, setEmail] = useState('')
  const [challengeId, setChallengeId] = useState(null)
  const [code, setCode] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [error, setError] = useState('')
  const [submitting, setSubmitting] = useState(false)

  async function handleRequest(e) {
    e.preventDefault()
    setSubmitting(true)
    const res = await requestPasswordReset(email)
    setSubmitting(false)
    if (!res.ok) return setError(res.error)
    setError('')
    // challengeId may be undefined if no account matched the email — the form still
    // advances to the code step regardless, so the response looks identical either way.
    setChallengeId(res.challengeId || null)
    setStep('reset')
  }

  async function handleReset(e) {
    e.preventDefault()
    setError('')
    if (newPassword.length < 12) return setError('New password must be at least 12 characters.')
    if (newPassword !== confirm) return setError('Passwords do not match.')

    setSubmitting(true)
    const res = await submitPasswordReset(challengeId, code, newPassword)
    setSubmitting(false)
    if (!res.ok) return setError(res.error)
    setStep('done')
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
            Reset your password
          </div>
          <p className="hint" style={{ fontSize: 13.5 }}>
            {step === 'request' && "Enter your account email and we'll send you a reset code."}
            {step === 'reset' && REQUEST_SENT_COPY}
            {step === 'done' && 'Your password has been reset.'}
          </p>
        </div>
        <TraceRule />
        <div className="card">
          {step === 'request' && (
            <form onSubmit={handleRequest}>
              <div className="field" style={{ marginBottom: 16 }}>
                <label>Email <span className="req">*</span></label>
                <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoFocus required />
              </div>
              {error && <p className="err-text" style={{ marginBottom: 12 }}>{error}</p>}
              <button className="btn btn-primary btn-block" type="submit" disabled={submitting}>
                {submitting ? 'Sending…' : 'Send reset code'}
              </button>
              <p className="hint" style={{ marginTop: 14, textAlign: 'center' }}>
                <Link to="/sign-in">Back to sign in</Link>
              </p>
            </form>
          )}

          {step === 'reset' && (
            <form onSubmit={handleReset}>
              <div className="field" style={{ marginBottom: 12 }}>
                <label>Code <span className="req">*</span></label>
                <input
                  type="text"
                  inputMode="numeric"
                  maxLength={6}
                  value={code}
                  onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
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
                {submitting ? 'Resetting…' : 'Reset password'}
              </button>
              <p className="hint" style={{ marginTop: 14, textAlign: 'center' }}>
                Didn't get a code? Check spam, or{' '}
                <button
                  type="button"
                  onClick={() => {
                    setStep('request')
                    setCode('')
                    setError('')
                  }}
                  style={{
                    background: 'none',
                    border: 'none',
                    padding: 0,
                    color: 'var(--primary)',
                    cursor: 'pointer',
                    font: 'inherit',
                  }}
                >
                  try again
                </button>
                .
              </p>
            </form>
          )}

          {step === 'done' && (
            <div>
              <p className="hint" style={{ marginBottom: 16 }}>
                You can now sign in with your new password.
              </p>
              <button className="btn btn-primary btn-block" onClick={() => navigate('/sign-in')}>
                Go to sign in
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
