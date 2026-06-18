/**
 * Simple in-memory IP rate limiter — rolling window per IP.
 *
 * Usage:
 *   const limiter = createIpRateLimiter({ maxRequests: 10, windowMs: 60 * 60 * 1000 })
 *   if (!limiter.isAllowed(req.ip)) return res.status(429).json({ error: '...' })
 *
 * Each entry is pruned lazily on the next check for that IP once its window
 * has expired. This avoids a background interval and keeps memory bounded
 * (only IPs that have ever sent a request have an entry).
 */
export function createIpRateLimiter({ maxRequests = 10, windowMs = 60 * 60 * 1000 } = {}) {
  // Map<ip, { count: number, windowStart: number }>
  const store = new Map()

  return {
    /**
     * Returns true if this request is within the rate limit, false if it should
     * be blocked.  Call this once per request — it both checks AND increments.
     * @param {string} ip
     * @returns {boolean}
     */
    isAllowed(ip) {
      const now = Date.now()
      const entry = store.get(ip)

      if (!entry || now - entry.windowStart >= windowMs) {
        // New IP or window expired — start a fresh window
        store.set(ip, { count: 1, windowStart: now })
        return true
      }

      if (entry.count >= maxRequests) {
        return false
      }

      entry.count++
      return true
    },

    /** Exposed for testing / forced reset */
    _store: store,
  }
}

// Singleton for the OTP request-code endpoint (10 req / rolling hour per IP)
export const otpIpLimiter = createIpRateLimiter({ maxRequests: 10, windowMs: 60 * 60 * 1000 })
