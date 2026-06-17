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

function parseCookies(req) {
  const cookieStr = req.headers.cookie || ''
  return Object.fromEntries(
    cookieStr.split(';').map(c => {
      const [k, ...v] = c.trim().split('=')
      return [k, v.join('=')]
    }).filter(([k]) => k)
  )
}

function extractToken(req) {
  const cookies = parseCookies(req)
  return req.headers.authorization?.replace('Bearer ', '')
    || cookies.relay_session
    || cookies['sb-access-token']
    || null
}

// Proof that the login confirmation code was entered this session. Signed with
// JWT_SECRET; the frontend also sends it as the x-relay-2fa header for
// cross-origin requests where the cookie may not ride along.
function readTwoFactor(req, accountId) {
  const token = req.headers['x-relay-2fa'] || parseCookies(req).relay_2fa
  if (!token) return false
  try {
    const payload = jwt.verify(token, JWT_SECRET)
    return payload.twofa === true && String(payload.accountId) === String(accountId)
  } catch {
    return false
  }
}

export function signTwoFactorToken(accountId) {
  return jwt.sign({ accountId, twofa: true }, JWT_SECRET, { expiresIn: '24h' })
}

// Session cookie (no Max-Age) so closing the browser forces re-verification next
// login, honoring "a code each login".
export function setTwoFactorCookie(res, token) {
  res.setHeader('Set-Cookie',
    `relay_2fa=${token}; HttpOnly; Secure; SameSite=Lax; Path=/`)
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
        // Login confirmation code (2FA). Default on; owners disable in Settings.
        twoFactorEnabled: account?.login_2fa_enabled !== false,
        twoFactorVerified: readTwoFactor(req, authId),
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
