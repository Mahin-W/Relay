// In-memory store of pending login confirmation codes, keyed by account id.
// Mirrors the OTP store in authRoutes.js. Codes are short-lived; losing them on
// a server restart just means the user requests a new one.

const store = new Map()
const TTL_MS = 10 * 60 * 1000
const RESEND_COOLDOWN_MS = 60 * 1000  // don't email a new code more than once/min
const MAX_ATTEMPTS = 6

export function generateCode() {
  return Math.floor(100000 + Math.random() * 900000).toString()
}

// Store a freshly sent code along with how it was delivered (so a within-cooldown
// re-request can report the same channel without resending).
export function setCode(accountId, code, meta = {}) {
  store.set(accountId, {
    code,
    expiresAt: Date.now() + TTL_MS,
    sentAt: Date.now(),
    attempts: 0,
    channel: meta.channel || null,
    hint: meta.hint || null,
  })
}

// The current valid pending entry, or null.
export function getPending(accountId) {
  const e = store.get(accountId)
  if (!e || e.expiresAt < Date.now()) return null
  return e
}

// True if a code was sent recently — caller should reuse it instead of resending.
export function withinCooldown(accountId) {
  const e = getPending(accountId)
  return !!e && Date.now() - e.sentAt < RESEND_COOLDOWN_MS
}

// Returns { ok:true } or { ok:false, reason }.
export function verifyCode(accountId, code) {
  const e = store.get(accountId)
  if (!e) return { ok: false, reason: 'none' }
  if (Date.now() > e.expiresAt) { store.delete(accountId); return { ok: false, reason: 'expired' } }
  e.attempts += 1
  if (e.attempts > MAX_ATTEMPTS) { store.delete(accountId); return { ok: false, reason: 'too_many' } }
  if (e.code !== String(code)) return { ok: false, reason: 'incorrect' }
  store.delete(accountId)
  return { ok: true }
}

// Test helper.
export function _clear() { store.clear() }
