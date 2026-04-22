import { clockIn, clockOut, getOpenEntry } from './clockDb.js'
import { findPersonShiftForDay } from '../setup/db/assignments.js'
import { getManagerGroup } from '../setup/setupDb.js'
import { getStaffForGroup } from '../setup/setupDb.js'
import { getGroupMembersWithDm } from '../db.js'
import { logger } from '../logger.js'
import { checkOvertimeAlert } from './clockAlerts.js'

function getTodayDayName() {
  return new Date().toLocaleDateString('en-US', { weekday: 'long' })
}

function formatTime(date) {
  return new Date(date).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true })
}

function formatDuration(clockIn, clockOut) {
  const ms = new Date(clockOut).getTime() - new Date(clockIn).getTime()
  const totalMin = Math.round(ms / 60000)
  const hours = Math.floor(totalMin / 60)
  const mins = totalMin % 60
  if (hours === 0) return `${mins}m`
  if (mins === 0) return `${hours}h`
  return `${hours}h ${mins}m`
}

async function resolveStaffId(userId, groupId) {
  try {
    const allStaff = await getStaffForGroup(groupId)
    const dmPool = await getGroupMembersWithDm(groupId)
    const member = dmPool.find(m => String(m.userId) === String(userId))
    if (!member) return null
    const nameLower = (member.firstName || '').toLowerCase().trim()
    const matched = allStaff.find(s => {
      const sLower = (s.name || '').toLowerCase().trim()
      return sLower === nameLower || nameLower.startsWith(sLower) || sLower.startsWith(nameLower)
    })
    return matched?.id ?? null
  } catch {
    return null
  }
}

export async function handleClockIn(bot, msg, db = null) {
  const userId = msg.from?.id
  const groupId = await resolveGroupId(userId, db)
  if (!groupId) {
    await bot.sendMessage(msg.chat.id, "I don't have you linked to a restaurant group yet. Send /start in your group first.")
    return true
  }

  // Check for existing open entry
  const existing = await getOpenEntry(userId, groupId, db)
  if (existing) {
    const time = formatTime(existing.clock_in)
    await bot.sendMessage(msg.chat.id,
      `You're already clocked in (since ${time}). Send *clock out* first to close that entry.`,
      { parse_mode: 'Markdown' })
    return true
  }

  const staffId = await resolveStaffId(userId, groupId)
  const today = getTodayDayName()

  // Find today's shift(s)
  let shifts = []
  try {
    const result = await findPersonShiftForDay(groupId, userId, msg.from?.first_name || '', today)
    shifts = result?.matches ?? []
  } catch (err) {
    logger.error(`Clock-in shift lookup failed: ${err.message}`)
  }

  if (shifts.length > 1) {
    // Multiple shifts today — ask which one
    const list = shifts.map((s, i) => {
      const shift = s.shift ?? s
      return `${i + 1}) ${shift.name} (${shift.start_time}–${shift.end_time})`
    }).join('\n')
    await bot.sendMessage(msg.chat.id,
      `You have multiple shifts today:\n\n${list}\n\nReply with the number to clock into.`,
      { parse_mode: 'Markdown' })
    // Store pending clock-in state — we'll handle the reply in dmRouter
    return 'awaiting_shift_selection'
  }

  const shiftMatch = shifts[0] ?? null
  const shift = shiftMatch?.shift ?? shiftMatch
  const shiftId = shift?.id ?? null

  const entry = await clockIn(groupId, userId, staffId, shiftId, msg.text, db)
  if (!entry) {
    await bot.sendMessage(msg.chat.id, 'Something went wrong recording your clock-in. Try again.')
    return true
  }

  const time = formatTime(entry.clock_in)
  if (shift) {
    await bot.sendMessage(msg.chat.id,
      `⏰ Clocked in for *${shift.name}* (${shift.start_time}–${shift.end_time}) at ${time}`,
      { parse_mode: 'Markdown' })
  } else {
    await bot.sendMessage(msg.chat.id,
      `⏰ Clocked in at ${time} _(no shift scheduled today)_`,
      { parse_mode: 'Markdown' })
  }

  logger.bot(`${msg.from?.first_name} clocked in (shift: ${shift?.name ?? 'none'})`)
  return true
}

export async function handleClockOut(bot, msg, db = null) {
  const userId = msg.from?.id
  const groupId = await resolveGroupId(userId, db)
  if (!groupId) {
    await bot.sendMessage(msg.chat.id, "I don't have you linked to a restaurant group yet. Send /start in your group first.")
    return true
  }

  const entry = await getOpenEntry(userId, groupId, db)
  if (!entry) {
    // Check if there's a recent closed entry (already clocked out)
    let recentlyClosed = null
    try {
      const _getMostRecentEntry = db?.getMostRecentEntry ?? null
      if (_getMostRecentEntry) {
        recentlyClosed = await _getMostRecentEntry(userId, groupId)
      }
    } catch (_) {}

    if (recentlyClosed?.clock_out) {
      const time = formatTime(recentlyClosed.clock_out)
      await bot.sendMessage(msg.chat.id,
        `You're already clocked out at ${time}. Contact your manager to correct.`)
    } else {
      await bot.sendMessage(msg.chat.id, "You haven't clocked in today. Send *clock in* to start.", { parse_mode: 'Markdown' })
    }
    return true
  }

  const closed = await clockOut(entry.id, msg.text, db)
  if (!closed) {
    // D.02: null return means entry was already clocked out (race condition / duplicate request)
    let alreadyOutTime = null
    try {
      const _getMostRecentEntry = db?.getMostRecentEntry ?? null
      if (_getMostRecentEntry) {
        const recent = await _getMostRecentEntry(userId, groupId)
        if (recent?.clock_out) alreadyOutTime = formatTime(recent.clock_out)
      }
    } catch (_) {}

    if (alreadyOutTime) {
      await bot.sendMessage(msg.chat.id,
        `You're already clocked out at ${alreadyOutTime}. Contact your manager to correct.`)
    } else {
      await bot.sendMessage(msg.chat.id, 'Something went wrong recording your clock-out. Try again.')
    }
    return true
  }

  const duration = formatDuration(closed.clock_in, closed.clock_out)
  await bot.sendMessage(msg.chat.id,
    `⏰ Clocked out. Worked ${duration}.`)

  // Check for OT alert
  try {
    await checkOvertimeAlert(bot, userId, groupId, db)
  } catch (err) {
    logger.error(`OT alert check failed: ${err.message}`)
  }

  logger.bot(`${msg.from?.first_name} clocked out (${duration})`)
  return true
}

async function resolveGroupId(userId, db = null) {
  try {
    const _getManagerGroup = db?.getManagerGroup ?? getManagerGroup
    const managerGroup = await _getManagerGroup(userId)
    if (managerGroup) return managerGroup.group_id

    // Not a manager — check group_members for their group
    if (db?.getGroupForUser) return db.getGroupForUser(userId)

    const { createClient } = await import('@supabase/supabase-js')
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY)
    const { data } = await supabase
      .from('group_members')
      .select('group_id')
      .eq('user_id', userId)
      .order('last_seen', { ascending: false })
      .limit(1)
      .maybeSingle()
    return data?.group_id ?? null
  } catch {
    return null
  }
}
