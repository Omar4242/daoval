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

// The facility directory: who and where, never what happened to a patient. These are
// the only resource types an administrator may touch under /fhir/*, and the only ones
// a clinician may not write. Deliberately an exact allowlist rather than a "not
// clinical" heuristic, so adding a new resource type never silently widens either
// role's access.
//
// TRIPWIRE: PractitionerRole is not here yet, so administrators are currently refused
// it and clinicians can write it. Add it to this set when PractitionerRole lands, or
// admins will not be able to manage the resource that links practitioners to
// departments.
const DIRECTORY_RESOURCE_TYPES = new Set(['Organization', 'Location', 'Practitioner'])

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

// Separate throttle for forgot-password requests: same shape as the login throttle,
// but on its own map/limit so someone hammering "forgot password" for an email
// address can't also lock that person out of signing in (and vice versa).
const resetRequests = new Map() // email -> [timestamps]
const RESET_WINDOW_MS = 15 * 60 * 1000
const MAX_RESET_REQUESTS = 5

function isResetThrottled(email) {
  const attempts = (resetRequests.get(email) || []).filter((t) => Date.now() - t < RESET_WINDOW_MS)
  resetRequests.set(email, attempts)
  return attempts.length >= MAX_RESET_REQUESTS
}

function recordResetRequest(email) {
  const attempts = resetRequests.get(email) || []
  attempts.push(Date.now())
  resetRequests.set(email, attempts)
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

// Where an Encounter happened, resolved from the authenticated user's database row.
//
// Deliberately not read from the session token. location_id postdates every session
// issued before this branch, and sessions last 12 hours, so tokens in flight across a
// deploy simply do not carry it. userRow is the row already fetched for the suspension
// check on every /fhir/* request, so this adds no user query, only a Location read, and
// not even that for an account with no linked Location.
async function resolveFacility(userRow) {
  const locationId = userRow?.location_id
  if (!locationId) return null
  const location = await store.readResource('Location', locationId)
  return {
    locationReference: `Location/${locationId}`,
    organizationReference: location?.managingOrganization?.reference || null,
  }
}

// Stamps an Encounter with the facility it happened at, from the server's own view of
// who is writing it. The client never gets a say.
//
// Unconditional overwrite, not fill-when-absent: whatever the client sent for these two
// fields is deleted before anything is written. Filling only blanks would leave a
// doctored request free to supply its own serviceProvider, which is forgeable
// attribution with an extra step rather than a fix. This is the counterpart to
// buildEncounterResource on the client, which deliberately does not set either field.
//
// When the writer has no linked Location the fields are removed entirely rather than
// written empty or with a placeholder. A dangling Organization/undefined would be worse
// than an absent field: it reads as a resolvable reference and fails later, at read
// time, far from the cause. An absent field is honestly absent.
function applyFacilityStamp(resource, facility) {
  if (!resource || typeof resource !== 'object') return resource
  delete resource.serviceProvider
  delete resource.location
  if (!facility) return resource
  if (facility.organizationReference) {
    resource.serviceProvider = { reference: facility.organizationReference }
  }
  resource.location = [{ location: { reference: facility.locationReference } }]
  return resource
}

async function processTransactionBundle(bundle, facility) {
  const idMap = {}
  const responseEntries = []
  for (const entry of bundle.entry) {
    const method = entry.request?.method || 'POST'
    const url = entry.request?.url || ''
    const [resourceType, idFromUrl] = url.split('/')
    let resource = rewriteReferences(entry.resource, idMap)
    if (resource?.resourceType === 'Encounter' || resourceType === 'Encounter') {
      applyFacilityStamp(resource, facility)
    }

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

      if (req.method === 'POST' && authPath === 'forgot-password') {
        const body = await readBody(req)
        const email = (body?.email || '').trim().toLowerCase()

        if (email && isResetThrottled(email)) {
          // Same generic response as success — a throttle message would itself leak
          // that this email is being hammered/exists. The person just waits and
          // tries again; nothing distinguishes this from the happy path below.
          return finish(200, { ok: true })
        }
        if (email) recordResetRequest(email)

        // Always respond 200/ok, whether or not an account exists, is active, or the
        // email is malformed — this endpoint must never let a caller learn which
        // emails have accounts. The actual email (if any) is fire-and-forget from
        // the caller's point of view.
        const user = email ? await auth.findUserByEmail(email) : null
        if (user) {
          const { challengeId, code } = await auth.createChallenge(user.id, 'reset')
          await auth.sendPasswordResetEmail(user.email, code)
          return finish(200, { ok: true, challengeId })
        }
        return finish(200, { ok: true })
      }

      if (req.method === 'POST' && authPath === 'reset-password') {
        const body = await readBody(req)
        const newPassword = body?.newPassword || ''
        if (newPassword.length < 12) {
          return finish(400, { error: 'New password must be at least 12 characters.' })
        }

        const result = await auth.verifyChallenge(body?.challengeId, body?.code || '', 'reset')
        if (!result.ok) return finish(401, { error: result.error })

        const user = await auth.findUserById(result.userId)
        if (!user) return finish(401, { error: 'Account no longer active.' })

        const newHash = await auth.hashPassword(newPassword)
        await auth.updatePassword(user.id, newHash)
        // Deliberately does NOT sign the person in — this request only proved control
        // of the account's email inbox, not physical presence at a device that should
        // get a live session, and a forgot-password flow is exactly the scenario where
        // that distinction matters (e.g. a reset requested from a different machine
        // than the one that will actually be used to sign in).
        return finish(200, { ok: true })
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
      if (
        authPath === 'admin/users' ||
        authPath === 'admin/organization' ||
        /^admin\/users\/[^/]+\/status$/.test(authPath)
      ) {
        const current = auth.getUserFromRequest(req)
        if (!current) return finish(401, { error: 'Not signed in.' })
        const stillActive = await auth.findUserById(current.id)
        if (!stillActive) return finish(403, { error: 'This account is no longer active.' })
        if (current.role !== 'administrator') return finish(403, { error: 'Administrator access required.' })

        if (req.method === 'GET' && authPath === 'admin/users') {
          return finish(200, { users: await auth.listUsers(current.organization) })
        }

        // ---- which Organization resource this administrator has claimed ----
        //
        // The claim is how an account is tied to a facility. There is deliberately no
        // automatic match from the free-text users.organization string: two different
        // facilities can share a name, and silently merging them would be far worse
        // than asking once. The administrator confirms explicitly, and that
        // confirmation is the join.
        if (req.method === 'GET' && authPath === 'admin/organization') {
          return finish(200, { organizationId: await auth.getClaimedOrganizationId(current.id) })
        }

        if (req.method === 'POST' && authPath === 'admin/organization') {
          const body = await readBody(req)
          const organizationId = (body?.organizationId || '').trim()
          if (!organizationId) return finish(400, { error: 'An organization id is required.' })

          // The Organization resource itself is created through POST /fhir/Organization
          // before this is called, so this only ever records a reference to one that
          // already exists. Nothing here creates or edits a resource.
          const existing = await store.readResource('Organization', organizationId)
          if (!existing) return finish(404, { error: 'No such organization.' })

          const claimed = await auth.claimOrganization(current.id, organizationId)
          return finish(200, { organizationId: claimed })
        }

        if (req.method === 'POST' && authPath === 'admin/users') {
          const body = await readBody(req)
          const email = (body?.email || '').trim().toLowerCase()
          const name = (body?.name || '').trim()
          const role = body?.role
          const locationId = (body?.locationId || '').trim() || null

          const tempPassword = body?.tempPassword || ''

          if (!email || !name) return finish(400, { error: 'Email and name are required.' })
          if (!['administrator', 'doctor', 'nurse', 'technician'].includes(role)) {
            return finish(400, { error: 'Role must be administrator, doctor, nurse, or technician.' })
          }

          // Departments are Location resources now, so a new account references one
          // instead of carrying a free-text string. The Location has to belong to the
          // facility this administrator claimed, otherwise an administrator at one
          // hospital could attach staff to another hospital's department. The old
          // free-text department column is left NULL on everything created from here.
          if (role !== 'administrator') {
            if (!locationId) {
              return finish(400, { error: 'A department is required for doctor, nurse, and technician accounts.' })
            }
            const claimedOrganizationId = await auth.getClaimedOrganizationId(current.id)
            if (!claimedOrganizationId) {
              return finish(400, { error: 'Set up your facility and its departments before adding staff.' })
            }
            const location = await store.readResource('Location', locationId)
            if (location?.managingOrganization?.reference !== `Organization/${claimedOrganizationId}`) {
              return finish(400, { error: 'That department is not part of your facility.' })
            }
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
          const created = await auth.createUser({ email, name, role, passwordHash, locationId, organization })
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
    const rest = url.pathname.slice(BASE_PATH.length).replace(/^\/+/, '')
    const segments = rest.split('/').filter(Boolean)
    const [resourceType, id] = segments

    // The role checks below need to know which resource type is being addressed, so
    // the path is parsed first. Nothing has been read from the database at this point.
    const isMetadata = req.method === 'GET' && segments[0] === 'metadata'
    const isDirectory = DIRECTORY_RESOURCE_TYPES.has(resourceType)
    const isWrite = req.method === 'POST' || req.method === 'PUT' || req.method === 'DELETE'

    if (current.role === 'administrator') {
      // Administrators manage staff accounts and the facility directory, never
      // clinical/patient data. Enforced here (not just hidden in the UI) so a direct
      // API call can't reach patient records with an administrator session either.
      //
      // The allowlist is exact: anything that is not one of the three directory types
      // is refused, including a transaction Bundle at the base path. Bundles are
      // refused because segments is empty for them, so resourceType is undefined and
      // isDirectory is false. That matters: a Bundle can carry entries of any type, so
      // letting one through here would be a way around this check.
      if (!isMetadata && !isDirectory) {
        return finish(403, operationOutcome(403, 'Administrator accounts do not have access to patient records.'))
      }
    } else if (isDirectory && isWrite) {
      // Clinicians read the directory, because encounters need to reference the
      // organization and location they happened in, but they never edit it.
      return finish(403, operationOutcome(403, 'Directory resources are managed by administrators.'))
    }
    currentUser = current

    // Resolved lazily and at most once per request: only an Encounter write needs it,
    // and stillActive is the row already read above for the suspension check.
    let facilityCache
    const facility = async () => {
      if (facilityCache === undefined) facilityCache = await resolveFacility(stillActive)
      return facilityCache
    }

    if (isMetadata) {
      return finish(200, capabilityStatement())
    }

    if (req.method === 'POST' && segments.length === 0) {
      const body = await readBody(req)
      if (body?.resourceType === 'Bundle') {
        // Only clinicians reach this branch (administrators are refused above), and a
        // Bundle can carry any resource type, so the directory allowlist has to be
        // applied to its entries too. Without this, the clinician write ban above
        // could be sidestepped by wrapping a Location in an encounter Bundle.
        const bundleTypes = (body.entry || []).map(
          (e) => e.resource?.resourceType || (e.request?.url || '').split('/')[0]
        )
        if (bundleTypes.some((t) => DIRECTORY_RESOURCE_TYPES.has(t))) {
          return finish(403, operationOutcome(403, 'Directory resources are managed by administrators.'))
        }
        return finish(200, await processTransactionBundle(body, await facility()))
      }
      return finish(400, operationOutcome(400, 'Expected a transaction Bundle at the base URL.'))
    }

    if (req.method === 'POST' && resourceType && !id) {
      const body = await readBody(req)
      const resource = body || {}
      if (resourceType === 'Encounter') applyFacilityStamp(resource, await facility())
      const saved = await store.createResource(resourceType, resource)
      return finish(201, saved, { Location: `${resourceType}/${saved.id}` })
    }

    if (req.method === 'PUT' && resourceType && id) {
      const body = await readBody(req)
      const resource = body || {}
      if (resourceType === 'Encounter') applyFacilityStamp(resource, await facility())
      const saved = await store.updateResource(resourceType, id, resource)
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
