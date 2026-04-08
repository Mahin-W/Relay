import { findPersonShiftForDay } from '../setup/db/assignments.js'
import { getSetupSession } from '../setup/setupDb.js'
import { logger } from '../logger.js'

function getTodayDayName() {
  return new Date().toLocaleDateString('en-US', { weekday: 'long' })
}

export async function handleLateArrival(bot, msg, intent, db = null) {
  const _findShiftForToday = db?.findShiftForToday ?? null
  const _getSetupSession = db?.getSetupSession ?? getSetupSession

  const groupId = String(msg.chat.id)
  const staffName = intent.person || msg.from?.first_name || 'Someone'
  const staffId = msg.from?.id
  const today = getTodayDayName()

  // Quiet group ack
  await bot.sendMessage(msg.chat.id, `Got it ${staffName} 👍`)

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
