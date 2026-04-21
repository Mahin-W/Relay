import { findPersonShiftForDay } from '../setup/db/assignments.js'
import { getSetupSession } from '../setup/setupDb.js'
import { logger } from '../logger.js'

function getTodayDayName() {
  return new Date().toLocaleDateString('en-US', { weekday: 'long' })
}

/**
 * Parse a time string like "4:00 PM", "16:00", "4pm" into a Date for today.
 * Returns null if unparseable.
 */
function parseShiftTime(timeStr) {
  if (!timeStr) return null
  try {
    const t = String(timeStr).trim()
    // Try "HH:MM" or "H:MM" 24h
    const h24 = t.match(/^(\d{1,2}):(\d{2})$/)
    if (h24) {
      const d = new Date()
      d.setHours(parseInt(h24[1], 10), parseInt(h24[2], 10), 0, 0)
      return d
    }
    // Try "H:MM AM/PM" or "Ham/pm"
    const h12 = t.match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)$/i)
    if (h12) {
      let hours = parseInt(h12[1], 10)
      const mins = h12[2] ? parseInt(h12[2], 10) : 0
      const meridiem = h12[3].toLowerCase()
      if (meridiem === 'pm' && hours !== 12) hours += 12
      if (meridiem === 'am' && hours === 12) hours = 0
      const d = new Date()
      d.setHours(hours, mins, 0, 0)
      return d
    }
    return null
  } catch {
    return null
  }
}

export async function handleLateArrival(bot, msg, intent, db = null) {
  const _findShiftForToday = db?.findShiftForToday ?? null
  const _getSetupSession = db?.getSetupSession ?? getSetupSession

  const groupId = String(msg.chat.id)
  const staffName = intent.person || msg.from?.first_name || 'Someone'
  const staffId = msg.from?.id
  const today = getTodayDayName()

  // Look up today's shift
  let shiftInfo = null
  try {
    if (_findShiftForToday) {
      shiftInfo = await _findShiftForToday(groupId, staffId, staffName, today)
    } else {
      const result = await findPersonShiftForDay(groupId, staffId, staffName, today)
      shiftInfo = result?.matches?.[0] ?? null
    }
  } catch (err) {
    logger.error(`handleLateArrival shift lookup failed: ${err.message}`)
  }

  // BUG 1.14: validate shift hasn't already ended
  if (shiftInfo) {
    const shift = shiftInfo.shift ?? shiftInfo
    const endTime = parseShiftTime(shift.end_time)
    if (endTime && endTime < new Date()) {
      await bot.sendMessage(msg.chat.id,
        `That shift already ended — if you were a no-show, talk to your manager.`)
      logger.bot(`Late arrival rejected for ${staffName} — shift already ended`)
      return
    }
  }

  // Quiet group ack
  await bot.sendMessage(msg.chat.id, `Got it ${staffName} 👍`)

  // Get manager DM
  const session = await _getSetupSession(groupId)
  if (!session?.dm_chat_id) {
    logger.bot('No manager DM found — cannot alert manager of late arrival')
    return
  }

  let managerMsg =
    `⚠️ *Running late*\n` +
    `👤 ${staffName} says they're running late`

  if (intent.minutes != null) {
    managerMsg += `\n🕐 About ${intent.minutes} minutes behind`
  } else if (intent.eta) {
    managerMsg += `\n🕐 ETA: ${intent.eta}`
  }

  if (shiftInfo) {
    const shift = shiftInfo.shift ?? shiftInfo
    managerMsg += `\n📅 Scheduled: ${shift.name} at ${shift.start_time}`
  } else {
    managerMsg += `\n📅 No shift found for them today`
  }

  managerMsg += `\n💬 Original: "${msg.text}"`

  await bot.sendMessage(session.dm_chat_id, managerMsg, { parse_mode: 'Markdown' })
  logger.bot(`Late arrival alert sent to manager for ${staffName}`)
}
