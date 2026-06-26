import { getDb } from '../db.js'
import { logger } from '../logger.js'
import { saveWeeklyQualityScore, getQualityHistory } from './scheduleQualityDb.js'

// ── collectWeekMetrics ───────────────────────────────────────────────────────
// Accepts either a Supabase-shaped client (with `.from(...)`) or a named-method
// db (with `getEditHistory`, `getCoverageRequestsForGroup`, etc.) so this can
// be exercised in unit tests without a live DB connection.

export async function collectWeekMetrics(groupId, weekStart, db = null) {
  const _db = db ?? getDb()
  const gid = String(groupId)

  // Calculate week boundaries
  const weekEnd = new Date(weekStart)
  weekEnd.setDate(weekEnd.getDate() + 7)
  const weekStartDate = new Date(weekStart)
  const weekStartISO = weekStartDate.toISOString()
  const weekEndISO = weekEnd.toISOString()

  // Prefer named methods (SimulationDb / production helpers) when present;
  // only fall back to PostgREST-style `.from(...).select(...)` chain when there
  // is no specific helper. SimulationDb's Proxy returns a generic async stub
  // for `.from`, which masquerades as Supabase-shaped — so we can't trust the
  // existence of `.from` alone.
  async function fetchTable(tableName, namedMethod, supabaseQuery) {
    if (namedMethod && typeof _db?.[namedMethod] === 'function') {
      try { return (await _db[namedMethod]()) ?? [] }
      catch { return [] }
    }
    if (typeof _db?.from !== 'function') return []
    try {
      const builder = _db.from(tableName)
      if (!builder || typeof builder.select !== 'function') return []
      const r = await supabaseQuery(builder)
      return r?.data ?? []
    } catch { return [] }
  }

  // 1. Draft edits
  const edits = await fetchTable(
    'schedule_edit_events',
    null,
    (b) => b.select('*').eq('group_id', gid).eq('week_start', weekStart),
  )
  // SimulationDb-friendly shortcut for edit history
  let editsList = edits
  if (editsList.length === 0 && typeof _db?.getEditHistory === 'function') {
    const all = await _db.getEditHistory(gid, 52)
    editsList = (all || []).filter(e => e.week_start === weekStart)
  }
  const draftEdits = editsList.length

  // 2. Coverage requests (created_at within the week)
  let covReqs = []
  if (typeof _db?.getCoverageRequestsForGroup === 'function') {
    const all = await _db.getCoverageRequestsForGroup(gid, 8)
    covReqs = (all || []).filter(c => {
      const t = new Date(c.created_at).getTime()
      return t >= weekStartDate.getTime() && t < weekEnd.getTime()
    })
  } else {
    covReqs = await fetchTable(
      'coverage_requests',
      null,
      (b) => b.select('*').eq('group_id', gid).gte('created_at', weekStartISO).lt('created_at', weekEndISO),
    )
  }
  const coverageRequests = covReqs.length

  // 3. No-shows
  let noShowEvents = []
  if (typeof _db?.getReliabilityEventsForGroup === 'function') {
    const all = await _db.getReliabilityEventsForGroup(gid, 8)
    noShowEvents = (all || []).filter(e => {
      const t = new Date(e.recorded_at ?? e.created_at).getTime()
      return e.event_type === 'no_call_no_show' && t >= weekStartDate.getTime() && t < weekEnd.getTime()
    })
  } else {
    noShowEvents = await fetchTable(
      'staff_reliability_events',
      null,
      (b) => b.select('*').eq('group_id', gid).eq('event_type', 'no_call_no_show').gte('recorded_at', weekStartISO).lt('recorded_at', weekEndISO),
    )
  }
  const noShows = noShowEvents.length

  // 4. Avg fill minutes (covered requests only)
  const coveredReqs = covReqs.filter(r => r.covered_at)
  let avgFillMinutes = null
  if (coveredReqs.length > 0) {
    const totalMinutes = coveredReqs.reduce((sum, r) => {
      const created = new Date(r.created_at)
      const covered = new Date(r.covered_at)
      return sum + (covered - created) / 60000
    }, 0)
    avgFillMinutes = Math.round(totalMinutes / coveredReqs.length)
  }

  // 5. Unconfirmed receipts
  let unconfirmed = []
  if (typeof _db?.getUnconfirmedSchedule === 'function') {
    unconfirmed = await _db.getUnconfirmedSchedule(gid, weekStart)
  } else {
    unconfirmed = await fetchTable(
      'schedule_receipts',
      null,
      (b) => b.select('*').eq('group_id', gid).eq('week_start', weekStart).eq('status', 'sent'),
    )
  }
  const unconfirmedCount = (unconfirmed || []).length

  // 6. Staff scheduled (distinct staff_id)
  let assignments = []
  if (typeof _db?.getScheduleAssignments === 'function') {
    assignments = await _db.getScheduleAssignments(gid, weekStart)
  } else {
    assignments = await fetchTable(
      'schedule_assignments',
      null,
      (b) => b.select('*').eq('group_id', gid).eq('week_start', weekStart),
    )
  }
  const staffIds = new Set((assignments || []).map(a => a.staff_id))
  const staffScheduled = staffIds.size

  return { draftEdits, coverageRequests, noShows, avgFillMinutes, unconfirmedCount, staffScheduled }
}

