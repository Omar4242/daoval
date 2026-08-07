// Thin wrapper around the backend's /auth/* endpoints. credentials: 'include' is
// required on every call so the HttpOnly session cookie is sent/received — without
// it the browser silently drops the cookie and every request looks signed-out.

const AUTH_BASE = '/auth'

async function request(path, options = {}) {
  const res = await fetch(`${AUTH_BASE}/${path}`, {
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    ...options,
  })
  let body = null
  try {
    body = await res.json()
  } catch {
    // no body
  }
  if (!res.ok) {
    return { ok: false, status: res.status, error: body?.error || 'Something went wrong.' }
  }
  return { ok: true, ...body }
}

export function login(email, password) {
  return request('login', { method: 'POST', body: JSON.stringify({ email, password }) })
}

export function verifyCode(challengeId, code) {
  return request('verify', { method: 'POST', body: JSON.stringify({ challengeId, code }) })
}

export function requestReauth() {
  return request('reauth/request', { method: 'POST' })
}

export function verifyReauth(challengeId, code) {
  return request('reauth/verify', { method: 'POST', body: JSON.stringify({ challengeId, code }) })
}

export function forgotPassword(email) {
  return request('forgot-password', { method: 'POST', body: JSON.stringify({ email }) })
}

export function resetPassword(challengeId, code, newPassword) {
  return request('reset-password', { method: 'POST', body: JSON.stringify({ challengeId, code, newPassword }) })
}

export function changePassword(currentPassword, newPassword) {
  return request('change-password', { method: 'POST', body: JSON.stringify({ currentPassword, newPassword }) })
}

export function logout() {
  return request('logout', { method: 'POST' })
}

export function me() {
  return request('me', { method: 'GET' })
}

export function listAdminUsers() {
  return request('admin/users', { method: 'GET' })
}

export function createAdminUser({ email, name, role, locationId, organization, tempPassword }) {
  return request('admin/users', {
    method: 'POST',
    body: JSON.stringify({ email, name, role, locationId, organization, tempPassword }),
  })
}

export function getClaimedOrganization() {
  return request('admin/organization', { method: 'GET' })
}

export function claimOrganization(organizationId) {
  return request('admin/organization', {
    method: 'POST',
    body: JSON.stringify({ organizationId }),
  })
}

export function setUserStatus(userId, active) {
  return request(`admin/users/${userId}/status`, {
    method: 'POST',
    body: JSON.stringify({ active }),
  })
}
