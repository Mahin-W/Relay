import cron from 'node-cron'
import { createClient } from '@supabase/supabase-js'
import { logger } from '../logger.js'
import { getSetupSession as liveGetSetupSession } from '../setup/setupDb.js'
import { getClockComplianceReport, formatComplianceSection } from '../timeclock/clockAlerts.js'

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY)

// ── DB helpers (live implementations) ────────────────────────────────────

async function getTodaysAssignments(groupId) {
  try {
    const now = new Date()
    const day = now.getDay()
    const diff = day === 0 ? -6 : 1 - day
    const monday = new Date(now)
    monday.setDate(now.getDate() + diff)
    const weekStart = monday.toISOString().split('T')[0]

    const { data, error } = await supabase
      .from('schedule_assignments')
      .select('staff:staff(name), shift:shifts(name, start_time, day_of_week)')
      .eq('group_id', groupId)
      .eq('week_start', weekStart)
    if (error) throw error
    return data ?? []
  } catch (err) {
    logger.error(`getTodaysAssignments error: ${err.message}`)
    return []
  }
}

async function getOpenCoverageRequests(groupId) {
  try {
    const { data, error } = await supabase
      .from('coverage_requests')
      .select('shift_description, requested_by, status, created_at')
      .eq('group_id', groupId)
      .eq('status', 'open')
      .order('created_at', { ascending: false })
    if (error) throw error
    return data ?? []
  } catch (err) {
    logger.error(`getOpenCoverageRequests error: ${err.message}`)
    return []
  }
}

async function getPendingTimeOff(groupId) {
  try {
    const { data, error } = await supabase
      .from('time_off_requests')
      .select('staff_name, requested_date, status')
      .eq('group_id', groupId)
      .eq('status', 'pending')
      .order('created_at', { ascending: false })
    if (error) throw error
    return data ?? []
  } catch (err) {
    // time_off table may not exist yet — return empty gracefully
    return []
  }
}

async function getUnconfirmedSchedule(groupId) {
  try {
    const now = new Date()
    const day = now.getDay()
    const diff = day === 0 ? -6 : 1 - day
    const monday = new Date(now)
    monday.setDate(now.getDate() + diff)
    const weekStart = monday.toISOString().split('T')[0]

    const { data, error } = await supabase
      .from('schedule_receipts')
      .select('staff:staff(name), status')
      .eq('group_id', groupId)
      .eq('week_start', weekStart)
      .eq('status', 'sent')
    if (error) throw error
    return (data ?? []).map(r => ({
      staffName: r.staff?.name ?? 'Unknown',
      shiftCount: 1,
    }))
  } catch (err) {
    logger.error(`getUnconfirmedSchedule error: ${err.message}`)
    return []
  }
}

async function getOpenTrades(groupId) {
  try {
    const { data, error } = await supabase
      .from('trade_requests')
      .select('shift_description, requester_name, status')
      .eq('group_id', groupId)
      .eq('status', 'open')
    if (error) throw error
    return data ?? []
  } catch (err) {
    logger.error(`getOpenTrades error: ${err.message}`)
    return []
  }
}

async function getConfiguredGroups() {
  try {
    const { data, error } = await supabase
      .from('setup_sessions')
      .select('group_id')
      .eq('setup_complete', true)
    if (error) throw error
    return (data ?? []).map(r => r.group_id)
  } catch (err) {
    logger.error(`getConfiguredGroups briefing error: ${err.message}`)
    return []
  }
}

// ── buildBriefing ─────────────────────────────────────────────────────────

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

function formatDate(d) {
  return `${DAY_NAMES[d.getDay()]}, ${MONTH_NAMES[d.getMonth()]} ${d.getDate()}`
}

/**
 * Builds a structured briefing object for a group.
 */
export async function buildBriefing(groupId, date, db = null) {
  const _getTodaysAssignments = db?.getTodaysAssignments ?? getTodaysAssignments
  const _getOpenCoverageRequests = db?.getOpenCoverageRequests ?? getOpenCoverageRequests
  const _getPendingTimeOff = db?.getPendingTimeOff ?? getPendingTimeOff
  const _getUnconfirmedSchedule = db?.getUnconfirmedSchedule ?? getUnconfirmedSchedule
  const _getOpenTrades = db?.getOpenTrades ?? getOpenTrades

  const today = DAY_NAMES[date.getDay()]

  const [allAssignments, coverage, timeOff, unconfirmed, trades] = await Promise.all([
    _getTodaysAssignments(groupId),
    _getOpenCoverageRequests(groupId),
    _getPendingTimeOff(groupId),
    _getUnconfirmedSchedule(groupId),
    _getOpenTrades(groupId),
  ])

  // Group assignments by shift, filter to today
  const shiftMap = new Map()
  for (const row of allAssignments) {
    const dayOfWeek = row.shift?.day_of_week ?? row.day_of_week
    if (dayOfWeek && dayOfWeek !== today) continue
    const key = row.shift?.name ?? 'Unknown'
    if (!shiftMap.has(key)) {
      shiftMap.set(key, { shiftName: key, staffNames: [], startTime: row.shift?.start_time ?? '' })
    }
    const staffName = row.staff?.name ?? row.staff_name
    if (staffName) shiftMap.get(key).staffNames.push(staffName)
  }

  const result = {
    date: formatDate(date),
    todaysShifts: [...shiftMap.values()],
    openCoverageRequests: coverage.map(r => ({
      shiftDesc: r.shift_description,
      requestedBy: r.requested_by,
      hoursAgo: Math.round((Date.now() - new Date(r.created_at).getTime()) / 3600000),
    })),
    pendingTimeOff: timeOff.map(r => ({ staffName: r.staff_name, requestedDate: r.requested_date })),
    unconfirmedSchedule: unconfirmed,
    openTrades: trades.map(r => ({ shiftName: r.shift_description, requestedBy: r.requester_name })),
    clockCompliance: null,
    moraleAlerts: null,
  }

  // Clock compliance — non-fatal, never blocks the briefing
  try {
    result.clockCompliance = await getClockComplianceReport(groupId, date, db)
  } catch (err) {
    logger.error(`Clock compliance check failed (non-fatal): ${err.message}`)
  }

  // Morale alerts — non-fatal
  try {
    const { generateMoraleReport, formatMoraleAlert } = await import('../intelligence/moraleTracker.js')
    const { getStaffForGroup } = await import('../setup/setupDb.js')
    const allStaff = await getStaffForGroup(groupId)
    const moraleReport = await generateMoraleReport(groupId, allStaff, db)
    if (moraleReport.alerts.length > 0) {
      result.moraleAlerts = moraleReport.alerts
    }
  } catch (err) {
    logger.error(`Morale check failed (non-fatal): ${err.message}`)
  }

  return result
}

