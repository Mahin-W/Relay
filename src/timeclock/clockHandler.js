import { clockIn, clockOut, getOpenEntry } from './clockDb.js'
import { findPersonShiftForDay } from '../setup/db/assignments.js'
import { getManagerGroup } from '../setup/setupDb.js'
import { getStaffForGroup } from '../setup/setupDb.js'
import { getGroupMembersWithDm, getDb } from '../db.js'
import { logger } from '../logger.js'
import { checkOvertimeAlert } from './clockAlerts.js'

// How many minutes before shift start staff may clock in (default: 60).
const EARLY_CLOCKIN_GRACE_MIN = Number(process.env.EARLY_CLOCKIN_GRACE_MIN) || 60

function getTodayDayName() {
  return new Date().toLocaleDateString('en-US', { weekday: 'long' })
}

/**
 * Parse a shift start_time string ("18:00", "6pm", "6:00am", etc.) and return
 * the number of minutes until that time from `now`. Negative means it's in the past.
 */
function minutesUntilShiftStart(startTimeStr, now = new Date()) {
  if (!startTimeStr) return null
  const s = String(startTimeStr).trim().toLowerCase()

  // "18:00" or "06:00" (24h)
  let hours, minutes
  const h24 = s.match(/^(\d{1,2}):(\d{2})$/)
  if (h24) {
    hours = parseInt(h24[1])
    minutes = parseInt(h24[2])
  } else {
    // "6:00am" / "6:00pm"
    const h12c = s.match(/^(\d{1,2}):(\d{2})\s*(am|pm)$/)
    if (h12c) {
      hours = parseInt(h12c[1])
      minutes = parseInt(h12c[2])
      if (h12c[3] === 'pm' && hours !== 12) hours += 12
      if (h12c[3] === 'am' && hours === 12) hours = 0
    } else {
      // "6am" / "6pm"
      const h12 = s.match(/^(\d{1,2})\s*(am|pm)$/)
      if (h12) {
        hours = parseInt(h12[1])
        minutes = 0
        if (h12[2] === 'pm' && hours !== 12) hours += 12
        if (h12[2] === 'am' && hours === 12) hours = 0
      } else {
        return null
      }
    }
  }

  const shiftTime = new Date(now)
  shiftTime.setHours(hours, minutes, 0, 0)
  return (shiftTime.getTime() - now.getTime()) / 60000
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

async function resolveStaffId(userId, groupId, db = null) {
  try {
    // Fast path: if db has direct lookup, use it
    if (db?.getStaffByUserId) {
      const direct = await db.getStaffByUserId(userId, groupId)
      if (direct?.id) return direct.id
    }

    const _getStaffForGroup = db?.getStaffForGroup ?? getStaffForGroup
    const _getGroupMembersWithDm = db?.getGroupMembersWithDm ?? getGroupMembersWithDm
    const allStaff = await _getStaffForGroup(groupId)
    const dmPool = await _getGroupMembersWithDm(groupId)
    const member = dmPool.find(m => String(m.userId) === String(userId))
    if (!member) {
      // Last-resort: match staff directly by user_id field if mock DB exposes it
      const direct = (allStaff || []).find(s => String(s.user_id) === String(userId))
      return direct?.id ?? null
    }
    const nameLower = (member.firstName || '').toLowerCase().trim()
    const matched = (allStaff || []).find(s => {
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
    await bot.sendMessage(msg.chat.id, "I don't have you linked to a group yet. Send /start in your group first.")
    return true
  }

  // Check timeclock enabled
  try {
    const { getSetupSession } = await import('../setup/setupDb.js')
    const session = await getSetupSession(groupId)
    if (session?.setup_data?.timeclockEnabled === false) return true
  } catch (_) {}

  // Check for existing open entry
  const existing = await getOpenEntry(userId, groupId, db)
  if (existing) {
    const time = formatTime(existing.clock_in)
    await bot.sendMessage(msg.chat.id,
      `You're already clocked in (since ${time}). Send *clock out* first to close that entry.`,
      { parse_mode: 'Markdown' })
    return true
  }

  const staffId = await resolveStaffId(userId, groupId, db)
  const today = getTodayDayName()

  // Find today's shift(s) — supports db.findPersonShiftForDay override for testing
  let shifts = []
  try {
    const _findPersonShiftForDay = db?.findPersonShiftForDay ?? findPersonShiftForDay
    const result = await _findPersonShiftForDay(groupId, userId, msg.from?.first_name || '', today)
    shifts = result?.matches ?? []
  } catch (err) {
    logger.error(`Clock-in shift lookup failed: ${err.message}`)
  }

  // ── P1-10 validation ──────────────────────────────────────────────────────
  // (a) Must have an assigned shift today
  if (shifts.length === 0) {
    await bot.sendMessage(msg.chat.id,
      "You don't have a shift scheduled today. If you think that's a mistake, ask your manager — " +
      "they can clock you in manually from the dashboard.")
    return true
  }

  // (b) Reject clock-in earlier than EARLY_CLOCKIN_GRACE_MIN before shift start
  // (only checked for single-shift case; multi-shift will ask which one first)
  if (shifts.length === 1) {
    const shiftMatch = shifts[0]
    const shift = shiftMatch?.shift ?? shiftMatch
    if (shift?.start_time) {
      const minsUntil = minutesUntilShiftStart(shift.start_time)
      if (minsUntil !== null && minsUntil > EARLY_CLOCKIN_GRACE_MIN) {
        await bot.sendMessage(msg.chat.id,
          `Your ${shift.name} shift starts at ${shift.start_time}. ` +
          `You can clock in up to ${EARLY_CLOCKIN_GRACE_MIN} min before your shift starts.`)
        return true
      }
    }
  }
  // ─────────────────────────────────────────────────────────────────────────

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
    await bot.sendMessage(msg.chat.id, "I don't have you linked to a group yet. Send /start in your group first.")
    return true
  }

  // Check timeclock enabled
  try {
    const { getSetupSession } = await import('../setup/setupDb.js')
    const session = await getSetupSession(groupId)
    if (session?.setup_data?.timeclockEnabled === false) return true
  } catch (_) {}

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

    // Not a manager — check via injected db first
    if (db?.getGroupForUser) {
      const result = await db.getGroupForUser(userId)
      // Result might be { group_id } or just a string id
      if (typeof result === 'string') return result
      return result?.group_id ?? null
    }
    if (db?.getStaffByUserId) {
      const staff = await db.getStaffByUserId(userId)
      if (staff?.group_id) return staff.group_id
    }

    // Fall back to direct supabase only when no db was provided
    if (process.env.SUPABASE_URL && process.env.SUPABASE_ANON_KEY) {
      const supabase = getDb()
      const { data } = await supabase
        .from('group_members')
        .select('group_id')
        .eq('user_id', userId)
        .order('last_seen', { ascending: false })
        .limit(1)
        .maybeSingle()
      return data?.group_id ?? null
    }
    return null
  } catch {
    return null
  }
}
