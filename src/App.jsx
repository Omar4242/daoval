import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import { AuthProvider } from './context/AuthContext'
import { PatientProvider } from './context/PatientContext'
import ProtectedRoute from './components/ProtectedRoute'

import SignIn from './pages/SignIn'
import ForgotPassword from './pages/ForgotPassword'
import Landing from './pages/Landing'
import Dashboard from './pages/Dashboard'
import SearchResults from './pages/SearchResults'
import RegisterPatient from './pages/RegisterPatient'
import PatientProfile from './pages/PatientProfile'
import NewEncounter from './pages/NewEncounter'
import ReviewSign from './pages/ReviewSign'
import ViewAmend from './pages/ViewAmend'
import AdminUsers from './pages/admin/AdminUsers'
import ChangePassword from './pages/ChangePassword'
import { useAuth } from './context/AuthContext'

function landingFor(user) {
  if (user.mustChangePassword) return '/change-password'
  return user.role === 'administrator' ? '/admin/users' : '/dashboard'
}

// Root path: signed-out visitors see the marketing landing page; signed-in people
// skip straight past it to their own workspace (admin panel or clinical dashboard).
function Root() {
  const { user, loading } = useAuth()
  if (loading) return null
  if (!user) return <Landing />
  return <Navigate to={landingFor(user)} replace />
}

// Unknown paths (not the exact root) redirect straight to sign-in or the workspace —
// showing the marketing page for a typo'd URL would be a strange landing spot.
function NotFound() {
  const { user, loading } = useAuth()
  if (loading) return null
  if (!user) return <Navigate to="/sign-in" replace />
  return <Navigate to={landingFor(user)} replace />
}

export default function App() {
  return (
    <AuthProvider>
      <PatientProvider>
        <BrowserRouter>
          <Routes>
            <Route path="/sign-in" element={<SignIn />} />
            <Route path="/forgot-password" element={<ForgotPassword />} />
            <Route path="/dashboard" element={<ProtectedRoute><Dashboard /></ProtectedRoute>} />
            <Route path="/search" element={<ProtectedRoute><SearchResults /></ProtectedRoute>} />
            <Route path="/register" element={<ProtectedRoute><RegisterPatient /></ProtectedRoute>} />
            <Route path="/patient/:patientId" element={<ProtectedRoute><PatientProfile /></ProtectedRoute>} />
            <Route path="/patient/:patientId/encounter/new" element={<ProtectedRoute><NewEncounter /></ProtectedRoute>} />
            <Route path="/patient/:patientId/encounter/:encounterId" element={<ProtectedRoute><NewEncounter /></ProtectedRoute>} />
            <Route path="/patient/:patientId/encounter/:encounterId/review" element={<ProtectedRoute><ReviewSign /></ProtectedRoute>} />
            <Route path="/patient/:patientId/encounter/:encounterId/view" element={<ProtectedRoute><ViewAmend /></ProtectedRoute>} />
            <Route path="/admin/users" element={<ProtectedRoute requireRole="administrator"><AdminUsers /></ProtectedRoute>} />
            <Route
              path="/change-password"
              element={
                <ProtectedRoute allowPendingPasswordChange>
                  <ChangePassword />
                </ProtectedRoute>
              }
            />
            <Route path="/" element={<Root />} />
            <Route path="*" element={<NotFound />} />
          </Routes>
        </BrowserRouter>
      </PatientProvider>
    </AuthProvider>
  )
}
