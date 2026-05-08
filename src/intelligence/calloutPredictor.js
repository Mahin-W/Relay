import { getDb } from '../db.js'
import { calculateMoraleScore } from './moraleTracker.js'
import { getMoraleEvents } from './moraleDb.js'

/**
 * Get callout history for a specific staff member.
 * Groups by day of week and calculates recent spike data.
 */
export async function getCalloutHistory(groupId, staffId, weeksBack = 8, db = null) {
  let rows
  if (db?.getCalloutHistory) {
    rows = await db.getCalloutHistory(groupId, staffId)
  } else {
    const cutoff = new Date(Date.now() - weeksBack * 7 * 24 * 60 * 60 * 1000).toISOString()
    // coverage_requests has neither day_of_week nor shift_name — they live on
    // the joined shifts row.
    const { data, error } = await getDb()
      .from('coverage_requests')
      .select('matched_shift_id, created_at, shifts:matched_shift_id(name, day_of_week)')
      .eq('group_id', groupId)
      .eq('requester_telegram_id', staffId)
      .gte('created_at', cutoff)
    if (error) throw error
    rows = (data || []).map(r => ({
      day_of_week: r.shifts?.day_of_week,
      shift_name: r.shifts?.name,
      created_at: r.created_at,
    }))
  }

  if (rows.length === 0) {
    return { total: 0, byDay: {}, recentCount: 0, overallRate: 0 }
  }

  const byDay = {}
  let recentCount = 0
  const threeWeeksAgo = Date.now() - 3 * 7 * 24 * 60 * 60 * 1000

  for (const row of rows) {
    const day = row.day_of_week
    byDay[day] = (byDay[day] || 0) + 1

    if (new Date(row.created_at).getTime() >= threeWeeksAgo) {
      recentCount++
    }
  }

  return {
    total: rows.length,
    byDay,
    recentCount,
    overallRate: rows.length / weeksBack
  }
}

/**
 * Pure function: calculate callout probability from weighted signals.
 * Returns { probability, riskLevel, keyFactors }
 */
export function calculateCalloutProbability(signals) {
  if (signals == null || typeof signals !== 'object' || Array.isArray(signals)) {
    return { probability: 0, riskLevel: 'low', keyFactors: [] }
  }
  const {
    historicalCalloutRateThisDay = 0,
    historicalCalloutRateThisShift = 0,
    recentCalloutSpike = false,
    moraleScore = 75,
    moraleTrend = 'stable',
    consecutiveDaysThisWeek = 0,
    totalObservations = 0
  } = signals

  // Weighted probability calculation
  let probability = 0
  const factors = []

  // Day-of-week callout rate: 35% weight
  const dayContribution = historicalCalloutRateThisDay * 0.35
  probability += dayContribution
  if (dayContribution > 0.01) {
    factors.push({ weight: dayContribution, label: `high callout rate on this day` })
  }

  // Shift-specific rate: 25% weight
  const shiftContribution = historicalCalloutRateThisShift * 0.25
  probability += shiftContribution
  if (shiftContribution > 0.01) {
    factors.push({ weight: shiftContribution, label: `high callout rate for this shift` })
  }

  // Recent spike: +0.15
  if (recentCalloutSpike) {
    probability += 0.15
    factors.push({ weight: 0.15, label: `recent callout spike (3+ in 3 weeks)` })
  }

  // Morale: <50 → +0.10, <70 → +0.05
  if (moraleScore < 50) {
    probability += 0.10
    factors.push({ weight: 0.10, label: `low morale (${moraleScore}/100)` })
  } else if (moraleScore < 70) {
    probability += 0.05
    factors.push({ weight: 0.05, label: `moderate morale (${moraleScore}/100)` })
  }

  // Morale trend declining: +0.05
  if (moraleTrend === 'declining') {
    probability += 0.05
    factors.push({ weight: 0.05, label: `morale declining` })
  }

  // Consecutive days >= 5: +0.05
  if (consecutiveDaysThisWeek >= 5) {
    probability += 0.05
    factors.push({ weight: 0.05, label: `${consecutiveDaysThisWeek} consecutive days` })
  }

  // Clamp 0-1
  probability = Math.max(0, Math.min(1, probability))

  // Risk level
  let riskLevel
  if (probability > 0.6) riskLevel = 'critical'
  else if (probability > 0.4) riskLevel = 'high'
  else if (probability >= 0.2) riskLevel = 'medium'
  else riskLevel = 'low'

  // New staff protection: cap at medium if < 3 observations
  if (totalObservations < 3 && (riskLevel === 'high' || riskLevel === 'critical')) {
    riskLevel = 'medium'
  }

  // Top 3 contributing factors
  factors.sort((a, b) => b.weight - a.weight)
  const keyFactors = factors.slice(0, 3).map(f => f.label)

  return { probability, riskLevel, keyFactors }
}

