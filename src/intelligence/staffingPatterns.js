import { logger } from '../logger.js'

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
]

/**
 * Generate Monday-based week-start dates going back N weeks from today.
 */
function getWeekStarts(weeksBack) {
  const now = new Date()
  // Find the most recent Monday
  const day = now.getDay()
  const diff = (day === 0 ? 6 : day - 1)
  const monday = new Date(now)
  monday.setDate(monday.getDate() - diff)
  monday.setHours(0, 0, 0, 0)

  const starts = []
  for (let i = 0; i < weeksBack; i++) {
    const d = new Date(monday)
    d.setDate(d.getDate() - i * 7)
    starts.push(d.toISOString().slice(0, 10))
  }
  return starts
}

/**
 * Analyze staffing history for a single shift over the past N weeks.
 */
export async function analyzeShiftStaffingHistory(groupId, shiftId, weeksBack = 8, db = null) {
  const shift = await db?.getShiftById?.(shiftId)
  const requirements = await db?.getShiftRequirements?.(shiftId) ?? []
  const totalRequired = requirements.reduce((sum, r) => sum + r.count, 0)

  const weekStarts = getWeekStarts(weeksBack)
  const assignmentCounts = await db?.getAssignmentCountsByWeek?.(groupId, shiftId, weekStarts) ?? new Map()

  let weeksAnalyzed = 0
  let understaffedWeeks = 0
  let overstaffedWeeks = 0
  let totalAssigned = 0

  for (const ws of weekStarts) {
    if (!assignmentCounts.has(ws)) continue
    weeksAnalyzed++
    const assigned = assignmentCounts.get(ws)
    totalAssigned += assigned
    if (assigned < totalRequired) understaffedWeeks++
    if (assigned > totalRequired) overstaffedWeeks++
  }

  const avgAssigned = weeksAnalyzed > 0 ? totalAssigned / weeksAnalyzed : 0
  const understaffedRate = weeksAnalyzed > 0 ? understaffedWeeks / weeksAnalyzed : 0
  const overstaffedRate = weeksAnalyzed > 0 ? overstaffedWeeks / weeksAnalyzed : 0

  let pattern = 'stable'
  if (weeksAnalyzed < 6) {
    pattern = 'insufficient_data'
  } else if (understaffedRate >= 0.6) {
    pattern = 'chronic_understaffing'
  } else if (overstaffedRate >= 0.6) {
    pattern = 'chronic_overstaffing'
  }

  return {
    shiftId,
    shiftName: shift?.name ?? 'Unknown',
    dayOfWeek: shift?.day_of_week ?? 'Unknown',
    weeksAnalyzed,
    avgRequired: totalRequired,
    avgAssigned: Math.round(avgAssigned * 100) / 100,
    understaffedWeeks,
    overstaffedWeeks,
    understaffedRate: Math.round(understaffedRate * 1000) / 1000,
    overstaffedRate: Math.round(overstaffedRate * 1000) / 1000,
    pattern,
  }
}

/**
 * Analyze all shifts for a group, returning only non-stable/non-insufficient patterns.
 * Sorted by severity (highest understaffedRate first).
 */
export async function analyzeAllShifts(groupId, weeksBack = 8, db = null) {
  const shifts = await db?.getShiftsByGroup?.(groupId) ?? []

  const results = await Promise.all(
    shifts.map(s => analyzeShiftStaffingHistory(groupId, s.id, weeksBack, db))
  )

  return results
    .filter(r => r.pattern !== 'stable' && r.pattern !== 'insufficient_data')
    .sort((a, b) => b.understaffedRate - a.understaffedRate)
}

/**
 * Generate staffing recommendations from analyzed patterns. Pure function.
 */
export function generateStaffingRecommendations(patterns) {
  const recommendations = []

  for (const p of patterns) {
    if (p.pattern === 'chronic_understaffing') {
      recommendations.push({
        shiftId: p.shiftId,
        shiftName: p.shiftName,
        dayOfWeek: p.dayOfWeek,
        type: 'increase_requirement',
        currentRequirement: p.avgRequired,
        suggestedRequirement: Math.ceil(p.avgAssigned + 0.5),
        reasoning: `${p.shiftName} has been understaffed ${p.understaffedWeeks} of ${p.weeksAnalyzed} weeks (${Math.round(p.understaffedRate * 100)}%).`,
        severity: p.understaffedRate >= 0.75 ? 'high' : 'medium',
        understaffedWeeks: p.understaffedWeeks,
        weeksAnalyzed: p.weeksAnalyzed,
      })
    } else if (p.pattern === 'chronic_overstaffing') {
      recommendations.push({
        shiftId: p.shiftId,
        shiftName: p.shiftName,
        dayOfWeek: p.dayOfWeek,
        type: 'decrease_requirement',
        currentRequirement: p.avgRequired,
        suggestedRequirement: Math.floor(p.avgAssigned),
        reasoning: `${p.shiftName} is consistently overstaffed ${p.overstaffedWeeks} of ${p.weeksAnalyzed} weeks (${Math.round(p.overstaffedRate * 100)}%).`,
        severity: 'low',
        overstaffedWeeks: p.overstaffedWeeks,
        weeksAnalyzed: p.weeksAnalyzed,
      })
    }
  }

  const summary = recommendations.length === 0
    ? 'All shifts are staffed within normal ranges.'
    : `Found ${recommendations.length} staffing pattern(s) that may need attention.`

  return { recommendations, summary }
}

