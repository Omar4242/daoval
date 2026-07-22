import { useEffect, useState } from 'react'
import { useAuth } from '../context/AuthContext'

export default function ReauthModal() {
  const { requestReauthCode, submitReauthCode } = useAuth()
  const [challengeId, setChallengeId] = useState(null)
  const [code, setCode] = useState('')
  const [error, setError] = useState('')
  const [sending, setSending] = useState(true)

  // A fresh code is emailed as soon as the modal appears — the old static demo code
  // no longer applies, this is a real one-time code per lock event.
  useEffect(() => {
    requestReauthCode().then((res) => {
      setSending(false)
      if (!res.ok) return setError(res.error)
      setChallengeId(res.challengeId)
    })
  }, [])

  async function submit(e) {
    e.preventDefault()
    const res = await submitReauthCode(challengeId, code)
    if (!res.ok) setError(res.error)
  }

  async function resend() {
    setSending(true)
    setError('')
    const res = await requestReauthCode()
    setSending(false)
    if (!res.ok) return setError(res.error)
    setChallengeId(res.challengeId)
  }

  return (
    <div className="modal-backdrop">
      <div className="modal">
        <h2>Session locked</h2>
        <p style={{ color: 'var(--ink-soft)', fontSize: 13.5 }}>
          You've been idle for 15 minutes. {sending ? 'Emailing you a new code…' : 'Enter the code we just emailed you to continue'} — your draft is safe and hasn't been lost.
        </p>
        <form onSubmit={submit}>
          <div className="field" style={{ marginBottom: 12 }}>
            <label>6-digit code</label>
            <input
              type="text"
              inputMode="numeric"
              maxLength={6}
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
              autoFocus
              disabled={sending}
            />
            {error && <span className="err-text">{error}</span>}
          </div>
          <button className="btn btn-primary btn-block" type="submit" disabled={sending || !challengeId}>
            Unlock
          </button>
          <button type="button" className="btn btn-ghost btn-block" style={{ marginTop: 8 }} onClick={resend} disabled={sending}>
            Resend code
          </button>
        </form>
      </div>
    </div>
  )
}
