import { logger } from '../logger.js'

const DAY_ORDER = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']

/**
 * Find the longest consecutive day streak in an array of day names.
 * Returns { streak, days, warning } where warning = true if streak >= 7.
 */
export function getConsecutiveDayStreak(scheduledDays) {
  if (!scheduledDays || scheduledDays.length === 0) {
    return { streak: 0, days: [], warning: false }
  }

  // Convert to indices and sort
  const indices = scheduledDays
    .map(d => DAY_ORDER.indexOf(d))
    .filter(i => i >= 0)
    .sort((a, b) => a - b)

  if (indices.length === 0) {
    return { streak: 0, days: [], warning: false }
  }

  let bestStart = 0
  let bestLen = 1
  let curStart = 0
  let curLen = 1

  for (let i = 1; i < indices.length; i++) {
    if (indices[i] === indices[i - 1] + 1) {
      curLen++
    } else {
      if (curLen > bestLen) {
        bestLen = curLen
        bestStart = curStart
      }
      curStart = i
      curLen = 1
    }
  }
  if (curLen > bestLen) {
    bestLen = curLen
    bestStart = curStart
  }

  const bestDays = indices.slice(bestStart, bestStart + bestLen).map(i => DAY_ORDER[i])

  return {
    streak: bestLen,
    days: bestDays,
    warning: bestLen >= 7,
  }
}

/**
 * Detect callout patterns for scheduled assignments.
 * Returns array of { staffName, shiftName, dayOfWeek, calloutCount, totalScheduled, warning }
 */
export async function detectCalloutPatterns(groupId, assignments, db = null) {
  if (!assignments || assignments.length === 0) return []

  const results = []
  // Deduplicate by staffName + dayOfWeek
  const seen = new Set()

  for (const assignment of assignments) {
    const key = `${assignment.staffName}|${assignment.dayOfWeek}`
    if (seen.has(key)) continue
    seen.add(key)

    let history = []
    if (db?.getCalloutHistory) {
      history = await db.getCalloutHistory(groupId, assignment.staffName)
    }

    for (const entry of history) {
      if (entry.day_of_week === assignment.dayOfWeek && entry.count >= 2) {
        const rate = entry.total_scheduled > 0 ? entry.count / entry.total_scheduled : 0
        results.push({
          staffName: assignment.staffName,
          shiftName: entry.shift_name,
          dayOfWeek: entry.day_of_week,
          calloutCount: entry.count,
          totalScheduled: entry.total_scheduled,
          warning: rate >= 0.5,
        })
      }
    }
  }

  return results
}

/**
 * Generate contextual warnings and notes for a schedule.
 * Returns { warnings: [{staffName, message}], notes: [{staffName, message}] }
 */
export async function generateContextualWarnings(groupId, assignments, db = null) {
  if (!assignments || assignments.length === 0) {
    return { warnings: [], notes: [] }
  }

  const warnings = []
  const notes = []

  // Group assignments by staff
  const byStaff = {}
  for (const a of assignments) {
    if (!byStaff[a.staffName]) byStaff[a.staffName] = []
    byStaff[a.staffName].push(a.dayOfWeek)
  }

  // Check consecutive day streaks per staff
  for (const [staffName, days] of Object.entries(byStaff)) {
    const uniqueDays = [...new Set(days)]
    const streak = getConsecutiveDayStreak(uniqueDays)
    if (streak.streak >= 7) {
      warnings.push({
        staffName,
        message: `${staffName} is scheduled ${streak.streak} consecutive days (${streak.days.join(', ')})`,
      })
    } else if (streak.streak >= 6) {
      notes.push({
        staffName,
        message: `${staffName} is scheduled ${streak.streak} consecutive days (${streak.days.join(', ')})`,
      })
    }
  }

  // Check callout patterns
  const callouts = await detectCalloutPatterns(groupId, assignments, db)
  for (const c of callouts) {
    const rate = Math.round((c.calloutCount / c.totalScheduled) * 100)
    if (c.warning) {
      warnings.push({
        staffName: c.staffName,
        message: `${c.staffName} called out ${c.calloutCount}/${c.totalScheduled} ${c.dayOfWeek}s (${rate}%)`,
      })
    } else {
      notes.push({
        staffName: c.staffName,
        message: `${c.staffName} called out ${c.calloutCount}/${c.totalScheduled} ${c.dayOfWeek}s (${rate}%)`,
      })
    }
  }

  return { warnings, notes }
}

/**
 * Format warnings and notes into a Telegram message.
 * Returns null if both arrays are empty.
 */
export function formatContextualWarnings(warnings, notes) {
  if ((!warnings || warnings.length === 0) && (!notes || notes.length === 0)) {
    return null
  }

  const lines = ['📋 *A few things from recent history:*', '']

  for (const w of (warnings || [])) {
    lines.push(`⚠️ ${w.message}`)
  }
  for (const n of (notes || [])) {
    lines.push(`💭 ${n.message}`)
  }

  if (warnings && warnings.length > 0) {
    lines.push('')
    lines.push('_Review before approving._')
  }

  return lines.join('\n')
}
