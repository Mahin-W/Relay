import { getShiftsForGroup, getScheduleAssignments } from './setup/setupDb.js'
import { logger } from './logger.js'

// Score how well a configured shift matches a natural language description.
// Higher = better match.
function scoreShift(shift, intentShift, messageText) {
  const haystack = `${intentShift} ${messageText}`.toLowerCase()
  const shiftName = shift.name.toLowerCase()
  const shiftDay = shift.day_of_week.toLowerCase()

  let score = 0

  // Exact shift name in message
  if (haystack.includes(shiftName)) score += 20

  // Individual words of shift name (ignore short words)
  for (const word of shiftName.split(/\s+/).filter(w => w.length > 2)) {
    if (haystack.includes(word)) score += 4
  }

  // Full day name
  if (haystack.includes(shiftDay)) score += 10

  // Abbreviated day (mon, tue, wed…)
  if (haystack.includes(shiftDay.slice(0, 3))) score += 7

  // Time proximity — extract hours mentioned in message and compare to shift times
  const shiftStartHour = parseHour(shift.start_time)
  const textTimes = [...haystack.matchAll(/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/gi)]
  for (const match of textTimes) {
    let hour = parseInt(match[1])
    const ampm = match[3].toLowerCase()
    if (ampm === 'pm' && hour !== 12) hour += 12
    if (ampm === 'am' && hour === 12) hour = 0
    if (Math.abs(hour - shiftStartHour) <= 1) score += 8
  }

  return score
}

function parseHour(timeStr) {
  const match = timeStr.match(/(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i)
  if (!match) return 0
  let hour = parseInt(match[1])
  const ampm = match[3]?.toLowerCase()
  if (ampm === 'pm' && hour !== 12) hour += 12
  if (ampm === 'am' && hour === 12) hour = 0
  return hour
}

// Returns the best matching shift for a group, or null if nothing fits.
// low_confidence: true when the best match is ambiguous (close runner-up).
// Pass shifts directly (for tests) to skip the DB call.
export async function matchShift(groupId, intentShift, messageText, shifts = null) {
  try {
    if (!shifts) shifts = await getShiftsForGroup(groupId)
    if (shifts.length === 0) return null
    if (shifts.length === 1) {
      // Only one shift — always a match, but flag low confidence if the
      // message gives no day/time signal at all
      const score = scoreShift(shifts[0], intentShift, messageText)
      return { ...shifts[0], low_confidence: score < 5 }
    }

    const scored = shifts
      .map(s => ({ shift: s, score: scoreShift(s, intentShift, messageText) }))
      .filter(s => s.score > 0)
      .sort((a, b) => b.score - a.score)

    if (scored.length === 0) return null

    const best = scored[0]
    // Low confidence when the runner-up is within 70% of the top score
    const low_confidence = scored.length > 1 && scored[1].score >= best.score * 0.7

    logger.parse(`Shift match: "${best.shift.name}" score=${best.score} low_confidence=${low_confidence}`)
    return { ...best.shift, low_confidence }
  } catch (err) {
    logger.error(`matchShift failed: ${err.message}`)
    return null
  }
}

// Returns staff currently scheduled on a shift for the given week.
export async function getShiftRoster(shiftId, weekStart) {
  try {
    return await getScheduleAssignments(shiftId, weekStart)
  } catch (err) {
    logger.error(`getShiftRoster failed: ${err.message}`)
    return []
  }
}

// Returns the ISO date string of the Monday starting the current week.
export function getCurrentWeekStart() {
  const now = new Date()
  const day = now.getDay() // 0 = Sunday
  const daysToMonday = day === 0 ? -6 : 1 - day
  const monday = new Date(now)
  monday.setDate(now.getDate() + daysToMonday)
  return monday.toISOString().split('T')[0]
}
