import { createClient } from '@supabase/supabase-js'

const supabase = (process.env.SUPABASE_URL && process.env.SUPABASE_ANON_KEY)
  ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY)
  : null

/**
 * Analyze coverage request patterns for a group over the last N weeks.
 * Returns array of pattern objects (frequent_callout, reliable_coverage).
 */
export async function analyzeCoveragePatterns(groupId, weeksBack = 6, db = null) {
  // Get raw coverage history
  let coverageRows
  if (db?.getCoverageHistory) {
    coverageRows = await db.getCoverageHistory(groupId, weeksBack)
  } else {
    const cutoff = new Date(Date.now() - weeksBack * 7 * 24 * 60 * 60 * 1000).toISOString()
    const { data, error } = await supabase
      .from('coverage_requests')
      .select('requested_by, requester_telegram_id, day_of_week, shift_name, created_at, status')
      .eq('group_id', groupId)
      .gte('created_at', cutoff)
    if (error) throw error
    coverageRows = data || []
  }

  // Get schedule history (how many times each person was scheduled per day/shift)
  let scheduleRows
  if (db?.getScheduleHistory) {
    scheduleRows = await db.getScheduleHistory(groupId, weeksBack)
  } else {
    const cutoff = new Date(Date.now() - weeksBack * 7 * 24 * 60 * 60 * 1000).toISOString()
    const { data, error } = await supabase
      .from('schedule_assignments')
      .select('staff_id, staff_name, day_of_week, shift_name')
      .eq('group_id', groupId)
      .gte('created_at', cutoff)
    if (error) throw error
    // Group and count
    const counts = {}
    for (const row of (data || [])) {
      const key = `${row.staff_id}|${row.day_of_week}|${row.shift_name}`
      if (!counts[key]) {
        counts[key] = { staff_id: row.staff_id, staff_name: row.staff_name, day_of_week: row.day_of_week, shift_name: row.shift_name, count: 0 }
      }
      counts[key].count++
    }
    scheduleRows = Object.values(counts)
  }

  // Get reliable coverers
  let reliableCoverers
  if (db?.getReliableCoverers) {
    reliableCoverers = await db.getReliableCoverers(groupId, weeksBack)
  } else {
    // Default: empty — real implementation would query coverage confirmations
    reliableCoverers = []
  }

  const patterns = []

  // Group callouts by (staffId, dayOfWeek, shiftName)
  const calloutMap = {}
  for (const row of coverageRows) {
    const key = `${row.requester_telegram_id}|${row.day_of_week}|${row.shift_name}`
    if (!calloutMap[key]) {
      calloutMap[key] = {
        staffId: row.requester_telegram_id,
        staffName: row.requested_by,
        dayOfWeek: row.day_of_week,
        shiftName: row.shift_name,
        calloutCount: 0,
        lastCalloutDate: null
      }
    }
    calloutMap[key].calloutCount++
    if (!calloutMap[key].lastCalloutDate || row.created_at > calloutMap[key].lastCalloutDate) {
      calloutMap[key].lastCalloutDate = row.created_at
    }
  }

  // Build schedule lookup for totalScheduled
  const scheduleLookup = {}
  for (const row of scheduleRows) {
    const key = `${row.staff_id}|${row.day_of_week}|${row.shift_name}`
    scheduleLookup[key] = row.count
  }

  // Detect frequent callouts
  for (const [key, info] of Object.entries(calloutMap)) {
    const totalScheduled = scheduleLookup[key] || info.calloutCount
    const calloutRate = totalScheduled > 0 ? info.calloutCount / totalScheduled : 0

    if (calloutRate >= 0.5 && info.calloutCount >= 2) {
      patterns.push({
        staffId: info.staffId,
        staffName: info.staffName,
        dayOfWeek: info.dayOfWeek,
        shiftName: info.shiftName,
        calloutCount: info.calloutCount,
        totalScheduled,
        calloutRate,
        lastCalloutDate: info.lastCalloutDate,
        pattern: 'frequent_callout'
      })
    }
  }

  // Detect reliable coverers (3+ coverages)
  for (const coverer of reliableCoverers) {
    if (coverer.coverage_count >= 3) {
      patterns.push({
        staffId: coverer.staff_id,
        staffName: coverer.staff_name,
        dayOfWeek: null,
        shiftName: null,
        calloutCount: 0,
        totalScheduled: 0,
        calloutRate: 0,
        lastCalloutDate: null,
        pattern: 'reliable_coverage'
      })
    }
  }

  return patterns
}