/**
 * Format staffing pattern alert for Telegram. Pure function.
 * Returns null if no recommendations.
 */
export function formatStaffingPatternAlert({ recommendations, summary }) {
  if (!recommendations || recommendations.length === 0) return null

  const lines = ['\u{1F504} *Staffing pattern insights:*\n']

  for (const rec of recommendations) {
    if (rec.type === 'increase_requirement') {
      lines.push(
        `\u{26A0}\u{FE0F} ${rec.shiftName} has been understaffed ${rec.understaffedWeeks} of ${rec.weeksAnalyzed} weeks.`
      )
      lines.push(
        `Consider adding a ${ordinal(rec.suggestedRequirement)} server slot (currently requires ${rec.currentRequirement}, typically needs ${rec.suggestedRequirement}).\n`
      )
    } else if (rec.type === 'decrease_requirement') {
      lines.push(
        `\u{1F4A1} ${rec.shiftName} is consistently overstaffed \u{2014}`
      )
      lines.push(
        `you might reduce the server requirement from ${rec.currentRequirement} to ${rec.suggestedRequirement}.\n`
      )
    }
  }

  return lines.join('\n')
}

function ordinal(n) {
  const s = ['th', 'st', 'nd', 'rd']
  const v = n % 100
  return n + (s[(v - 20) % 10] || s[v] || s[0])
}

/**
 * Detect seasonal patterns from 12+ weeks of data.
 */
export async function detectSeasonalPatterns(groupId, db = null) {
  const shifts = await db?.getShiftsByGroup?.(groupId) ?? []
  if (shifts.length === 0) {
    return { hasSeasonalData: false, patterns: [] }
  }

  // We need at least 12 weeks of data
  const weekStarts = getWeekStarts(16)
  const requirements = await db?.getShiftRequirements?.(shifts[0]?.id) ?? []
  const totalRequired = requirements.reduce((sum, r) => sum + r.count, 0)

  // Gather understaffed counts per week across all shifts
  const weekUnderstaffed = new Map() // weekStart → count of understaffed shifts

  let maxWeeksWithData = 0

  for (const shift of shifts) {
    const reqs = await db?.getShiftRequirements?.(shift.id) ?? []
    const req = reqs.reduce((sum, r) => sum + r.count, 0)
    const counts = await db?.getAssignmentCountsByWeek?.(groupId, shift.id, weekStarts) ?? new Map()

    for (const ws of weekStarts) {
      if (!counts.has(ws)) continue
      const assigned = counts.get(ws)
      if (assigned < req) {
        weekUnderstaffed.set(ws, (weekUnderstaffed.get(ws) || 0) + 1)
      } else {
        // Ensure the week exists even if no understaffing
        if (!weekUnderstaffed.has(ws)) weekUnderstaffed.set(ws, 0)
      }
    }
  }

  const weeksWithData = weekUnderstaffed.size
  if (weeksWithData < 12) {
    return { hasSeasonalData: false, patterns: [] }
  }

  // Group by month
  const monthData = {} // month (0-11) → [understaffedShiftCounts]
  for (const [ws, count] of weekUnderstaffed) {
    const month = new Date(ws).getMonth()
    if (!monthData[month]) monthData[month] = []
    monthData[month].push(count)
  }

  // Calculate overall average
  const allCounts = [...weekUnderstaffed.values()]
  const overallAvg = allCounts.reduce((a, b) => a + b, 0) / allCounts.length

  const patterns = []
  for (const [monthStr, counts] of Object.entries(monthData)) {
    const month = parseInt(monthStr)
    const avg = counts.reduce((a, b) => a + b, 0) / counts.length
    let relativeLoad = 'normal'
    if (avg > overallAvg * 1.3) relativeLoad = 'heavy'
    else if (avg < overallAvg * 0.7) relativeLoad = 'light'

    patterns.push({
      month,
      avgUnderstaffedShifts: Math.round(avg * 100) / 100,
      relativeLoad,
    })
  }

  patterns.sort((a, b) => a.month - b.month)

  return { hasSeasonalData: true, patterns }
}

/**
 * Format seasonal insight for display. Pure function.
 * Returns null if no seasonal data.
 */
export function formatSeasonalInsight(seasonalData, currentMonth) {
  if (!seasonalData?.hasSeasonalData) return null

  const lines = ['\u{1F4C5} *Seasonal staffing trends:*\n']

  const heavy = seasonalData.patterns.filter(p => p.relativeLoad === 'heavy')
  const light = seasonalData.patterns.filter(p => p.relativeLoad === 'light')

  if (heavy.length > 0) {
    const months = heavy.map(p => MONTH_NAMES[p.month]).join(', ')
    lines.push(`\u{1F525} Historically busy: ${months}`)
  }

  if (light.length > 0) {
    const months = light.map(p => MONTH_NAMES[p.month]).join(', ')
    lines.push(`\u{2744}\u{FE0F} Historically lighter: ${months}`)
  }

  const currentPattern = seasonalData.patterns.find(p => p.month === currentMonth)
  if (currentPattern && currentPattern.relativeLoad !== 'normal') {
    const label = currentPattern.relativeLoad === 'heavy' ? 'busier than average' : 'lighter than average'
    lines.push(`\nThis month (${MONTH_NAMES[currentMonth]}) is typically ${label}.`)
  }

  return lines.join('\n')
}
