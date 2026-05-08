import { getPublishedSchedule as _getPublishedScheduleReal } from '../availability/availabilityDb.js'
import { logger } from '../logger.js'

const SCHEDULE_QUERY_PATTERNS = [
  /\bmy\s+schedule\b/i,
  /\bmy\s+shifts?\b/i,
  /\bwhat\s+are\s+my\s+shifts?\b/i,
  /\bwhen\s+do\s+i\s+work\b/i,
  /\bwhat\s+shift\s+am\s+i\s+on\b/i,
  /\bam\s+i\s+working\s+this\s+week\b/i,
  /\bwhat\s+days\s+am\s+i\s+working\b/i,
  /^\s*schedule\s*$/i,
]

const HOURS_QUERY_PATTERNS = [
  /\bhow\s+many\s+hours\b/i,
  /\bmy\s+hours\b/i,
  /\bhours\s+this\s+week\b/i,
]

export function isScheduleQuery(text) {
  return SCHEDULE_QUERY_PATTERNS.some(p => p.test(text))
}

export function isHoursQuery(text) {
  return HOURS_QUERY_PATTERNS.some(p => p.test(text))
}

// Look up a staff member by their DM chat ID.
// In production this queries group_members + staff_dms joined.
// Injected db must implement: getStaffByDmChatId(chatId) → { userId, firstName, dmChatId, groupId } | null
async function lookupStaff(chatId, db) {
  return db.getStaffByDmChatId(chatId)
}

export async function handleScheduleQuery(bot, msg, db = null) {
  const _getPublishedSchedule = db?.getPublishedSchedule ?? _getPublishedScheduleReal
  const _getStaffByDmChatId = db?.getStaffByDmChatId ?? null

  const chatId = String(msg.chat.id)

  // Look up staff member by their DM chat ID
  let staff
  if (_getStaffByDmChatId) {
    staff = await _getStaffByDmChatId(chatId)
  } else {
    staff = await getStaffByDmChatIdReal(chatId)
  }

  if (!staff) {
    await bot.sendMessage(chatId,
      `You're not registered yet. Ask your manager to run /register in the group.`,
      { parse_mode: 'Markdown' }
    )
    return
  }

  const schedule = await _getPublishedSchedule(staff.groupId)

  if (!schedule) {
    await bot.sendMessage(chatId,
      `No schedule has been published yet. Check with your manager.`
    )
    return
  }

  const myAssignments = (schedule.assignments ?? []).filter(
    a => a.userId === staff.userId || String(a.userId) === String(staff.userId)
  )

  if (myAssignments.length === 0) {
    await bot.sendMessage(chatId,
      `You're not scheduled this week. Check with your manager if you think that's wrong.`
    )
    return
  }

  const weekLabel = formatWeekLabel(schedule.week_start)
  const lines = myAssignments
    .sort((a, b) => DAY_ORDER[a.dayOfWeek] - DAY_ORDER[b.dayOfWeek])
    .map(a => `• ${a.dayOfWeek} — ${a.shiftName}, ${a.startTime}–${a.endTime}`)
    .join('\n')

  await bot.sendMessage(chatId,
    `📅 *Your shifts this week:*\n\n${lines}\n\nWeek of ${weekLabel}`,
    { parse_mode: 'Markdown' }
  )
}

export async function handleHoursQuery(bot, msg, db = null) {
  const _getPublishedSchedule = db?.getPublishedSchedule ?? _getPublishedScheduleReal
  const _getStaffByDmChatId = db?.getStaffByDmChatId ?? null

  const chatId = String(msg.chat.id)

  let staff
  if (_getStaffByDmChatId) {
    staff = await _getStaffByDmChatId(chatId)
  } else {
    staff = await getStaffByDmChatIdReal(chatId)
  }

  if (!staff) {
    await bot.sendMessage(chatId, `You're not registered yet.`)
    return
  }

  const schedule = await _getPublishedSchedule(staff.groupId)
  const myAssignments = (schedule?.assignments ?? []).filter(
    a => a.userId === staff.userId || String(a.userId) === String(staff.userId)
  )

  const totalHours = myAssignments.reduce((sum, a) => sum + calcHours(a.startTime, a.endTime), 0)
  const shiftCount = myAssignments.length

  await bot.sendMessage(chatId,
    `📊 You have ${shiftCount} shift${shiftCount === 1 ? '' : 's'} totaling ${totalHours} hours this week.`
  )
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const DAY_ORDER = { Monday: 1, Tuesday: 2, Wednesday: 3, Thursday: 4, Friday: 5, Saturday: 6, Sunday: 7 }

function formatWeekLabel(weekStart) {
  const dateStr = String(weekStart).slice(0, 10)
  const d = new Date(`${dateStr}T12:00:00`)
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

function calcHours(startTime, endTime) {
  const toMinutes = (t) => {
    const match = t.match(/(\d+):(\d+)\s*(AM|PM)/i)
    if (!match) return 0
    let h = parseInt(match[1])
    const m = parseInt(match[2])
    const ampm = match[3].toUpperCase()
    if (ampm === 'PM' && h !== 12) h += 12
    if (ampm === 'AM' && h === 12) h = 0
    return h * 60 + m
  }
  const diff = toMinutes(endTime) - toMinutes(startTime)
  return Math.max(0, Math.round((diff / 60) * 10) / 10)
}

// Production DB function — looks up staff by DM chat ID via group_members + staff_dms
async function getStaffByDmChatIdReal(chatId) {
  const { getDb } = await import('../db.js')
  try {
    const { data: dmRow } = await getDb()
      .from('staff_dms')
      .select('user_id, first_name, dm_chat_id')
      .eq('dm_chat_id', chatId)
      .maybeSingle()
    if (!dmRow) return null

    const { data: memberRow } = await getDb()
      .from('group_members')
      .select('group_id')
      .eq('user_id', dmRow.user_id)
      .order('last_seen', { ascending: false })
      .limit(1)
      .maybeSingle()
    if (!memberRow) return null

    return {
      userId: dmRow.user_id,
      firstName: dmRow.first_name,
      dmChatId: String(dmRow.dm_chat_id),
      groupId: memberRow.group_id,
    }
  } catch (err) {
    logger.error(`getStaffByDmChatIdReal failed: ${err.message}`)
    return null
  }
}