// ── calculateQualityScore (pure) ─────────────────────────────────────────────

export function calculateQualityScore(metrics, staffScheduled) {
  let score = 100
  const safe = Math.max(staffScheduled, 1)

  // Draft edits deduction
  let editsDeduction = 0
  if (metrics.draftEdits >= 6) editsDeduction = 20
  else if (metrics.draftEdits >= 3) editsDeduction = 10
  else if (metrics.draftEdits >= 1) editsDeduction = 5

  // Coverage requests (normalized per 10 staff)
  const normalized = Math.round(metrics.coverageRequests * 10 / safe)
  let coverageDeduction = 0
  if (normalized >= 3) coverageDeduction = 30
  else if (normalized >= 2) coverageDeduction = 20
  else if (normalized >= 1) coverageDeduction = 10

  // No-shows
  let noShowsDeduction = 0
  if (metrics.noShows >= 2) noShowsDeduction = 20
  else if (metrics.noShows >= 1) noShowsDeduction = 10

  // Fill time (only when there are coverage requests)
  let fillTimeDeduction = 0
  if (metrics.coverageRequests > 0 && metrics.avgFillMinutes != null) {
    if (metrics.avgFillMinutes >= 60) fillTimeDeduction = 15
    else if (metrics.avgFillMinutes >= 30) fillTimeDeduction = 10
    else if (metrics.avgFillMinutes >= 10) fillTimeDeduction = 5
  }

  // Unconfirmed (as % of staff)
  const unconfirmedPct = (metrics.unconfirmedCount / safe) * 100
  let unconfirmedDeduction = 0
  if (unconfirmedPct >= 50) unconfirmedDeduction = 15
  else if (unconfirmedPct >= 20) unconfirmedDeduction = 10
  else if (unconfirmedPct > 0) unconfirmedDeduction = 5

  // Labor-law compliance violations (Epic 4 / WP-4.5). Defaults to 0 when the
  // caller doesn't supply the metric, so existing scores are unaffected.
  const complianceViolations = metrics.complianceViolations ?? 0
  let complianceDeduction = 0
  if (complianceViolations >= 3) complianceDeduction = 25
  else if (complianceViolations >= 1) complianceDeduction = 15

  score -= editsDeduction + coverageDeduction + noShowsDeduction + fillTimeDeduction + unconfirmedDeduction + complianceDeduction
  score = Math.max(0, Math.min(100, score))

  const grade = score >= 90 ? 'A' : score >= 80 ? 'B' : score >= 70 ? 'C' : score >= 60 ? 'D' : 'F'

  return {
    score,
    grade,
    deductions: {
      edits: editsDeduction,
      coverage: coverageDeduction,
      noShows: noShowsDeduction,
      fillTime: fillTimeDeduction,
      unconfirmed: unconfirmedDeduction,
      compliance: complianceDeduction,
    },
  }
}

// ── detectQualityTrend (pure) ────────────────────────────────────────────────

export function detectQualityTrend(history) {
  if (history.length < 3) return { trend: 'insufficient_data' }

  const recent = history.slice(-3)
  const prior = history.slice(Math.max(0, history.length - 6), -3)

  const recentAvg = Math.round(recent.reduce((s, h) => s + h.score, 0) / recent.length)

  if (prior.length === 0) {
    return { trend: 'insufficient_data', recentAvg, priorAvg: null, delta: null }
  }

  const priorAvg = Math.round(prior.reduce((s, h) => s + h.score, 0) / prior.length)
  const delta = recentAvg - priorAvg

  let trend = 'stable'
  if (delta > 5) trend = 'improving'
  else if (delta < -5) trend = 'declining'

  return { trend, recentAvg, priorAvg, delta }
}

