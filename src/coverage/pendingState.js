// In-memory pending clarification state.
// Key: `${groupId}_${userId}`, TTL: 5 minutes
const pendingClarifications = new Map()

export function setPendingClarification(groupId, userId, data) {
  pendingClarifications.set(`${groupId}_${userId}`, { ...data, expiresAt: Date.now() + 5 * 60 * 1000 })
}

// Returns { intentType, intent, matchedShift, matchedWeekStart } or null.
export function resolvePendingClarification(groupId, userId, replyText) {
  const key = `${groupId}_${userId}`
  const pending = pendingClarifications.get(key)
  if (!pending || Date.now() > pending.expiresAt) {
    pendingClarifications.delete(key)
    return null
  }
  const lower = replyText.toLowerCase().trim()
  const matched = pending.dayShifts.find(s => {
    const sLower = s.name.toLowerCase()
    return sLower.includes(lower) || lower.includes(sLower) ||
      lower.split(/\s+/).some(w => w.length > 3 && sLower.includes(w))
  })
  if (!matched) return null
  pendingClarifications.delete(key)
  return { intentType: pending.intentType, intent: pending.intent, matchedShift: { ...matched, low_confidence: false }, matchedWeekStart: pending.matchedWeekStart }
}

const DAY_NAMES = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday']
const DAY_ABBREVS = { mon: 'Monday', tue: 'Tuesday', wed: 'Wednesday', thu: 'Thursday', fri: 'Friday', sat: 'Saturday', sun: 'Sunday' }

export function extractDayFromText(text) {
  const lower = (text || '').toLowerCase()
  for (const [abbr, full] of Object.entries(DAY_ABBREVS)) {
    if (new RegExp(`\\b${abbr}\\b`).test(lower)) return full
  }
  for (const d of DAY_NAMES) {
    if (lower.includes(d)) return d.charAt(0).toUpperCase() + d.slice(1)
  }
  return null
}
