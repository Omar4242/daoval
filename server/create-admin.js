// Bootstraps the first administrator account. Run this once, directly on the server —
// there's no other way to create the first admin, since the admin UI itself requires
// being signed in as an administrator already.
//
// Usage: read the password with bash's own (reliable) hidden-input support, then pass
// everything as environment variables — this avoids custom raw-mode terminal code,
// which turned out to behave unpredictably across nested TTYs (SSH -> docker exec -it
// -> Node).
//
//   read -s -p "Password (min 12 chars): " ADMIN_PASSWORD; echo
//   docker compose exec -T \
//     -e ADMIN_EMAIL="you@example.com" \
//     -e ADMIN_NAME="Your Name" \
//     -e ADMIN_PASSWORD="$ADMIN_PASSWORD" \
//     backend node server/create-admin.js
//
// (-T, not -it — no terminal needed since nothing here reads interactive input.)

import { pool, migrate } from './db.js'
import { hashPassword, findUserByEmail, createUser } from './authService.js'

async function main() {
  const email = (process.env.ADMIN_EMAIL || '').trim().toLowerCase()
  const name = (process.env.ADMIN_NAME || '').trim()
  const password = process.env.ADMIN_PASSWORD || ''

  if (!email || !name || !password) {
    console.error('Missing ADMIN_EMAIL, ADMIN_NAME, or ADMIN_PASSWORD. See the usage comment at the top of this file.')
    process.exit(1)
  }
  if (!email.includes('@')) {
    console.error('ADMIN_EMAIL does not look like a valid email address.')
    process.exit(1)
  }
  if (password.length < 12) {
    console.error('ADMIN_PASSWORD must be at least 12 characters.')
    process.exit(1)
  }

  await migrate()

  if (await findUserByEmail(email)) {
    console.error(`An account with ${email} already exists.`)
    process.exit(1)
  }

  const passwordHash = await hashPassword(password)
  const user = await createUser({ email, name, role: 'administrator', passwordHash })

  console.log(`Administrator account created: ${user.email} (${user.id})`)
  console.log('Sign in at the app with this email and password — MFA will email (or log, in dev mode) a code to the same address.')

  await pool.end()
  process.exit(0)
}

main().catch((err) => {
  console.error('Failed to create administrator:', err)
  process.exit(1)
})
