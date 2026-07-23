// Daoval FHIR-ish REST backend, now Postgres-backed (see db.js / store.js). Same wire
// surface as the original demo server so nothing in src/services/fhirClient.js needs
// to change: GET /metadata, POST/GET/PUT on /:resourceType[/:id], GET search with
// query params, and POST transaction Bundles at the base path.

import { createServer } from 'http'
import * as store from './store.js'
import { logAccess, pool } from './db.js'
import * as auth from './authService.js'

const PORT = Number(process.env.PORT) || 3001
const BASE_PATH = '/fhir'
// In production this must be your real frontend origin (e.g. https://app.daoval.com).
// Can't default to '*' anymore now that /fhir/* requires the session cookie —
// browsers refuse 'Access-Control-Allow-Origin: *' together with credentialed
// requests. Defaults to the Vite dev server's origin for local `npm run dev`.
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || 'http://localhost:5173'

await store.load()
await store.seedIfEmpty()

// In-memory login throttle: 8 failed password attempts per email within 15 minutes.
// Single-process only (fine for one small instance) — resets on deploy/restart.
const failedLogins = new Map() // email -> [timestamps]
const LOGIN_WINDOW_MS = 15 * 60 * 1000
const MAX_FAILED_LOGINS = 8

function isLoginThrottled(email) {
  const attempts = (failedLogins.get(email) || []).filter((t) => Date.now() - t < LOGIN_WINDOW_MS)
  failedLogins.set(email, attempts)
  return attempts.length >= MAX_FAILED_LOGINS
}

function recordFailedLogin(email) {
  const attempts = failedLogins.get(email) || []
  attempts.push(Date.now())
  failedLogins.set(email, attempts)
}

function clearFailedLogins(email) {
  failedLogins.delete(email)
}

function send(res, status, body, extraHeaders = {}, contentType = 'application/fhir+json') {
  const payload = body == null ? '' : JSON.stringify(body)
  res.writeHead(status, {
    'Content-Type': contentType,
    // Credentialed requests (the session cookie) can't use '*' — browsers reject that
    // combination. ALLOWED_ORIGIN must be a real origin in any deployment that isn't
    // same-origin-via-Caddy (see .env.production.example).
    'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
    'Access-Control-Allow-Credentials': 'true',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Tenant-Id',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    // Baseline hardening. None of these are HIPAA-specific by themselves, but there's
    // no reason not to have them on an API that will carry PHI.
    'X-Content-Type-Options': 'nosniff',
    'Strict-Transport-Security': 'max-age=63072000; includeSubDomains',
    ...extraHeaders,
  })
  res.end(payload)
}

function operationOutcome(status, message) {
  return {
    resourceType: 'OperationOutcome',
    issue: [{ severity: 'error', code: String(status), diagnostics: message }],
  }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = ''
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      // 5MB cap — generous for a clinical encounter bundle, small enough to blunt a
      // naive request-flooding attempt against an internet-facing endpoint.
      if (size > 5 * 1024 * 1024) {
        reject(new Error('Request body too large'))
        req.destroy()
        return
      }
      data += chunk
    })
    req.on('end', () => {
      if (!data) return resolve(null)
      try {
        resolve(JSON.parse(data))
      } catch (e) {
        reject(e)
      }
    })
    req.on('error', reject)
  })
}

function capabilityStatement() {
  return {
    resourceType: 'CapabilityStatement',
    status: 'active',
    date: new Date().toISOString(),
    kind: 'instance',
    fhirVersion: '4.0.1',
    format: ['application/fhir+json'],
    software: { name: 'daoval-server', version: '2.0.0' },
    rest: [{ mode: 'server' }],
  }
}

async function processTransactionBundle(bundle) {
  const idMap = {}
  const responseEntries = []
  for (const entry of bundle.entry) {
    const method = entry.request?.method || 'POST'
    const url = entry.request?.url || ''
    const [resourceType, idFromUrl] = url.split('/')
    let resource = rewriteReferences(entry.resource, idMap)

    let saved
    if (method === 'PUT' && idFromUrl) {
      saved = await store.updateResource(resourceType, idFromUrl, resource)
    } else {
      saved = await store.createResource(resourceType, resource)
    }

    if (entry.fullUrl) idMap[entry.fullUrl] = saved.id
    if (resource?.id && resource.id !== saved.id) idMap[resource.id] = saved.id

    responseEntries.push({
      response: {
        status: method === 'PUT' ? '200 OK' : '201 Created',
        location: `${resourceType}/${saved.id}`,
      },
      resource: saved,
    })
  }
  return { resourceType: 'Bundle', type: 'transaction-response', entry: responseEntries }
}

