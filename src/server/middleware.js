import jwt from 'jsonwebtoken'
import { ensureAccount, getLinkedGroup } from './db/accounts.js'

const JWT_SECRET = process.env.JWT_SECRET
if (!JWT_SECRET || JWT_SECRET.length < 32) {
  console.error('❌ JWT_SECRET must be set to a value of at least 32 characters. Refusing to start with a missing or weak secret.')
  process.exit(1)
}

// Supabase Auth signs access tokens (HS256) with the project JWT secret.
// When set, the dashboard authenticates account-based; the legacy phone-OTP
// relay_session cookie remains accepted as a fallback during migration.
const SUPABASE_JWT_SECRET = process.env.SUPABASE_JWT_SECRET
if (!SUPABASE_JWT_SECRET) {
  console.warn('⚠️ SUPABASE_JWT_SECRET is not set — account-based login is disabled; only legacy phone-OTP sessions will work.')
}

function extractToken(req) {
  const cookieStr = req.headers.cookie || ''
  const cookies = Object.fromEntries(
    cookieStr.split(';').map(c => {
      const [k, ...v] = c.trim().split('=')
      return [k, v.join('=')]
    }).filter(([k]) => k)
  )
  return req.headers.authorization?.replace('Bearer ', '')
    || cookies.relay_session
    || cookies['sb-access-token']
    || null
}

export async function requireAuth(req, res, next) {
  const token = extractToken(req)
  if (!token) {
    return res.status(401).json({ error: 'Not authenticated' })
  }

  // 1. Account-based (Supabase Auth) — preferred.
  if (SUPABASE_JWT_SECRET) {
    try {
      const payload = jwt.verify(token, SUPABASE_JWT_SECRET)
      const authId = payload.sub
      const email = payload.email || payload.user_metadata?.email || null
      const account = await ensureAccount(authId, email)
      const group = account ? await getLinkedGroup(account.id) : null
      req.manager = {
        authType: 'account',
        accountId: authId,
        userId: authId,
        email,
        groupId: group?.group_id ?? null,
        restaurantName: group?.group_name || account?.business_name || 'Your Restaurant',
      }
      return next()
    } catch (e) {
      // Not a Supabase token — fall through to legacy verification.
    }
  }

  // 2. Legacy phone-OTP session (relay_session cookie, signed with JWT_SECRET).
  try {
    const payload = jwt.verify(token, JWT_SECRET)
    req.manager = { authType: 'legacy', ...payload }
    return next()
  } catch (e) {
    return res.status(401).json({ error: 'Session expired — please log in again' })
  }
}

export function signToken(payload) {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: '7d' })
}

export function setCookieHeader(res, token) {
  res.setHeader('Set-Cookie',
    `relay_session=${token}; ` +
    `HttpOnly; Secure; SameSite=Lax; ` +
    `Path=/; Max-Age=${7 * 24 * 60 * 60}`)
}
