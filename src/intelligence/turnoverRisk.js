import { getMoraleEvents, getMoraleSnapshot } from './moraleDb.js'
import { calculateMoraleScore } from './moraleTracker.js'
import { logger } from '../logger.js'

/**
 * Get weekly scheduled hours for a staff member over the last N weeks.
 * Returns volatility metrics.
 */
export async function calculateHoursVolatility(staffId, groupId, weeksBack = 6, db = null) {
  const safe = { avgHours: 0, recentAvg: 0, priorAvg: 0, recentDrop: false, trend: 'stable' }

  let assignments
  if (db?.getScheduleAssignmentsByStaff) {
    assignments = await db.getScheduleAssignmentsByStaff(staffId, groupId)
  } else {
    return safe
  }

  if (!assignments || assignments.length === 0) return safe

  // Group by week_start, count assignments per week
  const weekMap = {}
  for (const a of assignments) {
    const ws = a.week_start
    weekMap[ws] = (weekMap[ws] || 0) + 1
  }

  // Sort weeks descending (most recent first)
  const weeks = Object.keys(weekMap).sort().reverse().slice(0, weeksBack)
  if (weeks.length === 0) return safe

  const hours = weeks.map(w => weekMap[w])
  const avgHours = Math.round(hours.reduce((s, h) => s + h, 0) / hours.length)

  // Recent = first 2 weeks, prior = remaining
  const recentHours = hours.slice(0, 2)
  const priorHours = hours.slice(2)

  const recentAvg = recentHours.length > 0
    ? Math.round(recentHours.reduce((s, h) => s + h, 0) / recentHours.length)
    : 0
  const priorAvg = priorHours.length > 0
    ? Math.round(priorHours.reduce((s, h) => s + h, 0) / priorHours.length)
    : 0

  const recentDrop = priorAvg > 0 && recentAvg < priorAvg * 0.75

  let trend = 'stable'
  if (recentDrop) {
    trend = 'dropping'
  } else if (priorAvg > 0 && recentAvg > priorAvg * 1.25) {
    trend = 'rising'
  }

  return { avgHours, recentAvg, priorAvg, recentDrop, trend }
}

/**
 * Pure function: calculate turnover risk score from signals.
 * No DB, no LLM.
 */
export function calculateRiskScore(signals) {
  const {
    moraleScore, moraleTrend,
    reliabilityScore,
    recentHoursDrop, hoursTrend,
    coverageDeclineRate,
    consecutiveDaysMax,
    lateArrivalCount,
    recognitionCount,
    weeksOfData,
  } = signals

  let score = 0
  const factors = []

  // Morale score
  if (moraleScore < 40) {
    score += 20
    factors.push('Low morale score')
  } else if (moraleScore < 60) {
    score += 10
    factors.push('Below-average morale')
  }

  // Morale trend
  if (moraleTrend === 'declining') {
    score += 5
    factors.push('Morale trending down')
  }

  // Reliability score
  if (reliabilityScore < 50) {
    score += 15
    factors.push('Low reliability score')
  } else if (reliabilityScore < 70) {
    score += 10
    factors.push('Below-average reliability')
  }

  // Hours
  if (recentHoursDrop) {
    score += 20
    factors.push('Recent hours drop')
  }
  if (hoursTrend === 'dropping') {
    score += 10
    factors.push('Hours trending down')
  }

  // Coverage decline rate
  if (coverageDeclineRate > 0.5) {
    score += 15
    factors.push('High coverage decline rate')
  } else if (coverageDeclineRate > 0.33) {
    score += 5
    factors.push('Elevated coverage decline rate')
  }

  // Consecutive days
  if (consecutiveDaysMax >= 7) {
    score += 10
    factors.push('7+ consecutive days scheduled')
  } else if (consecutiveDaysMax >= 6) {
    score += 5
    factors.push('6 consecutive days scheduled')
  }

  // Late arrivals
  if (lateArrivalCount >= 3) {
    score += 10
    factors.push('Frequent late arrivals')
  } else if (lateArrivalCount >= 2) {
    score += 5
    factors.push('Multiple late arrivals')
  }

  // Recognition (subtract)
  if (recognitionCount >= 2) {
    score -= 10
    factors.push('Recent recognition (positive)')
  } else if (recognitionCount >= 1) {
    score -= 5
    factors.push('Some recognition (positive)')
  }

  // High morale bonus
  if (moraleScore > 80) {
    score -= 5
  }

  // High reliability bonus
  if (reliabilityScore > 85) {
    score -= 5
  }

  // New staff cap
  if (weeksOfData < 2) {
    score = Math.min(score, 30)
  }

  // Clamp 0-100
  score = Math.max(0, Math.min(100, score))

  return { score, factors }
}