function rewriteReferences(resource, idMap) {
  if (!resource || typeof resource !== 'object') return resource
  const json = JSON.stringify(resource)
  const rewritten = json.replace(/"reference":"([^"]+)"/g, (match, ref) => {
    const cleaned = ref.replace('urn:uuid:', '')
    const mapped = Object.entries(idMap).find(([k]) => k === ref || k.endsWith(cleaned))
    if (mapped) return `"reference":"${mapped[1] === undefined ? ref : mapped[1]}"`
    return match
  })
  return JSON.parse(rewritten)
}

const server = createServer(async (req, res) => {
  const remoteAddr = req.socket.remoteAddress
  let status = 500
  let currentUser = null // set once a /fhir/* request passes the session check below

  const finish = (code, body, extraHeaders, contentType) => {
    status = code
    send(res, code, body, extraHeaders, contentType)
  }

  try {
    if (req.method === 'OPTIONS') {
      status = 204
      return send(res, 204, null)
    }

    const url = new URL(req.url, `http://${req.headers.host}`)

    if (url.pathname === '/healthz') {
      // Not under BASE_PATH on purpose — load balancer / container health checks
      // shouldn't require going through the FHIR route table.
      await pool.query('SELECT 1')
      status = 200
      return send(res, 200, { status: 'ok' })
    }

    // ---- /auth/* : real login, email MFA, sessions, admin user management ----
    if (url.pathname.startsWith('/auth/')) {
      const authPath = url.pathname.slice('/auth/'.length)

      if (req.method === 'POST' && authPath === 'login') {
        const body = await readBody(req)
        const email = (body?.email || '').trim().toLowerCase()
        const password = body?.password || ''

        if (isLoginThrottled(email)) {
          return finish(429, { error: 'Too many attempts. Try again in 15 minutes.' })
        }

        const user = await auth.findUserByEmailAny(email)
        const validPassword = user ? await auth.verifyPasswordHash(password, user.password_hash) : false
        if (!user || !validPassword) {
          recordFailedLogin(email)
          // Same error whether the email doesn't exist or the password is wrong —
          // don't leak which accounts exist.
          return finish(401, { error: 'Incorrect email or password.' })
        }
        if (!user.active) {
          // Correct password, but the account has been suspended by an administrator.
          // This intentionally does NOT count as a failed login attempt (the password
          // was right) and does NOT send an OTP — a suspended account should never
          // reach the MFA step.
          return finish(403, { error: 'The account is suspended, contact IT for more information.' })
        }
        // Note: this blocks new sign-ins immediately. It does NOT revoke a session
        // token issued before the suspension — sessions are self-contained JWTs (see
        // authService.js), so an already-signed-in suspended user keeps working until
        // that token's normal 12h expiry. Flagged in the write-up below.
        clearFailedLogins(email)

        const { challengeId, code } = await auth.createChallenge(user.id, 'login')
        await auth.sendOtpEmail(user.email, code)
        return finish(200, { challengeId })
      }

      if (req.method === 'POST' && authPath === 'verify') {
        const body = await readBody(req)
        const result = await auth.verifyChallenge(body?.challengeId, body?.code || '', 'login')
        if (!result.ok) return finish(401, { error: result.error })

        const user = await auth.findUserById(result.userId)
        if (!user) return finish(401, { error: 'Account no longer active.' })

        const token = auth.signSession(user)
        return finish(
          200,
          {
            user: {
              id: user.id,
              name: user.name,
              email: user.email,
              role: user.role,
              department: user.department,
              organization: user.organization,
              mustChangePassword: user.force_password_change,
            },
          },
          { 'Set-Cookie': auth.sessionCookie(token) }
        )
      }

      if (req.method === 'POST' && authPath === 'change-password') {
        const current = auth.getUserFromRequest(req)
        if (!current) return finish(401, { error: 'Not signed in.' })
        const body = await readBody(req)
        const currentPassword = body?.currentPassword || ''
        const newPassword = body?.newPassword || ''

        const user = await auth.findUserById(current.id)
        if (!user) return finish(401, { error: 'Account no longer active.' })

        const validCurrent = await auth.verifyPasswordHash(currentPassword, user.password_hash)
        if (!validCurrent) return finish(401, { error: 'Current password is incorrect.' })
        if (newPassword.length < 12) return finish(400, { error: 'New password must be at least 12 characters.' })
        if (newPassword === currentPassword) {
          return finish(400, { error: 'New password must be different from the current one.' })
        }

        const newHash = await auth.hashPassword(newPassword)
        await auth.updatePassword(user.id, newHash)

        // Refresh the session so forcePasswordChange flips to false immediately,
        // without requiring the person to log out and back in.
        const refreshed = await auth.findUserById(user.id)
        const token = auth.signSession(refreshed)
        return finish(200, { ok: true }, { 'Set-Cookie': auth.sessionCookie(token) })
      }

      if (req.method === 'POST' && authPath === 'reauth/request') {
        const current = auth.getUserFromRequest(req)
        if (!current) return finish(401, { error: 'Not signed in.' })
        const { challengeId, code } = await auth.createChallenge(current.id, 'reauth')
        await auth.sendOtpEmail(current.email, code)
        return finish(200, { challengeId })
      }

      if (req.method === 'POST' && authPath === 'reauth/verify') {
        const current = auth.getUserFromRequest(req)
        if (!current) return finish(401, { error: 'Not signed in.' })
        const body = await readBody(req)
        const result = await auth.verifyChallenge(body?.challengeId, body?.code || '', 'reauth')
        if (!result.ok) return finish(401, { error: result.error })
        // A reauth challenge must belong to the person currently holding this
        // session — otherwise anyone who learns another user's challengeId+code
        // (e.g. a shared workstation, a leaked link) could use it to clear their
        // own idle-lock instead of that user's.
        if (result.userId !== current.id) return finish(401, { error: 'Code expired or invalid. Request a new one.' })
        // Refresh the session so the 12h expiry doesn't creep up on someone mid-shift.
        const user = await auth.findUserById(current.id)
        const token = auth.signSession(user)
        return finish(200, { ok: true }, { 'Set-Cookie': auth.sessionCookie(token) })
      }

      if (req.method === 'POST' && authPath === 'logout') {
        return finish(200, { ok: true }, { 'Set-Cookie': auth.clearSessionCookie() })
      }

      if (req.method === 'GET' && authPath === 'me') {
        const current = auth.getUserFromRequest(req)
        if (!current) return finish(401, { error: 'Not signed in.' })
        return finish(200, { user: current })
      }

      // ---- administrator-only: provision doctor/nurse/administrator accounts ----
      if (authPath === 'admin/users' || /^admin\/users\/[^/]+\/status$/.test(authPath)) {
        const current = auth.getUserFromRequest(req)
        if (!current) return finish(401, { error: 'Not signed in.' })
        const stillActive = await auth.findUserById(current.id)
        if (!stillActive) return finish(403, { error: 'This account is no longer active.' })
        if (current.role !== 'administrator') return finish(403, { error: 'Administrator access required.' })

        if (req.method === 'GET' && authPath === 'admin/users') {
          return finish(200, { users: await auth.listUsers(current.organization) })
        }

        if (req.method === 'POST' && authPath === 'admin/users') {
          const body = await readBody(req)
          const email = (body?.email || '').trim().toLowerCase()
          const name = (body?.name || '').trim()
          const role = body?.role
          const department = (body?.department || '').trim() || null

          const tempPassword = body?.tempPassword || ''

          if (!email || !name) return finish(400, { error: 'Email and name are required.' })
          if (!['administrator', 'doctor', 'nurse', 'technician'].includes(role)) {
            return finish(400, { error: 'Role must be administrator, doctor, nurse, or technician.' })
          }
          if (role !== 'administrator' && !department) {
            return finish(400, { error: 'Department is required for doctor, nurse, and technician accounts.' })
          }
          if (tempPassword.length < 12) {
            return finish(400, { error: 'Temporary password must be at least 12 characters.' })
          }

          // Doctors, nurses, and technicians always belong to the same
          // hospital/clinic/healthcare center as the administrator creating them —
          // never client-supplied. A new administrator account, though, may be
          // standing up a *different* organization (e.g. onboarding another
          // facility), so that one case requires an explicit name instead.
          let organization
          if (role === 'administrator') {
            organization = (body?.organization || '').trim()
            if (!organization) {
              return finish(400, { error: 'Hospital/clinic/healthcare center name is required for administrator accounts.' })
            }
          } else {
            organization = current.organization
          }

          if (await auth.findUserByEmailAny(email)) {
            return finish(409, { error: 'An account with that email already exists.' })
          }

          const passwordHash = await auth.hashPassword(tempPassword)
          const created = await auth.createUser({ email, name, role, passwordHash, department, organization })
          return finish(201, { user: created })
        }

        // ---- suspend / reinstate a provisioned account ----
        const statusMatch = authPath.match(/^admin\/users\/([^/]+)\/status$/)
        if (statusMatch && req.method === 'POST') {
          const targetId = statusMatch[1]
          const body = await readBody(req)
          const active = !!body?.active

          if (targetId === current.id) {
            return finish(400, { error: "You can't suspend your own account." })
          }

          const target = await auth.findUserByIdAny(targetId)
          if (!target || target.organization !== current.organization) {
            return finish(404, { error: 'No such account.' })
          }

          const updated = await auth.setUserActive(targetId, active)
          return finish(200, { user: updated })
        }
      }
      return finish(404, { error: 'No route matched.' })
    }

    if (!url.pathname.startsWith(BASE_PATH)) {
      return finish(404, operationOutcome(404, `Unknown path. This server is mounted at ${BASE_PATH}`))
    }

    // ---- everything under /fhir/* carries PHI: require a valid session for all of
    // it, including the metadata/capability check. Only /healthz and /auth/* (handled
    // above) are reachable without one. ----
    const current = auth.getUserFromRequest(req)
    if (!current) {
      return finish(401, operationOutcome(401, 'Authentication required.'))
    }
    // Sessions are self-contained JWTs (see authService.js) that are trusted as-is
    // for most fields, but active status is checked fresh against the DB on every
    // PHI-carrying request specifically so a suspension takes effect immediately
    // instead of waiting out the token's normal expiry.
    const stillActive = await auth.findUserById(current.id)
    if (!stillActive) {
      return finish(403, operationOutcome(403, 'This account is no longer active.'))
    }
    if (current.forcePasswordChange) {
      // The frontend already redirects to /change-password, but that's a UX
      // convenience, not the actual enforcement — someone could otherwise call the
      // API directly with a valid session cookie from a temp-password account and
      // never be forced through the change. This is the real boundary.
      return finish(403, operationOutcome(403, 'Password must be changed before accessing patient data.'))
    }
    if (current.role === 'administrator') {
      // Administrators manage staff accounts, not clinical/patient data. Enforced
      // here (not just hidden in the UI) so a direct API call can't reach patient
      // records with an administrator session either.
      return finish(403, operationOutcome(403, 'Administrator accounts do not have access to patient records.'))
    }
    currentUser = current

    const rest = url.pathname.slice(BASE_PATH.length).replace(/^\/+/, '')
    const segments = rest.split('/').filter(Boolean)

    if (req.method === 'GET' && segments[0] === 'metadata') {
      return finish(200, capabilityStatement())
    }

    if (req.method === 'POST' && segments.length === 0) {
      const body = await readBody(req)
      if (body?.resourceType === 'Bundle') {
        return finish(200, await processTransactionBundle(body))
      }
      return finish(400, operationOutcome(400, 'Expected a transaction Bundle at the base URL.'))
    }

    const [resourceType, id] = segments

    if (req.method === 'POST' && resourceType && !id) {
      const body = await readBody(req)
      const saved = await store.createResource(resourceType, body || {})
      return finish(201, saved, { Location: `${resourceType}/${saved.id}` })
    }

    if (req.method === 'PUT' && resourceType && id) {
      const body = await readBody(req)
      const saved = await store.updateResource(resourceType, id, body || {})
      return finish(200, saved)
    }

    if (req.method === 'GET' && resourceType && id) {
      const found = await store.readResource(resourceType, id)
      if (!found) return finish(404, operationOutcome(404, `${resourceType}/${id} not found`))
      return finish(200, found)
    }

    if (req.method === 'GET' && resourceType && !id) {
      const params = Object.fromEntries(url.searchParams.entries())
      const results = await store.searchResources(resourceType, params)
      return finish(200, {
        resourceType: 'Bundle',
        type: 'searchset',
        total: results.length,
        entry: results.map((r) => ({ fullUrl: `${resourceType}/${r.id}`, resource: r })),
      })
    }

    return finish(404, operationOutcome(404, 'No route matched.'))
  } catch (e) {
    console.error(e)
    finish(500, operationOutcome(500, e.message || 'Internal error'))
  } finally {
    // Fire-and-forget: never let audit logging block or fail the response.
    logAccess({ method: req.method, path: req.url, status, remoteAddr, userRef: currentUser?.id || null }).catch(() => {})
  }
})

server.listen(PORT, () => {
  console.log(
    `daoval-server: listening internally on :${PORT} (not public — reached via Caddy at ${BASE_PATH}/* and /auth/*)`
  )
})

process.on('SIGTERM', () => {
  server.close(() => pool.end().then(() => process.exit(0)))
})