/**
 * Analyze who responds fastest and most reliably to coverage requests.
 * Returns top 3 candidates sorted by reliability score.
 */
export async function analyzeOnCallCandidates(groupId, db = null) {
  let rows
  if (db?.getOnCallHistory) {
    rows = await db.getOnCallHistory(groupId)
  } else {
    const { data, error } = await supabase
      .from('coverage_confirmations')
      .select('covered_by, staff_id, response_minutes, created_at')
      .eq('group_id', groupId)
    if (error) throw error
    rows = data || []
  }

  if (rows.length === 0) return []

  // Group by staff_id
  const staffMap = {}
  for (const row of rows) {
    if (!staffMap[row.staff_id]) {
      staffMap[row.staff_id] = { staffId: row.staff_id, staffName: row.covered_by, totalMinutes: 0, count: 0 }
    }
    staffMap[row.staff_id].totalMinutes += row.response_minutes
    staffMap[row.staff_id].count++
  }

  // Calculate scores and sort
  const candidates = Object.values(staffMap).map(s => {
    const avgResponseMinutes = Math.round(s.totalMinutes / s.count)
    // Score: higher is better. Reward count, penalize slow response.
    const reliabilityScore = Math.round((s.count / (1 + avgResponseMinutes / 60)) * 100) / 100
    return {
      staffId: s.staffId,
      staffName: s.staffName,
      avgResponseMinutes,
      coverageCount: s.count,
      reliabilityScore
    }
  })

  candidates.sort((a, b) => b.reliabilityScore - a.reliabilityScore)
  return candidates.slice(0, 3)
}

/**
 * Generate pre-publish alerts by cross-referencing patterns with draft assignments.
 */
export async function generatePrePublishAlerts(groupId, assignments, shifts, db = null) {
  // Get patterns — use db-level mock if available, otherwise call our own functions
  let patterns
  if (db?.analyzeCoveragePatterns) {
    patterns = await db.analyzeCoveragePatterns(groupId)
  } else {
    patterns = await analyzeCoveragePatterns(groupId, 6, db)
  }

  let candidates
  if (db?.analyzeOnCallCandidates) {
    candidates = await db.analyzeOnCallCandidates(groupId)
  } else {
    candidates = await analyzeOnCallCandidates(groupId, db)
  }

  const alerts = []

  // Cross-reference frequent callout patterns with assignments
  const calloutPatterns = patterns.filter(p => p.pattern === 'frequent_callout')
  for (const pattern of calloutPatterns) {
    const match = assignments.find(a =>
      a.staffId === pattern.staffId &&
      a.dayOfWeek === pattern.dayOfWeek &&
      a.shiftName === pattern.shiftName
    )
    if (match) {
      alerts.push({
        severity: 'warning',
        type: 'callout_risk',
        staffName: pattern.staffName,
        shiftName: pattern.shiftName,
        dayOfWeek: pattern.dayOfWeek,
        calloutCount: pattern.calloutCount,
        totalScheduled: pattern.totalScheduled,
        message: `${pattern.staffName} has called out ${pattern.calloutCount} of the last ${pattern.totalScheduled} ${pattern.dayOfWeek} shifts. You've scheduled them this ${pattern.dayOfWeek}.`
      })
    }
  }

  // On-call suggestions
  for (const candidate of candidates) {
    alerts.push({
      severity: 'info',
      type: 'on_call_suggestion',
      staffName: candidate.staffName,
      shiftName: null,
      dayOfWeek: null,
      message: `${candidate.staffName} picks up coverage fast — good on-call candidate if needed.`
    })
  }

  // Sort: warnings first, then info
  alerts.sort((a, b) => {
    if (a.severity === 'warning' && b.severity !== 'warning') return -1
    if (a.severity !== 'warning' && b.severity === 'warning') return 1
    return 0
  })

  return alerts
}

/**
 * Format pre-publish alerts into a Telegram message string.
 * Returns null if no alerts.
 */
export function formatPrePublishAlerts(alerts, weeksBack = 6) {
  if (!alerts || alerts.length === 0) return null

  // Sort warnings before info
  const sorted = [...alerts].sort((a, b) => {
    if (a.severity === 'warning' && b.severity !== 'warning') return -1
    if (a.severity !== 'warning' && b.severity === 'warning') return 1
    return 0
  })

  let text = `🔍 *Based on the past ${weeksBack} weeks:*\n`

  for (const alert of sorted) {
    if (alert.severity === 'warning') {
      text += `\n⚠️ ${alert.message}\n`
    } else {
      text += `\n💡 ${alert.message}\n`
    }
  }

  return text
}