// ── formatBriefing ────────────────────────────────────────────────────────

/**
 * Formats a briefing object into a Telegram message string.
 */
export function formatBriefing(briefing) {
  const lines = ["☀️ *Good morning — here's your daily briefing*", `📅 ${briefing.date}`, '']

  lines.push("*Today's shifts:*")
  if (briefing.todaysShifts.length === 0) {
    lines.push('No shifts scheduled today')
  } else {
    for (const shift of briefing.todaysShifts) {
      const names = shift.staffNames.join(', ') || 'No one assigned'
      lines.push(`• ${shift.shiftName} (${shift.startTime}): ${names}`)
    }
  }
  lines.push('')

  const attention = []
  if (briefing.openCoverageRequests.length > 0) {
    const items = briefing.openCoverageRequests.map(r => `${r.requestedBy} needs ${r.shiftDesc}`)
    attention.push(`• ${briefing.openCoverageRequests.length} open coverage request(s) — ${items.join('; ')}`)
  }
  if (briefing.pendingTimeOff.length > 0) {
    const names = briefing.pendingTimeOff.map(r => r.staffName).join(', ')
    attention.push(`• ${briefing.pendingTimeOff.length} time-off request(s) pending approval — ${names}`)
  }
  if (briefing.unconfirmedSchedule.length > 0) {
    const names = briefing.unconfirmedSchedule.map(r => r.staffName).join(', ')
    attention.push(`• ${briefing.unconfirmedSchedule.length} staff haven't confirmed next week's schedule — ${names}`)
  }
  if (briefing.openTrades.length > 0) {
    attention.push(`• ${briefing.openTrades.length} open trade offer(s)`)
  }

  lines.push('*Needs attention:*')
  if (attention.length === 0) {
    lines.push('✅ Nothing needs your attention today')
  } else {
    lines.push(...attention)
  }

  // Clock compliance section
  if (briefing.clockCompliance) {
    const complianceText = formatComplianceSection(briefing.clockCompliance)
    if (complianceText) lines.push(complianceText)
  }

  // Morale alerts section
  if (briefing.moraleAlerts && briefing.moraleAlerts.length > 0) {
    lines.push('')
    lines.push('👀 *Staff engagement — heads up:*')
    for (const alert of briefing.moraleAlerts) {
      const reasons = alert.reasons?.join(', ') || 'declining engagement'
      lines.push(`• ${alert.staffName}: ${reasons}. Consider checking in.`)
    }
  }

  return lines.join('\n')
}

// ── sendDailyBriefing + cron ──────────────────────────────────────────────

/**
 * Builds and sends the daily briefing DM to the manager for a group.
 */
export async function sendDailyBriefing(bot, groupId, db = null) {
  const _getSetupSession = db?.getSetupSession ?? liveGetSetupSession

  const session = await _getSetupSession(groupId)
  if (!session?.dm_chat_id) {
    logger.info(`sendDailyBriefing: no manager DM for group ${groupId}`)
    return { sent: false, groupId }
  }

  const briefing = await buildBriefing(groupId, new Date(), db)
  const message = formatBriefing(briefing)

  await bot.sendMessage(session.dm_chat_id, message, { parse_mode: 'Markdown' })
  logger.info(`sendDailyBriefing: sent to group ${groupId}`)
  return { sent: true, groupId }
}

export function startBriefingCron(bot) {
  cron.schedule('0 8 * * *', async () => {
    try {
      const groups = await getConfiguredGroups()
      let sent = 0
      for (const groupId of groups) {
        const result = await sendDailyBriefing(bot, groupId)
        if (result.sent) sent++
      }
      logger.info(`Daily briefing cron: sent to ${sent} groups`)
    } catch (err) {
      logger.error(`Briefing cron error: ${err.message}`)
    }
  })
  logger.info('Daily briefing cron started (8am daily)')
}
