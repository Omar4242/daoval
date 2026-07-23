import { createContext, useContext, useEffect, useState, useCallback, useRef } from 'react'
import { setAuditUser } from '../services/auditService'
import * as authApi from '../services/authApi'

const AuthContext = createContext(null)

const IDLE_LOCK_MS = 15 * 60 * 1000

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null)
  const [loading, setLoading] = useState(true) // restoring session on first load
  const [locked, setLocked] = useState(false)
  const idleTimer = useRef(null)

  // Restore session from the HttpOnly cookie on first load — the browser sends the
  // cookie automatically and the server tells us who that is. Nothing client-side
  // storage related is read here at all.
  useEffect(() => {
    authApi.me().then((res) => {
      if (res.ok) setUser(res.user)
      setLoading(false)
    })
  }, [])

  useEffect(() => {
    if (user) setAuditUser(user)
  }, [user])

  const resetIdleTimer = useCallback(() => {
    clearTimeout(idleTimer.current)
    if (!user) return
    idleTimer.current = setTimeout(() => setLocked(true), IDLE_LOCK_MS)
  }, [user])

  useEffect(() => {
    if (!user) return
    const events = ['mousemove', 'keydown', 'click', 'scroll']
    events.forEach((ev) => window.addEventListener(ev, resetIdleTimer))
    resetIdleTimer()
    return () => events.forEach((ev) => window.removeEventListener(ev, resetIdleTimer))
  }, [user, resetIdleTimer])

  // ---- sign-in flow: password, then an emailed one-time code ----

  async function submitCredentials(email, password) {
    const res = await authApi.login(email, password)
    if (!res.ok) return { ok: false, error: res.error }
    return { ok: true, challengeId: res.challengeId }
  }

  async function submitCode(challengeId, code) {
    const res = await authApi.verifyCode(challengeId, code)
    if (!res.ok) return { ok: false, error: res.error }
    setUser(res.user)
    setLocked(false)
    return { ok: true }
  }

  // ---- idle-timeout re-auth: request a fresh emailed code, then verify it ----

  async function requestReauthCode() {
    const res = await authApi.requestReauth()
    if (!res.ok) return { ok: false, error: res.error }
    return { ok: true, challengeId: res.challengeId }
  }

  async function submitReauthCode(challengeId, code) {
    const res = await authApi.verifyReauth(challengeId, code)
    if (!res.ok) return { ok: false, error: res.error }
    setLocked(false)
    resetIdleTimer()
    return { ok: true }
  }

  // ---- forgot-password flow: emailed code, then a new password, no session change ----

  async function requestPasswordReset(email) {
    const res = await authApi.forgotPassword(email)
    if (!res.ok) return { ok: false, error: res.error }
    // challengeId is present only when an account actually exists — the UI keeps the
    // same on-screen next step either way so it doesn't leak that back to the person.
    return { ok: true, challengeId: res.challengeId }
  }

  async function submitPasswordReset(challengeId, code, newPassword) {
    const res = await authApi.resetPassword(challengeId, code, newPassword)
    if (!res.ok) return { ok: false, error: res.error }
    return { ok: true }
  }

  async function submitPasswordChange(currentPassword, newPassword) {
    const res = await authApi.changePassword(currentPassword, newPassword)
    if (!res.ok) return { ok: false, error: res.error }
    setUser((u) => (u ? { ...u, mustChangePassword: false } : u))
    return { ok: true }
  }

  async function signOut() {
    await authApi.logout()
    setUser(null)
    setLocked(false)
  }

  return (
    <AuthContext.Provider
      value={{
        user,
        loading,
        locked,
        submitCredentials,
        submitCode,
        requestReauthCode,
        submitReauthCode,
        requestPasswordReset,
        submitPasswordReset,
        submitPasswordChange,
        signOut,
      }}
    >
      {children}
    </AuthContext.Provider>
  )
}

export function useAuth() {
  return useContext(AuthContext)
}
