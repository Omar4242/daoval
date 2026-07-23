import { useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import TraceRule from '../components/TraceRule'

// Where each role lands after a successful sign-in. Decided by the account's real
// stored role (returned by the server after MFA), not by anything the person picked
// before authenticating.
function landingPathFor(user) {
  if (user?.mustChangePassword) return '/change-password'
  if (user?.role === 'administrator') return '/admin/users'
  return '/dashboard'
}

// The "portal" is purely a framing choice for which entry point someone clicked on
// the landing page — copy and icon only. It never changes what the form submits or
// how the server decides where to send someone; that's still 100% driven by the
// account's real role, returned only after password + MFA succeed. A doctor who
// lands here via the administrator button just gets routed to /dashboard like normal.
const PORTAL_COPY = {
  admin: {
    heading: 'Administrator sign in',
    sub: 'Manage provisioned accounts for your clinic.',
  },
  clinician: {
    heading: 'Clinician sign in',
    sub: 'Sign in to document and review patient encounters.',
  },
  default: {
    heading: 'Sign in',
    sub: 'Sign in as a healthcare worker or administrator — your account already knows which.',
  },
}

export default function SignIn() {
  const { submitCredentials, submitCode } = useAuth()
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const portal =
    searchParams.get('portal') === 'admin' || searchParams.get('portal') === 'clinician'
      ? searchParams.get('portal')
      : 'default'
  const copy = PORTAL_COPY[portal]
  const [step, setStep] = useState('credentials')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [code, setCode] = useState('')
  const [challengeId, setChallengeId] = useState(null)
  const [error, setError] = useState('')
  const [submitting, setSubmitting] = useState(false)

  async function handleCredentials(e) {
    e.preventDefault()
    setSubmitting(true)
    const res = await submitCredentials(email, password)
    setSubmitting(false)
    if (!res.ok) return setError(res.error)
    setChallengeId(res.challengeId)
    setError('')
    setStep('mfa')
  }

  async function handleCode(e) {
    e.preventDefault()
    setSubmitting(true)
    const res = await submitCode(challengeId, code)
    setSubmitting(false)
    if (!res.ok) return setError(res.error)
    navigate(landingPathFor(res.user))
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
          <div
            className="brand"
            style={{ justifyContent: 'center', fontSize: 30, marginBottom: 10, letterSpacing: '-0.015em' }}
          >
            {copy.heading}
          </div>
          <p className="hint" style={{ fontSize: 13.5 }}>
            {copy.sub}
          </p>
        </div>
        <TraceRule animate tall />
        <div className="card" style={{ animation: 'card-arrive 0.5s var(--ease) 0.35s both' }}>
          {step === 'credentials' ? (
            <form onSubmit={handleCredentials}>
              <h2 style={{ marginBottom: 16 }}>Sign in</h2>
              <div className="field" style={{ marginBottom: 12 }}>
                <label>Email <span className="req">*</span></label>
                <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoFocus required />
              </div>
              <div className="field" style={{ marginBottom: 8 }}>
                <label>Password <span className="req">*</span></label>
                <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required />
              </div>
              <p style={{ marginBottom: 16, textAlign: 'right' }}>
                <Link to="/forgot-password" style={{ fontSize: 13 }}>Forgot password?</Link>
              </p>
              {error && <p className="err-text" style={{ marginBottom: 12 }}>{error}</p>}
              <button className="btn btn-primary btn-block" type="submit" disabled={submitting}>
                {submitting ? 'Checking…' : 'Continue'}
              </button>
              <p className="hint" style={{ marginTop: 14, textAlign: 'center' }}>
                Accounts are provisioned by your clinic administrator.
                {portal !== 'default' && ' You\u2019ll land on the right workspace for your account either way.'}
              </p>
            </form>
          ) : (
            <form onSubmit={handleCode}>
              <h2 style={{ marginBottom: 6 }}>Check your email</h2>
              <p className="hint" style={{ marginBottom: 16 }}>
                We emailed a 6-digit code to {email}. It expires in 10 minutes.
              </p>
              <div className="field" style={{ marginBottom: 16 }}>
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
              {error && <p className="err-text" style={{ marginBottom: 12 }}>{error}</p>}
              <button className="btn btn-primary btn-block" type="submit" disabled={submitting}>
                {submitting ? 'Verifying…' : 'Verify & sign in'}
              </button>
              <p className="hint" style={{ marginTop: 14, textAlign: 'center' }}>
                Didn't get it? Check spam, or contact your clinic admin.
              </p>
            </form>
          )}
        </div>
      </div>
    </div>
  )
}
