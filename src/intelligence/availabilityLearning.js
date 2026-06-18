import { getDb as _getDb } from '../db.js'
import { getAvailabilityHistory } from './availabilityLearningDb.js'

const DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']

/**
 * Calculate reliable availability for a staff member per day of week.
 * Recent weeks (last 3) are weighted 2x vs older weeks.
 */
export async function calculateReliableAvailability(staffId, groupId, weeksBack = 8, db = null) {
  const client = db ?? _getDb()
  const history = await getAvailabilityHistory(groupId, staffId, weeksBack, client)

  // Determine unique weeks for weeksAnalyzed
  const uniqueWeeks = new Set(history.map((r) => r.weekStart))
  const weeksAnalyzed = uniqueWeeks.size

  // Split into recent (last 3 weeks by date) and older
  const sortedWeeks = [...uniqueWeeks].sort().reverse()
  const recentWeekSet = new Set(sortedWeeks.slice(0, 3))

  const dayReliability = {}
  let worstDay = null
  let worstRate = Infinity

  for (const day of DAYS) {
    const dayRecords = history.filter((r) => r.dayOfWeek === day && r.statedAvailable)
    const statedCount = dayRecords.length

    if (statedCount < 2) {
      dayReliability[day] = { rate: 0, status: 'unknown', statedCount, workedCount: 0 }
      continue
    }

    const recentRecords = dayRecords.filter((r) => recentWeekSet.has(r.weekStart))
    const olderRecords = dayRecords.filter((r) => !recentWeekSet.has(r.weekStart))

    const recentWorked = recentRecords.filter((r) => r.actualOutcome === 'worked').length
    const recentStated = recentRecords.length
    const olderWorked = olderRecords.filter((r) => r.actualOutcome === 'worked').length
    const olderStated = olderRecords.length
    const totalWorked = dayRecords.filter((r) => r.actualOutcome === 'worked').length

    let rate
    if (recentStated > 0) {
      // Weighted: recent 2x
      rate = (recentWorked * 2 + olderWorked) / (recentStated * 2 + olderStated)
    } else {
      // No recent data — use raw
      rate = totalWorked / statedCount
    }

    let status
    if (rate >= 0.8) status = 'reliable'
    else if (rate >= 0.5) status = 'unreliable'
    else status = 'avoid'

    dayReliability[day] = { rate, status, statedCount, workedCount: totalWorked }

    if (status !== 'unknown' && rate < worstRate) {
      worstRate = rate
      worstDay = day
    }
  }

  // Only report mostUnreliableDay if it's actually problematic
  if (worstDay && dayReliability[worstDay].status === 'reliable') {
    worstDay = null
  }

  // Generate pattern note
  let patternNote = null
  const avoidDays = Object.entries(dayReliability)
    .filter(([, v]) => v.status === 'avoid')
    .map(([d]) => d)
  if (avoidDays.length > 0) {
    patternNote = `Consistently unavailable on ${avoidDays.join(', ')} despite stating available`
  }

  // Get staff name
  let staffName = staffId
  try {
    const { data: members } = await client
      .from('staff')
      .select('name')
      .eq('telegram_user_id', staffId)
      .eq('group_id', groupId)
    if (members && members.length > 0) staffName = members[0].name
  } catch {
    // Keep staffId as name
  }

  return {
    staffId,
    staffName,
    weeksAnalyzed,
    dayReliability,
    mostUnreliableDay: worstDay,
    patternNote,
  }
}

/**
 * Pure function: flag assignments where staff has 'avoid' status for that day.
 * Only flags when weeksAnalyzed >= minimumWeeks.
 */
export function applyLearnedAvailability(assignments, reliabilityMap, minimumWeeks = 4) {
  const risks = []
  const flaggedAssignments = assignments.map((a) => {
    const reliability = reliabilityMap.get(a.staffId)
    if (!reliability) return a
    if (reliability.weeksAnalyzed < minimumWeeks) return a

    const dayInfo = reliability.dayReliability[a.dayOfWeek]
    if (!dayInfo || dayInfo.status !== 'avoid') return a

    risks.push({
      staffId: a.staffId,
      staffName: reliability.staffName,
      dayOfWeek: a.dayOfWeek,
      reliabilityRate: dayInfo.rate,
    })
    return { ...a, availability_risk: true }
  })

  return { assignments: flaggedAssignments, risks }
}

/**
 * Pure function: format an availability insight message for managers.
 */
export function formatAvailabilityInsight(staffName, reliability) {
  const lines = [`\uD83D\uDCCA *${staffName}'s actual availability pattern:*`, '']

  // Stated availability summary
  const statedDays = Object.entries(reliability.dayReliability)
    .filter(([, v]) => v.statedCount > 0)
    .map(([d]) => d)
  if (statedDays.length > 0) {
    lines.push(`Stated: available ${statedDays.join(', ')}`)
  }

  lines.push(`Reality (last ${reliability.weeksAnalyzed} weeks):`)

  for (const [day, info] of Object.entries(reliability.dayReliability)) {
    if (info.statedCount === 0) continue
    const pct = Math.round(info.rate * 100)
    const icon = info.status === 'reliable' ? '\u2705' : info.status === 'avoid' ? '\u26A0\uFE0F' : '\uD83D\uDD36'
    lines.push(`\u2022 ${day}: worked ${info.workedCount}/${info.statedCount} times (${pct}%) ${icon}`)
  }

  if (reliability.mostUnreliableDay) {
    lines.push('')
    lines.push(`I've flagged ${reliability.mostUnreliableDay} assignments for review.`)
  }

  return lines.join('\n')
}

/**
 * Detect staff with significant stated-vs-actual availability gaps.
 * Returns staff where ANY day has status='avoid' AND weeksAnalyzed >= 4.
 */
export async function detectStatedVsActualGap(groupId, db = null) {
  const client = db ?? _getDb()

  // Get all staff for group
  let staffMembers
  try {
    const { data } = await client
      .from('staff')
      .select('telegram_user_id, name')
      .eq('group_id', groupId)
      .order('name')
    staffMembers = data || []
  } catch {
    return []
  }

  if (staffMembers.length === 0) return []

  const results = []
  for (const member of staffMembers) {
    const reliability = await calculateReliableAvailability(
      member.telegram_user_id, groupId, 8, client
    )
    if (reliability.weeksAnalyzed < 4) continue

    const hasAvoidDay = Object.values(reliability.dayReliability)
      .some((d) => d.status === 'avoid')

    if (hasAvoidDay) {
      results.push(reliability)
    }
  }

  return results
}

/**
 * Pure function: format risk section for schedule draft DM.
 * Returns null if no risks.
 */
export function formatAvailabilityRiskSection(risks) {
  if (!risks || risks.length === 0) return null

  const lines = ['\u26A0\uFE0F *Availability patterns flagged:*']
  for (const risk of risks) {
    const pct = Math.round(risk.reliabilityRate * 100)
    lines.push(`${risk.staffName} on ${risk.dayOfWeek} \u2014 historically shows as available but worked only ${pct}% of the time`)
  }
  return lines.join('\n')
}
