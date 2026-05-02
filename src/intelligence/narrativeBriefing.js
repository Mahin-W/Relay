import { llmCreate, llmWithRetry } from '../parsers/llm.js'
import { logger } from '../logger.js'
import { generateTurnoverRiskReport, formatTurnoverRiskAlert } from './turnoverRisk.js'

// Default functions returning empty/zero values
const emptyStats = () => ({ total: 0, avgFillMinutes: 0, fastestFillMinutes: 0, fullyFilled: 0, partial: 0 })
const emptyLate = () => ({ count: 0, totalMinutes: 0, worstOffender: null })
const emptyNoShows = () => ({ count: 0, names: [] })
const emptyArray = () => []
const zero = () => 0
const nullVal = () => null

export async function compileWeeklyStats(groupId, weekStart, db = null) {
  const [
    coverageRequests,
    lateArrivals,
    noShows,
    topReliableStaff,
    unconfirmedSchedules,
    understaffedShifts,
    overtimeStaff,
    payrollTotal,
    laborPercent,
    moraleAlerts,
    totalShifts,
  ] = await Promise.all([
    (db?.getCoverageStatsForWeek ?? emptyStats)(groupId, weekStart),
    (db?.getLateArrivalsForWeek ?? emptyLate)(groupId, weekStart),
    (db?.getNoShowsForWeek ?? emptyNoShows)(groupId, weekStart),
    (db?.getTopReliableStaff ?? emptyArray)(groupId),
    (db?.getUnconfirmedSchedules ?? emptyArray)(groupId),
    (db?.getUnderstaffedShifts ?? emptyArray)(groupId, weekStart),
    (db?.getOvertimeStaff ?? emptyArray)(groupId, weekStart),
    (db?.getPayrollTotal ?? zero)(groupId, weekStart),
    (db?.getLaborPercent ?? nullVal)(groupId, weekStart),
    (db?.getMoraleAlertsForWeek ?? emptyArray)(groupId),
    (db?.getTotalShifts ?? zero)(groupId, weekStart),
  ])

  const shiftsWithIssues = (lateArrivals?.count ?? 0) + (noShows?.count ?? 0)

  let turnoverRisk = null
  try {
    turnoverRisk = await generateTurnoverRiskReport(groupId, db)
  } catch (e) {
    turnoverRisk = null
  }

  return {
    weekStart,
    totalShifts,
    shiftsWithIssues,
    coverageRequests,
    lateArrivals,
    noShows,
    topReliableStaff,
    unconfirmedSchedules,
    understaffedShifts,
    overtimeStaff,
    payrollTotal,
    laborPercent,
    moraleAlerts,
    turnoverRisk,
  }
}

function buildFallbackNarrative(stats) {
  const parts = []

  if (stats.totalShifts > 0) {
    parts.push(`This week had ${stats.totalShifts} scheduled shifts.`)
  }

  if (stats.coverageRequests.total > 0) {
    const filled = stats.coverageRequests.fullyFilled
    parts.push(`${stats.coverageRequests.total} coverage requests came in, ${filled} were fully filled.`)
  }

  if (stats.topReliableStaff.length > 0) {
    parts.push(`${stats.topReliableStaff[0].name} was the most reliable team member.`)
  }

  if (stats.noShows.count > 0) {
    parts.push(`There were ${stats.noShows.count} no-show${stats.noShows.count > 1 ? 's' : ''}.`)
  }

  if (stats.lateArrivals.count > 0) {
    parts.push(`${stats.lateArrivals.count} late arrival${stats.lateArrivals.count > 1 ? 's' : ''} totaling ${stats.lateArrivals.totalMinutes} minutes.`)
  }

  if (stats.overtimeStaff.length > 0) {
    const names = stats.overtimeStaff.map(s => `${s.name} (${s.hours}h)`).join(', ')
    parts.push(`Overtime: ${names}.`)
  }

  return parts.join(' ') || 'No significant activity this week.'
}

export async function generateNarrativeBriefing(groupId, weekStart, db = null) {
  const stats = await compileWeeklyStats(groupId, weekStart, db)

  if (stats.totalShifts === 0 && stats.coverageRequests.total === 0) {
    return null
  }

  const systemPrompt = 'You write weekly briefings for restaurant managers. Write 3-5 sentences, past tense, direct. Positive things first. Problems second. Forward-looking note at end if relevant. Never invent facts — only use provided data. No bullet points. No headers. Conversational. Under 150 words.'
  const userPrompt = `Write a weekly briefing for a restaurant manager. Data: ${JSON.stringify(stats)}`

  try {
    const response = await llmWithRetry(() =>
      llmCreate({
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        temperature: 0.3,
        max_tokens: 250,
      })
    )

    const narrative = response.choices[0]?.message?.content?.trim()
    if (!narrative) {
      throw new Error('Empty LLM response')
    }

    return { narrative, stats }
  } catch (err) {
    logger.error('LLM briefing failed, using fallback:', err.message)
    return { narrative: buildFallbackNarrative(stats), stats }
  }
}

export function formatSundayBriefing(narrative, stats) {
  const lines = []

  lines.push(`\u{1F4CB} *Week of ${stats.weekStart} — Summary*`)
  lines.push('')
  lines.push(narrative)

  if (stats.unconfirmedSchedules && stats.unconfirmedSchedules.length > 0) {
    lines.push('')
    lines.push(`\u{26A0}\u{FE0F} Still unconfirmed: ${stats.unconfirmedSchedules.join(', ')}`)
  }

  if (stats.moraleAlerts && stats.moraleAlerts.length > 0) {
    for (const alert of stats.moraleAlerts) {
      lines.push('')
      lines.push(`\u{1F440} ${alert.staffName} may need a check-in \u{2014} ${alert.reasons.join(', ')}.`)
    }
  }

  if (stats.turnoverRisk) {
    const riskAlert = formatTurnoverRiskAlert(stats.turnoverRisk)
    if (riskAlert) {
      lines.push('')
      lines.push(riskAlert)
    }
  }

  lines.push('')
  lines.push('Have a good week.')

  return lines.join('\n')
}