/**
 * Calculate turnover risk for a single staff member.
 */
export async function calculateTurnoverRisk(staffId, staffName, groupId, moraleScore, moraleTrend, reliabilityScore, db = null) {
  // 1. Hours volatility
  const hoursVol = await calculateHoursVolatility(staffId, groupId, 6, db)

  // 2. Coverage decline rate from morale_events
  let coverageDeclineRate = 0
  try {
    const moraleEvents = db?.getMoraleEvents
      ? await db.getMoraleEvents(groupId, staffId)
      : await getMoraleEvents(groupId, staffId, 8)
    const coverageEvents = moraleEvents.filter(e =>
      e.type === 'coverage_accept' || e.type === 'coverage_decline'
    )
    const declines = coverageEvents.filter(e => e.type === 'coverage_decline').length
    coverageDeclineRate = coverageEvents.length > 0 ? declines / coverageEvents.length : 0
  } catch { /* ignore */ }

  // 3. Max consecutive scheduled days
  let consecutiveDaysMax = 0
  try {
    const assignments = db?.getScheduleAssignmentsByStaff
      ? await db.getScheduleAssignmentsByStaff(staffId, groupId)
      : []
    if (assignments.length > 0) {
      const dates = assignments.map(a => a.week_start).sort()
      // Simple consecutive count based on sorted dates
      let current = 1
      for (let i = 1; i < dates.length; i++) {
        const prev = new Date(dates[i - 1])
        const curr = new Date(dates[i])
        const diffDays = (curr - prev) / (24 * 60 * 60 * 1000)
        if (diffDays === 1) {
          current++
        } else if (diffDays > 1) {
          consecutiveDaysMax = Math.max(consecutiveDaysMax, current)
          current = 1
        }
        // diffDays === 0 means same day, skip
      }
      consecutiveDaysMax = Math.max(consecutiveDaysMax, current)
    }
  } catch { /* ignore */ }

  // 4. Late arrival count (last 4 weeks)
  let lateArrivalCount = 0
  try {
    const relEvents = db?.getReliabilityEvents
      ? await db.getReliabilityEvents(staffId, groupId)
      : []
    const fourWeeksAgo = new Date(Date.now() - 28 * 24 * 60 * 60 * 1000)
    lateArrivalCount = relEvents.filter(e =>
      e.event_type === 'late_arrival' &&
      (!e.recorded_at || new Date(e.recorded_at) >= fourWeeksAgo)
    ).length
  } catch { /* ignore */ }

  // 5. Recognition count (last 4 weeks, graceful if table doesn't exist)
  let recognitionCount = 0
  try {
    if (db?.getRecognitionEvents) {
      const recEvents = await db.getRecognitionEvents(staffId, groupId)
      recognitionCount = recEvents.length
    }
  } catch { /* ignore */ }

  // 6. Weeks of data
  let weeksOfData = 0
  try {
    const moraleEvents = db?.getMoraleEvents
      ? await db.getMoraleEvents(groupId, staffId)
      : await getMoraleEvents(groupId, staffId, 52)
    const weekSet = new Set(moraleEvents.map(e => e.week_start).filter(Boolean))
    weeksOfData = weekSet.size
  } catch { /* ignore */ }

  const signals = {
    moraleScore,
    moraleTrend,
    reliabilityScore,
    recentHoursDrop: hoursVol.recentDrop,
    hoursTrend: hoursVol.trend,
    coverageDeclineRate,
    consecutiveDaysMax,
    lateArrivalCount,
    recognitionCount,
    weeksOfData,
  }

  const { score, factors } = calculateRiskScore(signals)

  let riskLevel
  if (score <= 30) riskLevel = 'low'
  else if (score <= 50) riskLevel = 'medium'
  else if (score <= 70) riskLevel = 'high'
  else riskLevel = 'critical'

  let recommendation = null
  if (riskLevel === 'critical') recommendation = 'Urgent check-in recommended'
  else if (riskLevel === 'high') recommendation = 'Consider a 1:1 conversation'
  else if (riskLevel === 'medium') recommendation = 'Worth keeping an eye on'

  return { staffId, staffName, score, riskLevel, factors, recommendation }
}

