import jwt from 'jsonwebtoken'
import crypto from 'crypto'
import { ensureAccount, getLinkedGroup } from './db/accounts.js'

const JWT_SECRET = process.env.JWT_SECRET
if (!JWT_SECRET || JWT_SECRET.length < 32) {
  console.error('❌ JWT_SECRET must be set to a value of at least 32 characters. Refusing to start with a missing or weak secret.')
  process.exit(1)
}

// Supabase Auth access tokens are verified two ways depending on the project:
//  - Modern projects sign with asymmetric keys (ES256/RS256) — verified against
//    the project's published JWKS (no shared secret needed).
//  - Legacy projects sign HS256 with the project JWT secret (SUPABASE_JWT_SECRET).
const SUPABASE_URL = process.env.SUPABASE_URL
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY
const SUPABASE_JWT_SECRET = process.env.SUPABASE_JWT_SECRET
if (!SUPABASE_URL && !SUPABASE_JWT_SECRET) {
  console.warn('⚠️ Neither SUPABASE_URL nor SUPABASE_JWT_SECRET is set — account-based login is disabled; only legacy phone-OTP sessions will work.')
}

// JWKS cache (public keys, keyed by kid). Refreshed hourly or on a kid miss.
let _jwks = null
let _jwksAt = 0
async function getJwks(force = false) {
  if (!force && _jwks && Date.now() - _jwksAt < 60 * 60 * 1000) return _jwks
  const res = await fetch(`${SUPABASE_URL}/auth/v1/.well-known/jwks.json`, {
    headers: SUPABASE_ANON_KEY ? { apikey: SUPABASE_ANON_KEY } : {},
  })
  const data = await res.json()
  const map = {}
  for (const k of data.keys || []) map[k.kid] = k
  _jwks = map
  _jwksAt = Date.now()
  return _jwks
}

async function pemForKid(kid) {
  let jwks = await getJwks()
  if (!jwks[kid]) jwks = await getJwks(true)  // key rotation — refresh once
  const jwk = jwks[kid]
  if (!jwk) return null
  return crypto.createPublicKey({ key: jwk, format: 'jwk' }).export({ type: 'spki', format: 'pem' })
}

// Verify a Supabase access token, routing on its alg. Exported for tests.
export async function verifySupabaseToken(token) {
  const decoded = jwt.decode(token, { complete: true })
  if (!decoded?.header) throw new Error('Malformed token')
  const alg = decoded.header.alg
  if (alg === 'HS256') {
    if (!SUPABASE_JWT_SECRET) throw new Error('No HS256 secret configured')
    return jwt.verify(token, SUPABASE_JWT_SECRET)
  }
  if (!SUPABASE_URL) throw new Error('SUPABASE_URL required for asymmetric token verification')
  const pem = await pemForKid(decoded.header.kid)
  if (!pem) throw new Error('No matching JWKS key')
  return jwt.verify(token, pem, { algorithms: ['ES256', 'RS256', 'EdDSA'] })
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
  if (SUPABASE_URL || SUPABASE_JWT_SECRET) {
    try {
      const payload = await verifySupabaseToken(token)
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
