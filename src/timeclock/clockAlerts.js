import { getTimeEntriesForWeek } from './clockDb.js'
import { getOvertimeSettings } from '../setup/setupDb.js'
import { getManagerGroup } from '../setup/setupDb.js'
import { getCurrentWeekStart } from '../schedule/generateSchedule.js'
import { logger } from '../logger.js'

function entryHours(entry) {
  if (!entry.clock_in || !entry.clock_out) return 0
  const ms = new Date(entry.clock_out).getTime() - new Date(entry.clock_in).getTime()
  return ms / 3600000
}

export async function checkOvertimeAlert(bot, userId, groupId, db = null) {
  const _getOvertimeSettings = db?.getOvertimeSettings ?? getOvertimeSettings
  const _getTimeEntriesForWeek = db?.getTimeEntriesForWeek ?? getTimeEntriesForWeek

  const otSettings = await _getOvertimeSettings(groupId)
  if (!otSettings?.overtime_enabled) return

  const weekStart = getCurrentWeekStart()
  const entries = await _getTimeEntriesForWeek(groupId, weekStart)
  const userEntries = entries.filter(e => String(e.user_id) === String(userId))
  const totalHours = userEntries.reduce((sum, e) => sum + entryHours(e), 0)

  if (totalHours <= otSettings.weekly_threshold) return

  // OT triggered — notify manager
  const _getManagerGroup = db?.getManagerGroup ?? getManagerGroup
  const managerGroup = await _getManagerGroup(userId)
  // If the user IS the manager, look up the group's manager instead
  let dmChatId = null
  if (managerGroup) {
    dmChatId = managerGroup.dm_chat_id
  } else {
    // Look up manager for this group
    const { createClient } = await import('@supabase/supabase-js')
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY)
    const { data } = await supabase
      .from('setup_sessions')
      .select('dm_chat_id')
      .eq('group_id', groupId)
      .eq('setup_complete', true)
      .maybeSingle()
    dmChatId = data?.dm_chat_id
  }

  if (!dmChatId) return

  // Look up staff name
  const { createClient } = await import('@supabase/supabase-js')
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY)
  const { data: member } = await supabase
    .from('group_members')
    .select('first_name')
    .eq('user_id', userId)
    .eq('group_id', groupId)
    .maybeSingle()

  const name = member?.first_name ?? 'A staff member'
  const otHours = (totalHours - otSettings.weekly_threshold).toFixed(1)

  await bot.sendMessage(dmChatId,
    `⚠️ *Overtime Alert*\n\n` +
    `${name} just clocked ${totalHours.toFixed(1)} hours this week ` +
    `(threshold: ${otSettings.weekly_threshold}). ` +
    `${otHours} hours of OT so far.`,
    { parse_mode: 'Markdown' })

  logger.bot(`OT alert: ${name} at ${totalHours.toFixed(1)}hrs (threshold ${otSettings.weekly_threshold})`)
}

export async function getClockComplianceReport(groupId, date, db = null) {
  // Returns { missed: [{ staffName, shiftName }], chronic: [{ staffName, missedCount, totalShifts }] }
  const _getTimeEntriesForWeek = db?.getTimeEntriesForWeek ?? getTimeEntriesForWeek

  try {
    const { createClient } = await import('@supabase/supabase-js')
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY)

    // Get yesterday's assignments from published schedule
    const yesterday = new Date(date)
    yesterday.setDate(yesterday.getDate() - 1)
    const yesterdayDay = yesterday.toLocaleDateString('en-US', { weekday: 'long' })

    const { data: schedules } = await supabase
      .from('generated_schedules')
      .select('assignments')
      .eq('group_id', groupId)
      .eq('status', 'published')
      .order('published_at', { ascending: false })
      .limit(1)
      .maybeSingle()

    if (!schedules?.assignments) return { missed: [], chronic: [] }

    const yesterdayAssignments = schedules.assignments.filter(a => a.dayOfWeek === yesterdayDay)
    if (yesterdayAssignments.length === 0) return { missed: [], chronic: [] }

    // Get yesterday's time entries
    const startOfYesterday = new Date(yesterday)
    startOfYesterday.setHours(0, 0, 0, 0)
    const endOfYesterday = new Date(yesterday)
    endOfYesterday.setHours(23, 59, 59, 999)

    const { data: entries } = await supabase
      .from('time_entries')
      .select('user_id, staff_id')
      .eq('group_id', groupId)
      .gte('clock_in', startOfYesterday.toISOString())
      .lte('clock_in', endOfYesterday.toISOString())

    const clockedInUsers = new Set((entries ?? []).map(e => String(e.user_id)))

    const missed = yesterdayAssignments
      .filter(a => a.userId && !clockedInUsers.has(String(a.userId)))
      .map(a => ({ staffName: a.staffName, shiftName: a.shiftName }))

    // Chronic: check last 5 scheduled shifts for each staff member
    const chronic = []
    const staffIds = [...new Set(yesterdayAssignments.map(a => a.userId).filter(Boolean))]
    for (const uid of staffIds) {
      const { data: recentEntries } = await supabase
        .from('time_entries')
        .select('id')
        .eq('user_id', uid)
        .eq('group_id', groupId)
        .order('clock_in', { ascending: false })
        .limit(5)

      const staffAssignments = (schedules.assignments ?? []).filter(a => String(a.userId) === String(uid))
      const totalShifts = Math.min(staffAssignments.length, 5)
      const clockedCount = (recentEntries ?? []).length
      const missedCount = totalShifts - clockedCount

      if (missedCount >= 3 && totalShifts >= 4) {
        const name = yesterdayAssignments.find(a => String(a.userId) === String(uid))?.staffName ?? 'Unknown'
        chronic.push({ staffName: name, missedCount, totalShifts })
      }
    }

    return { missed, chronic }
  } catch (err) {
    logger.error(`getClockComplianceReport failed: ${err.message}`)
    return { missed: [], chronic: [] }
  }
}

export function formatComplianceSection(report) {
  if (report.missed.length === 0 && report.chronic.length === 0) return ''

  let text = '\n*🕐 Clock-in compliance:*\n'

  if (report.missed.length > 0) {
    const names = report.missed.map(m => m.staffName)
    const unique = [...new Set(names)]
    text += `Yesterday, ${unique.length} staff didn't clock in: ${unique.join(', ')}\n`
  }

  for (const c of report.chronic) {
    text += `⚠️ ${c.staffName} has missed clock-in ${c.missedCount} of last ${c.totalShifts} shifts\n`
  }

  return text
}