/**
 * Generate turnover risk report for an entire team.
 */
export async function generateTurnoverRiskReport(groupId, db = null) {
  // 1. Get all active staff
  let staff = []
  try {
    if (db?.getActiveStaff) {
      staff = await db.getActiveStaff(groupId)
    }
  } catch { /* ignore */ }

  if (staff.length === 0) {
    return { critical: [], high: [], medium: [], low: [], teamRiskAverage: 0, staffCount: 0 }
  }

  // 2. Get morale scores
  const moraleSnapshot = db?.getMoraleSnapshot
    ? await db.getMoraleSnapshot(groupId)
    : {}

  // 3. Get reliability scores
  let reliabilityScores = []
  try {
    if (db?.getReliabilityScores) {
      reliabilityScores = await db.getReliabilityScores(groupId)
    }
  } catch { /* ignore */ }
  const reliabilityMap = {}
  for (const r of reliabilityScores) {
    reliabilityMap[r.staffId] = r.score
  }

  // 4. Calculate risk for each staff member
  const results = await Promise.all(
    staff.map(async (s) => {
      const events = moraleSnapshot[s.id] ?? []
      const { score: moraleScore, trend: moraleTrend } = calculateMoraleScore(events)
      const relScore = reliabilityMap[s.id] ?? 70
      return calculateTurnoverRisk(s.id, s.name, groupId, moraleScore, moraleTrend, relScore, db)
    })
  )

  // 5. Group by risk level
  const grouped = { critical: [], high: [], medium: [], low: [] }
  for (const r of results) {
    grouped[r.riskLevel].push(r)
  }

  // 6. Team average
  const totalScore = results.reduce((s, r) => s + r.score, 0)
  const teamRiskAverage = results.length > 0 ? Math.round(totalScore / results.length) : 0

  return { ...grouped, teamRiskAverage, staffCount: staff.length }
}

/**
 * Format a brief alert for the Sunday briefing. Returns null if no medium+ risks.
 */
export function formatTurnoverRiskAlert(riskReport) {
  const flagged = [
    ...riskReport.critical.map(s => ({ ...s, icon: '\u{1F534}' })),
    ...riskReport.high.map(s => ({ ...s, icon: '\u{1F7E1}' })),
    ...riskReport.medium.map(s => ({ ...s, icon: '\u{1F7E1}' })),
  ]

  if (flagged.length === 0) return null

  const lines = ['\u26A0\uFE0F *Staff retention \u2014 worth your attention:*', '']

  for (const s of flagged) {
    const topFactor = s.factors[0] ?? 'Multiple signals'
    let line = `${s.icon} ${s.staffName} \u2014 ${topFactor}`
    if (s.recommendation) line += `. ${s.recommendation}.`
    lines.push(line)
  }

  lines.push('')
  lines.push('Full detail: /retention')
  lines.push('(This is private \u2014 not visible to staff.)')

  return lines.join('\n')
}

/**
 * Format the full /retention command output.
 */
export function formatTurnoverRiskCommand(riskReport) {
  const lines = [
    '\u{1F4CA} *Staff retention risk \u2014 internal report*',
    '(Not shared with staff)',
    '',
  ]

  const allStaff = [
    ...riskReport.critical.map(s => ({ ...s, icon: '\u{1F534}', level: 'CRITICAL' })),
    ...riskReport.high.map(s => ({ ...s, icon: '\u{1F7E0}', level: 'HIGH' })),
    ...riskReport.medium.map(s => ({ ...s, icon: '\u{1F7E1}', level: 'MEDIUM' })),
    ...riskReport.low.map(s => ({ ...s, icon: '\u{1F7E2}', level: 'LOW' })),
  ]

  if (allStaff.length === 0) {
    lines.push('No staff data available.')
  } else {
    for (const s of allStaff) {
      lines.push(`${s.icon} *${s.staffName}* \u2014 ${s.level} (${s.score}/100)`)
      if ((s.level === 'CRITICAL' || s.level === 'HIGH') && s.factors.length > 0) {
        for (const f of s.factors) {
          lines.push(`   \u2022 ${f}`)
        }
      }
      if (s.recommendation) {
        lines.push(`   \u2192 ${s.recommendation}`)
      }
    }
  }

  lines.push('')
  lines.push(`Team average: ${riskReport.teamRiskAverage}/100 | ${riskReport.staffCount} staff`)

  return lines.join('\n')
}
