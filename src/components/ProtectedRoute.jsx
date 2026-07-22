import { Navigate } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import ReauthModal from './ReauthModal'

export default function ProtectedRoute({ children, requireRole }) {
  const { user, loading, locked } = useAuth()

  // Still checking the session cookie against the server — render nothing rather
  // than flashing a sign-in redirect for a split second on every page load.
  if (loading) return null

  if (!user) return <Navigate to="/sign-in" replace />

  if (requireRole && user.role !== requireRole) {
    // Signed in, but the wrong role for this route — send them to their own
    // landing page rather than a dead end.
    return <Navigate to={user.role === 'administrator' ? '/admin/users' : '/dashboard'} replace />
  }

  return (
    <>
      {children}
      {locked && <ReauthModal />}
    </>
  )
}