// ── calculateWeeklyQualityScore (orchestrator) ───────────────────────────────

export async function calculateWeeklyQualityScore(groupId, weekStart, db = null) {
  const metrics = await collectWeekMetrics(groupId, weekStart, db)
  const result = calculateQualityScore(metrics, metrics.staffScheduled)

  const history = await getQualityHistory(groupId, 52, db)
  const weeksOfData = history.length + 1

  await saveWeeklyQualityScore(groupId, weekStart, {
    score: result.score,
    grade: result.grade,
    draftEdits: metrics.draftEdits,
    coverageRequests: metrics.coverageRequests,
    noShows: metrics.noShows,
    avgFillMinutes: metrics.avgFillMinutes,
    unconfirmedCount: metrics.unconfirmedCount,
    weeksOfData,
  }, db)

  return { score: result.score, grade: result.grade, metrics, weekStart }
}

// ── formatQualityTrend (pure) ────────────────────────────────────────────────

export function formatQualityTrend(history, currentWeek) {
  const allWeeks = [...history, currentWeek]
  const trendData = detectQualityTrend(allWeeks)

  const trendEmoji = trendData.trend === 'improving' ? 'Improving'
    : trendData.trend === 'declining' ? 'Declining'
    : trendData.trend === 'stable' ? 'Stable'
    : 'Insufficient data'

  const trendArrow = trendData.trend === 'improving' ? '\u2191'
    : trendData.trend === 'declining' ? '\u2193'
    : '\u2192'

  let lines = [`\uD83D\uDCC8 *Schedule quality \u2014 last ${allWeeks.length} weeks*\n`]

  for (const week of history) {
    lines.push(`Week of ${week.weekStart}: ${week.grade} (${week.score}/100)`)
  }
  lines.push(`Current week: ${currentWeek.grade} (${currentWeek.score}/100)`)

  lines.push(`\nTrend: ${trendArrow} ${trendEmoji}`)

  if (trendData.trend === 'improving' && trendData.delta != null) {
    lines.push(`Up ${trendData.delta} points from prior average (${trendData.priorAvg} \u2192 ${trendData.recentAvg})`)
  }

  return lines.join('\n')
}

// ── formatQualitySummary (pure, one-liner for briefing) ──────────────────────

export function formatQualitySummary(current, trend) {
  const trendEmoji = trend.trend === 'improving' ? '\u2191'
    : trend.trend === 'declining' ? '\u2193'
    : '\u2192'

  if (current.score >= 70) {
    return `\uD83D\uDCCA Schedule quality: ${current.grade} (${current.score}/100) ${trendEmoji}`
  }

  // Find top deduction for low scores
  const deductions = current.deductions || {}
  const reasons = {
    edits: 'high draft edits',
    coverage: 'coverage requests',
    noShows: 'no-shows',
    fillTime: 'slow fill times',
    unconfirmed: 'unconfirmed schedules',
  }
  let topReason = 'multiple issues'
  let topVal = 0
  for (const [key, val] of Object.entries(deductions)) {
    if (val > topVal) { topVal = val; topReason = reasons[key] || key }
  }

  return `\uD83D\uDCCA Schedule quality: ${current.grade} (${current.score}/100) \u2014 ${topReason}`
}

// ── handleQualityCommand ─────────────────────────────────────────────────────

export async function handleQualityCommand(bot, msg, db = null) {
  const groupId = String(msg.chat.id)
  const managerId = String(msg.from.id)

  const history = await getQualityHistory(groupId, 12, db)

  if (history.length === 0) {
    await bot.sendMessage(managerId, 'Not enough data yet. Quality tracking starts after your first published week.')
    return
  }

  const current = history[history.length - 1]
  const priorWeeks = history.slice(0, -1)

  const text = formatQualityTrend(priorWeeks, {
    score: current.score,
    grade: current.grade,
    weekStart: current.weekStart,
  })

  await bot.sendMessage(managerId, text, { parse_mode: 'Markdown' })
}
