import { getClockedInNow, getTimeEntriesForWeek } from './clockDb.js'
import { getPublishedSchedule } from '../availability/availabilityDb.js'
import { getStaffForGroup, getSetupSession } from '../setup/setupDb.js'
import { getCurrentWeekStart, getNextWeekStart, formatWeekLabel } from '../schedule/generateSchedule.js'
import { logger } from '../logger.js'

function formatTime(date) {
  return new Date(date).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true })
}

function getTodayDayName() {
  return new Date().toLocaleDateString('en-US', { weekday: 'long' })
}

function entryHours(entry) {
  if (!entry.clock_in || !entry.clock_out) return 0
  const ms = new Date(entry.clock_out).getTime() - new Date(entry.clock_in).getTime()
  return ms / 3600000
}

export async function handleClockStatus(bot, msg, db = null) {
  const groupId = String(msg.chat.id)

  const [clockedIn, schedule, allStaff] = await Promise.all([
    getClockedInNow(groupId, db),
    getPublishedSchedule(groupId),
    getStaffForGroup(groupId),
  ])

  const staffMap = Object.fromEntries(allStaff.map(s => [String(s.id), s.name]))

  // Who's clocked in
  let text = '⏰ *Clock Status*\n\n'

  if (clockedIn.length > 0) {
    text += '*Currently clocked in:*\n'
    for (const entry of clockedIn) {
      const name = staffMap[String(entry.staff_id)] ?? `User ${entry.user_id}`
      const since = formatTime(entry.clock_in)
      text += `• ${name} (since ${since})\n`
    }
  } else {
    text += 'No one is currently clocked in.\n'
  }

  // Who's scheduled today but hasn't clocked in
  if (schedule?.assignments) {
    const today = getTodayDayName()
    const todayAssignments = schedule.assignments.filter(a => a.dayOfWeek === today)
    const clockedInUserIds = new Set(clockedIn.map(e => String(e.user_id)))

    const notClockedIn = todayAssignments.filter(a => a.userId && !clockedInUserIds.has(String(a.userId)))
    const uniqueNames = [...new Set(notClockedIn.map(a => a.staffName))]

    if (uniqueNames.length > 0) {
      text += `\n*Scheduled today but not clocked in:*\n`
      for (const name of uniqueNames) {
        const shifts = notClockedIn.filter(a => a.staffName === name)
        const shiftNames = shifts.map(a => a.shiftName).join(', ')
        text += `• ${name} — ${shiftNames}\n`
      }
    }
  }

  const session = await getSetupSession(groupId)
  if (session?.dm_chat_id) {
    await bot.sendMessage(msg.chat.id, '📨 Clock status sent to your DM.')
    await bot.sendMessage(session.dm_chat_id, text, { parse_mode: 'Markdown' })
  } else {
    await bot.sendMessage(msg.chat.id, text, { parse_mode: 'Markdown' })
  }
}

export async function handleTimesheetCommand(bot, msg, staffNameArg, db = null) {
  const groupId = String(msg.chat.id)

  const weekStart = getCurrentWeekStart()
  const weekLabel = formatWeekLabel(weekStart)
  const [entries, allStaff, schedule, session] = await Promise.all([
    getTimeEntriesForWeek(groupId, weekStart, db),
    getStaffForGroup(groupId),
    getPublishedSchedule(groupId),
    getSetupSession(groupId),
  ])

  const staffMap = Object.fromEntries(allStaff.map(s => [String(s.id), s]))

  // Build hours per staff
  const hoursMap = {}
  for (const entry of entries) {
    const key = String(entry.staff_id ?? entry.user_id)
    if (!hoursMap[key]) hoursMap[key] = { name: null, actual: 0, entries: [] }
    hoursMap[key].actual += entryHours(entry)
    hoursMap[key].entries.push(entry)
  }

  // Fill in names and calculate scheduled hours
  for (const [key, val] of Object.entries(hoursMap)) {
    val.name = staffMap[key]?.name ?? `User ${key}`
  }

  // Calculate scheduled hours per staff from published schedule
  const scheduledMap = {}
  if (schedule?.assignments) {
    for (const a of schedule.assignments) {
      const key = String(a.staffId)
      if (!scheduledMap[key]) scheduledMap[key] = { name: a.staffName, scheduled: 0 }
      // Rough hours from shift times
      const start = parseTimeToMinutes(a.startTime)
      const end = parseTimeToMinutes(a.endTime)
      let diff = end - start
      if (diff <= 0) diff += 1440
      scheduledMap[key].scheduled += diff / 60
    }
  }

  // Filter by name if provided
  let targetStaff = null
  if (staffNameArg) {
    const lower = staffNameArg.toLowerCase()
    targetStaff = allStaff.find(s => s.name?.toLowerCase().includes(lower))
    if (!targetStaff) {
      await bot.sendMessage(msg.chat.id, `Couldn't find staff member "${staffNameArg}".`)
      return
    }
  }

  let text = `📋 *Timesheet — Week of ${weekLabel}*\n\n`

  const allKeys = new Set([...Object.keys(hoursMap), ...Object.keys(scheduledMap)])
  const rows = []

  for (const key of allKeys) {
    const actual = hoursMap[key]?.actual ?? 0
    const scheduled = scheduledMap[key]?.scheduled ?? 0
    const name = hoursMap[key]?.name ?? scheduledMap[key]?.name ?? `Staff ${key}`

    if (targetStaff && String(targetStaff.id) !== key) continue

    const actualStr = actual > 0 ? `${actual.toFixed(1)}h actual` : 'no clock data'
    const scheduledStr = scheduled > 0 ? `${scheduled.toFixed(1)}h scheduled` : ''
    const diff = actual > 0 && scheduled > 0 ? ` (${actual > scheduled ? '+' : ''}${(actual - scheduled).toFixed(1)}h)` : ''

    rows.push(`• ${name}: ${actualStr}${scheduledStr ? ` / ${scheduledStr}` : ''}${diff}`)
  }

  if (rows.length === 0) {
    text += 'No time entries or schedule data for this week.'
  } else {
    text += rows.join('\n')
  }

  if (session?.dm_chat_id) {
    await bot.sendMessage(msg.chat.id, '📨 Timesheet sent to your DM.')
    await bot.sendMessage(session.dm_chat_id, text, { parse_mode: 'Markdown' })
  } else {
    await bot.sendMessage(msg.chat.id, text, { parse_mode: 'Markdown' })
  }
}

function parseTimeToMinutes(timeStr) {
  if (!timeStr) return 0
  const s = String(timeStr).trim().toLowerCase().replace(/\s+/g, ' ')
  const m24 = s.match(/^(\d{1,2}):(\d{2})$/)
  if (m24) return parseInt(m24[1]) * 60 + parseInt(m24[2])
  const m12 = s.match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)$/)
  if (m12) {
    let h = parseInt(m12[1])
    const min = parseInt(m12[2] ?? '0')
    if (m12[3] === 'pm' && h !== 12) h += 12
    if (m12[3] === 'am' && h === 12) h = 0
    return h * 60 + min
  }
  return 0
}