/**
 * Predict callout risks for a set of schedule assignments.
 * Returns only non-low risks, sorted DESC by probability.
 */
export async function predictCalloutRisks(groupId, assignments, db = null) {
  if (!assignments || assignments.length === 0) return []

  const results = []

  for (const assignment of assignments) {
    const { staffId, staffName, shiftName, dayOfWeek, telegramId } = assignment

    // Get callout history
    const history = await getCalloutHistory(groupId, telegramId, 8, db)

    // Get morale
    let moraleScore = 75
    let moraleTrend = 'stable'
    try {
      const events = db?.getMoraleEvents
        ? await db.getMoraleEvents(groupId, staffId)
        : await getMoraleEvents(groupId, staffId, 8, db)
      const morale = calculateMoraleScore(events)
      moraleScore = morale.score
      moraleTrend = morale.trend
    } catch {
      // Default morale if unavailable
    }

    // Get consecutive days
    let consecutiveDays = 0
    if (db?.getConsecutiveDays) {
      consecutiveDays = await db.getConsecutiveDays(groupId, staffId, dayOfWeek)
    }

    // Build signals
    const dayCallouts = history.byDay[dayOfWeek] || 0
    const totalWeeks = 8
    const signals = {
      historicalCalloutRateThisDay: history.total > 0 ? dayCallouts / totalWeeks : 0,
      historicalCalloutRateThisShift: history.total > 0 ? history.overallRate / 1 : 0, // overallRate is total/weeksBack already
      recentCalloutSpike: history.recentCount >= 3,
      moraleScore,
      moraleTrend,
      consecutiveDaysThisWeek: consecutiveDays,
      totalObservations: history.total
    }

    const prediction = calculateCalloutProbability(signals)

    if (prediction.riskLevel !== 'low') {
      results.push({
        staffId,
        staffName,
        shiftName,
        dayOfWeek,
        probability: prediction.probability,
        riskLevel: prediction.riskLevel,
        keyFactors: prediction.keyFactors
      })
    }
  }

  // Sort DESC by probability
  results.sort((a, b) => b.probability - a.probability)
  return results
}

/**
 * Format callout risk section for manager briefing.
 * Returns null if empty or insufficient data.
 */
export function formatCalloutRiskSection(risks, weeksOfData = 0) {
  if (!risks || risks.length === 0) return null
  if (weeksOfData < 4) return null

  let text = '\u{1F3AF} *Pre-publish coverage risk:*\n'

  for (const risk of risks) {
    const pct = Math.round(risk.probability * 100)
    const emoji = (risk.riskLevel === 'critical' || risk.riskLevel === 'high') ? '\u{1F534}' : '\u{1F7E1}'
    text += `\n${emoji} ${risk.staffName} \u2014 ${risk.dayOfWeek} ${risk.shiftName} (${pct}% callout risk)\n`
    if (risk.keyFactors.length > 0) {
      text += `   ${risk.keyFactors.join(', ')}\n`
    }
  }

  text += '\nThese are predictions, not certainties.'
  return text
}
