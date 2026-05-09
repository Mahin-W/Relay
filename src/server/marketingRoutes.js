import express from 'express'

const router = express.Router()

// Simple in-memory IP rate limit: 5 submissions per 10 min per IP.
const recentByIp = new Map()
const WINDOW_MS = 10 * 60 * 1000
const MAX_PER_WINDOW = 5

function rateLimit(ip) {
  const now = Date.now()
  const arr = (recentByIp.get(ip) || []).filter(t => now - t < WINDOW_MS)
  if (arr.length >= MAX_PER_WINDOW) {
    recentByIp.set(ip, arr)
    return false
  }
  arr.push(now)
  recentByIp.set(ip, arr)
  return true
}

// POST /api/waitlist — proxies a single email submission to the GAS endpoint
// configured via the WAITLIST_GAS_URL env var. The URL is never returned to
// the client. Request body: { email }.
router.post('/waitlist', async (req, res) => {
  try {
    const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown')
      .toString().split(',')[0].trim()
    if (!rateLimit(ip)) return res.status(429).json({ error: 'Too many requests' })

    const email = (req.body?.email ?? '').toString().trim()
    if (!email || email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ error: 'Invalid email' })
    }

    const gasUrl = process.env.WAITLIST_GAS_URL
    if (!gasUrl) {
      // Endpoint is configured but the operator hasn't wired up GAS — accept
      // and log so signups aren't lost while the operator finishes setup.
      console.warn('[waitlist] WAITLIST_GAS_URL not set; logging-only signup:', email)
      return res.json({ success: true })
    }

    // Fire and forget — GAS opaque response is fine.
    fetch(gasUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: JSON.stringify({ email }),
    }).catch(err => console.warn('[waitlist] GAS POST failed:', err.message))

    res.json({ success: true })
  } catch (err) {
    console.error('[waitlist] error:', err.message)
    res.status(500).json({ error: 'Something went wrong' })
  }
})

export default router
