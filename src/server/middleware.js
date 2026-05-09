import jwt from 'jsonwebtoken'

const JWT_SECRET = process.env.JWT_SECRET
if (!JWT_SECRET || JWT_SECRET.length < 32) {
  console.error('❌ JWT_SECRET must be set to a value of at least 32 characters. Refusing to start with a missing or weak secret.')
  process.exit(1)
}

export function requireAuth(req, res, next) {
  // Parse cookies manually to avoid needing cookie-parser on every route
  const cookieStr = req.headers.cookie || ''
  const cookies = Object.fromEntries(
    cookieStr.split(';').map(c => {
      const [k, ...v] = c.trim().split('=')
      return [k, v.join('=')]
    }).filter(([k]) => k)
  )
  const token = cookies.relay_session
    || req.headers.authorization?.replace('Bearer ', '')

  if (!token) {
    return res.status(401).json({ error: 'Not authenticated' })
  }

  try {
    const payload = jwt.verify(token, JWT_SECRET)
    req.manager = payload
    next()
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
