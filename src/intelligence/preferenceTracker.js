const DAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday']

const NON_EDIT_PHRASES = [
  'looks good', 'approve', 'approved', 'lgtm', 'perfect', 'great', 'ok', 'okay',
  'yes', 'no', 'thanks', 'thank you', 'publish', 'send it', 'good to go'
]

function matchStaff(nameFragment, staff) {
  const lower = nameFragment.toLowerCase()
  // Exact match first
  const exact = staff.find(s => s.name.toLowerCase() === lower)
  if (exact) return exact
  // Partial match
  const partial = staff.find(s => s.name.toLowerCase().startsWith(lower))
  if (partial) return partial
  return null
}

function matchDay(text) {
  const lower = text.toLowerCase().replace(/s$/, '') // strip trailing 's' (Mondays -> Monday)
  for (const day of DAYS) {
    if (lower.includes(day)) return day.charAt(0).toUpperCase() + day.slice(1)
  }
  return null
}

function matchShift(text, shifts) {
  const lower = text.toLowerCase()
  // Try to find a shift whose name appears in the text
  let best = null
  let bestLen = 0
  for (const shift of shifts) {
    const shiftLower = shift.name.toLowerCase()
    if (lower.includes(shiftLower) && shiftLower.length > bestLen) {
      best = shift
      bestLen = shiftLower.length
    }
  }
  if (best) return best
  // Try matching day + time-of-day keywords in shift name
  for (const shift of shifts) {
    const parts = shift.name.toLowerCase().split(/\s+/)
    if (parts.every(p => lower.includes(p))) return shift
  }
  return null
}

export function parseEditFromMessage(text, currentAssignments, staff, shifts) {
  const lower = text.toLowerCase().trim()

  // Non-edit phrases
  if (NON_EDIT_PHRASES.includes(lower)) return null

  // Detect action type
  let type = null
  if (/\b(remove|take\s+off|move\s+.+\s+off)\b/i.test(text)) type = 'remove'
  else if (/\bswap\b/i.test(text)) type = 'swap'
  else if (/\badd\b/i.test(text)) type = 'add'
  else if (/\bmove\b/i.test(text)) type = 'remove' // "move X off Y"

  if (!type) return null

  // Extract staff name — look for known names or partial matches
  let matched = null
  for (const s of staff) {
    const nameRe = new RegExp(`\\b${s.name}\\b`, 'i')
    if (nameRe.test(text)) {
      matched = s
      break
    }
  }
  if (!matched) {
    // Try to find a word that partially matches a staff name
    const words = text.replace(/[^a-zA-Z\s]/g, '').split(/\s+/)
    for (const word of words) {
      if (['remove', 'swap', 'add', 'move', 'from', 'to', 'off', 'on'].includes(word.toLowerCase())) continue
      const m = matchStaff(word, staff)
      if (m) { matched = m; break }
    }
  }

  if (!matched) return null

  const result = {
    type,
    staffName: matched.name,
    staffId: matched.id
  }

  // Extract day
  const day = matchDay(text)
  if (day) result.dayOfWeek = day

  // Extract target shift
  const shift = matchShift(text, shifts)
  if (shift) {
    result.toShiftName = shift.name
    result.toShiftId = shift.id
  }

  return result
}

export function analyzePatterns(editHistory, totalWeeks = 8) {
  if (!editHistory.length) return []

  const groups = {}
  for (const edit of editHistory) {
    // Key by staffId + type + (dayOfWeek or shiftId)
    const dayKey = edit.day_of_week || ''
    const shiftKey = edit.to_shift_id || edit.from_shift_id || ''
    const key = `${edit.staff_id}:${edit.type}:${dayKey}:${shiftKey}`
    if (!groups[key]) {
      groups[key] = {
        type: edit.type,
        staffId: edit.staff_id,
        staffName: edit.staff_name,
        dayOfWeek: edit.day_of_week || null,
        shiftId: edit.to_shift_id || edit.from_shift_id || null,
        count: 0
      }
    }
    groups[key].count++
  }

  const patterns = []
  for (const g of Object.values(groups)) {
    if (g.count < 2) continue
    const confidence = g.count / totalWeeks
    const target = g.dayOfWeek || g.shiftName || 'shifts'
    const description = `${g.staffName} ${g.type}d from ${target} ${g.count} of ${totalWeeks} weeks`
    patterns.push({
      ...g,
      confidence,
      description
    })
  }

  return patterns
}

export function applyPreferencesToDraft(assignments, preferences, shifts, staff) {
  let newAssignments = [...assignments]
  const applied = []

  for (const pref of preferences) {
    if (!pref.autoApply) continue

    if (pref.type === 'avoid_day') {
      const toRemove = newAssignments.filter(a => a.staffId === pref.staffId && a.dayOfWeek === pref.dayOfWeek)
      if (toRemove.length === 0) continue

      // Gap protection: check if removing would leave any shift on that day empty
      const wouldRemain = newAssignments.filter(a => !(a.staffId === pref.staffId && a.dayOfWeek === pref.dayOfWeek))
      const dayHasOthers = wouldRemain.some(a => a.dayOfWeek === pref.dayOfWeek)
      if (!dayHasOthers) continue // SKIP — would create a gap

      newAssignments = wouldRemain
      applied.push({
        preference: pref,
        description: `${pref.staffName}: off ${pref.dayOfWeek}s`
      })
    } else if (pref.type === 'avoid_shift') {
      const toRemove = newAssignments.filter(a => a.staffId === pref.staffId && a.shiftId === pref.shiftId)
      if (toRemove.length === 0) continue

      // Gap protection
      const wouldRemain = newAssignments.filter(a => !(a.staffId === pref.staffId && a.shiftId === pref.shiftId))
      const shiftHasOthers = wouldRemain.some(a => a.shiftId === pref.shiftId)
      if (!shiftHasOthers) continue

      newAssignments = wouldRemain
      applied.push({
        preference: pref,
        description: `${pref.staffName}: avoid shift ${pref.shiftId}`
      })
    }
    // prefer_shift is informational only — skip
  }

  return { newAssignments, applied }
}

export function formatPreferenceSummary(applied) {
  if (!applied || applied.length === 0) return null

  const lines = applied.map(a => `\u2022 ${a.description}`)
  return `\ud83e\udde0 *Applied your usual preferences:*\n\n${lines.join('\n')}\n\nAnything to change?`
}

export function formatNewPatternAlert(pattern) {
  const target = pattern.dayOfWeek || pattern.shiftName || 'that shift'
  return `\ud83d\udca1 I noticed you always move ${pattern.staffName} off ${target}. Want me to apply this automatically going forward?\nReply *yes* to add it as a preference.`
}
