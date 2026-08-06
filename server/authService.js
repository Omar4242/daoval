// Real authentication: bcrypt passwords, one-time email codes as MFA, JWT session
// cookies. Replaces the mock PROVISIONED_ACCOUNTS table that used to live in the
// frontend's AuthContext.jsx.

import bcrypt from 'bcryptjs'
import jwt from 'jsonwebtoken'
import crypto from 'crypto'
import nodemailer from 'nodemailer'
import { pool } from './db.js'

const JWT_SECRET = process.env.JWT_SECRET
if (!JWT_SECRET) {
  throw new Error('JWT_SECRET is not set. Generate one with: openssl rand -base64 48')
}

const SESSION_TTL = '12h'
const OTP_TTL_MS = 10 * 60 * 1000 // 10 minutes
const MAX_OTP_ATTEMPTS = 5

// Generic SMTP, not tied to one provider — works with Brevo's free tier (300
// emails/day, no time limit, no card required), or any other SMTP relay if that ever
// changes. Only constructed if SMTP_HOST is actually set (see sendOtpEmail below).
const SENDER_EMAIL = process.env.SMTP_FROM
let transporter = null
function getTransporter() {
  if (transporter) return transporter
  transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT) || 587,
    secure: false, // false = STARTTLS on 587, which Brevo and most providers expect
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  })
  return transporter
}

// ---------- passwords ----------

export async function hashPassword(plain) {
  return bcrypt.hash(plain, 12)
}

export async function verifyPasswordHash(plain, hash) {
  return bcrypt.compare(plain, hash)
}

// ---------- sessions (JWT in an HttpOnly cookie) ----------

export function signSession(user) {
  return jwt.sign(
    {
      sub: user.id,
      role: user.role,
      name: user.name,
      email: user.email,
      department: user.department || null,
      organization: user.organization || null,
      forcePasswordChange: !!user.force_password_change,
    },
    JWT_SECRET,
    { expiresIn: SESSION_TTL }
  )
}

export function verifySession(token) {
  try {
    return jwt.verify(token, JWT_SECRET)
  } catch {
    return null
  }
}

export function parseCookies(header) {
  const out = {}
  if (!header) return out
  header.split(';').forEach((part) => {
    const idx = part.indexOf('=')
    if (idx === -1) return
    const k = part.slice(0, idx).trim()
    const v = part.slice(idx + 1).trim()
    out[k] = decodeURIComponent(v)
  })
  return out
}

export function sessionCookie(token) {
  // Secure requires HTTPS, which is always true in this deployment (Caddy terminates
  // TLS in front of this service) — do not weaken this for local http-only testing;
  // use a separate .env for that instead.
  const maxAge = 12 * 60 * 60
  return `daoval_session=${token}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${maxAge}`
}

export function clearSessionCookie() {
  return `daoval_session=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0`
}

export function getUserFromRequest(req) {
  const cookies = parseCookies(req.headers.cookie)
  const token = cookies.daoval_session
  if (!token) return null
  const payload = verifySession(token)
  if (!payload) return null
  return {
    id: payload.sub,
    role: payload.role,
    name: payload.name,
    email: payload.email,
    department: payload.department,
    organization: payload.organization,
    forcePasswordChange: !!payload.forcePasswordChange,
  }
}

// ---------- one-time email codes ----------

function generateCode() {
  // 6-digit numeric, using crypto.randomInt so it's not Math.random()-predictable.
  return String(crypto.randomInt(0, 1000000)).padStart(6, '0')
}

function hashCode(code) {
  return crypto.createHash('sha256').update(code).digest('hex')
}

export async function createChallenge(userId, purpose) {
  const code = generateCode()
  const expiresAt = new Date(Date.now() + OTP_TTL_MS)
  const result = await pool.query(
    `INSERT INTO login_challenges (user_id, code_hash, purpose, expires_at)
     VALUES ($1, $2, $3, $4) RETURNING id`,
    [userId, hashCode(code), purpose, expiresAt]
  )
  return { challengeId: result.rows[0].id, code }
}

export async function verifyChallenge(challengeId, code, expectedPurpose) {
  const result = await pool.query(`SELECT * FROM login_challenges WHERE id = $1`, [challengeId])
  const challenge = result.rows[0]
  if (!challenge) return { ok: false, error: 'Code expired or invalid. Request a new one.' }
  // A login code must not be usable to satisfy a reauth prompt, and vice versa — the
  // two are different security boundaries (one asserts identity, the other asserts
  // "still you, mid-session") even though the challenge storage/verification
  // mechanics are shared. Without this check, whichever endpoint got called first
  // would silently accept a code that was emailed for the other purpose.
  if (expectedPurpose && challenge.purpose !== expectedPurpose) {
    return { ok: false, error: 'Code expired or invalid. Request a new one.' }
  }
  if (challenge.consumed) return { ok: false, error: 'This code was already used. Request a new one.' }
  if (new Date(challenge.expires_at) < new Date()) return { ok: false, error: 'Code expired. Request a new one.' }
  if (challenge.attempts >= MAX_OTP_ATTEMPTS) {
    return { ok: false, error: 'Too many attempts. Request a new code.' }
  }

  if (hashCode(code) !== challenge.code_hash) {
    await pool.query(`UPDATE login_challenges SET attempts = attempts + 1 WHERE id = $1`, [challengeId])
    return { ok: false, error: 'Incorrect code. Try again.' }
  }

  await pool.query(`UPDATE login_challenges SET consumed = true WHERE id = $1`, [challengeId])
  return { ok: true, userId: challenge.user_id }
}

