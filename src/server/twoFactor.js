// In-memory store of pending login confirmation codes, keyed by account id.
// Mirrors the OTP store in authRoutes.js. Codes are short-lived; losing them on
// a server restart just means the user requests a new one.

const store = new Map()
const TTL_MS = 10 * 60 * 1000
const MAX_ATTEMPTS = 6

export function generateCode() {
  return Math.floor(100000 + Math.random() * 900000).toString()
}

export function setCode(accountId, code) {
  store.set(accountId, { code, expiresAt: Date.now() + TTL_MS, attempts: 0 })
}

export function hasPending(accountId) {
  const e = store.get(accountId)
  return !!e && e.expiresAt > Date.now()
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