// ---------- email delivery (AWS SES) ----------

export async function sendOtpEmail(toEmail, code) {
  if (!SENDER_EMAIL || !process.env.SMTP_HOST) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('SMTP_HOST/SMTP_FROM are not set — cannot send MFA codes.')
    }
    // Local/dev only: no email configured, so print the code instead of sending it.
    console.log(`[dev] MFA code for ${toEmail}: ${code}`)
    return
  }
  await getTransporter().sendMail({
    from: SENDER_EMAIL,
    to: toEmail,
    subject: 'Your Daoval sign-in code',
    text: `Your Daoval sign-in code is ${code}. It expires in 10 minutes. If you didn't request this, ignore this email.`,
  })
}

// Separate subject/copy from sendOtpEmail on purpose — this one is emailed to
// someone who (claims to) have lost their password, so it should never look
// identical to a routine sign-in code in an inbox, and it says plainly that no
// action is needed if the person didn't ask for this.
export async function sendPasswordResetEmail(toEmail, code) {
  if (!SENDER_EMAIL || !process.env.SMTP_HOST) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('SMTP_HOST/SMTP_FROM are not set — cannot send password reset codes.')
    }
    console.log(`[dev] Password reset code for ${toEmail}: ${code}`)
    return
  }
  await getTransporter().sendMail({
    from: SENDER_EMAIL,
    to: toEmail,
    subject: 'Reset your Daoval password',
    text: `Use this code to reset your Daoval password: ${code}. It expires in 10 minutes. If you didn't request a password reset, you can safely ignore this email — your password has not been changed.`,
  })
}

// ---------- users ----------

export async function findUserByEmail(email) {
  const res = await pool.query(`SELECT * FROM users WHERE email = $1 AND active = true`, [email])
  return res.rows[0] || null
}

// Unlike findUserByEmail, this does NOT filter on active — used only at the login
// step, so a correct password against a suspended account can be told apart from a
// wrong password (see POST /auth/login), rather than both looking like "no such
// account" the way findUserByEmail's active=true filter would make them look.
export async function findUserByEmailAny(email) {
  const res = await pool.query(`SELECT * FROM users WHERE email = $1`, [email])
  return res.rows[0] || null
}

export async function findUserById(id) {
  const res = await pool.query(`SELECT * FROM users WHERE id = $1 AND active = true`, [id])
  return res.rows[0] || null
}

export async function findUserByIdAny(id) {
  const res = await pool.query(`SELECT * FROM users WHERE id = $1`, [id])
  return res.rows[0] || null
}

export async function createUser({
  email,
  name,
  role,
  passwordHash,
  department = null,
  organization = null,
  forcePasswordChange = true,
}) {
  const res = await pool.query(
    `INSERT INTO users (email, name, role, password_hash, department, organization, force_password_change)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING id, email, name, role, department, organization, active, force_password_change, created_at`,
    [email, name, role, passwordHash, department, organization, forcePasswordChange]
  )
  return res.rows[0]
}

// Suspend or reinstate an account. Suspended accounts fail login with a distinct
// message (see POST /auth/login) rather than the generic bad-credentials error, and
// any existing session they're already holding stops working on their next request
// because getUserFromRequest's callers re-check the DB via findUserById /
// requireActiveUser, which both filter on active = true.
export async function setUserActive(userId, active) {
  const res = await pool.query(
    `UPDATE users SET active = $1 WHERE id = $2
     RETURNING id, email, name, role, department, organization, active, force_password_change, created_at`,
    [active, userId]
  )
  return res.rows[0] || null
}

export async function updatePassword(userId, newPasswordHash) {
  await pool.query(
    `UPDATE users SET password_hash = $1, force_password_change = false WHERE id = $2`,
    [newPasswordHash, userId]
  )
}

// ---------- organization claims ----------
//
// Reads and writes organization_admins only. Neither of these touches a users row: the
// free-text users.organization string is left exactly as it is, and no users column is
// written. See the table comment in db.js for why the two are kept separate.

export async function getClaimedOrganizationId(userId) {
  const res = await pool.query(`SELECT organization_id FROM organization_admins WHERE user_id = $1`, [userId])
  return res.rows[0]?.organization_id || null
}

// Idempotent on purpose. A double submit, a refresh, or a second attempt returns the
// claim that is already recorded rather than repointing it. Re-pointing an existing
// claim at a different facility is a correction, not a routine action, and it should
// be a deliberate separate step rather than something a stray click can do.
export async function claimOrganization(userId, organizationId) {
  await pool.query(
    `INSERT INTO organization_admins (user_id, organization_id)
     VALUES ($1, $2)
     ON CONFLICT (user_id) DO NOTHING`,
    [userId, organizationId]
  )
  return getClaimedOrganizationId(userId)
}

export async function listUsers(organization) {
  const res = await pool.query(
    `SELECT id, email, name, role, department, organization, active, created_at FROM users
     WHERE organization = $1
     ORDER BY created_at DESC`,
    [organization]
  )
  return res.rows
}
