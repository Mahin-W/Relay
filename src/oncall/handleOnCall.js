import {
  getStaffMember as liveGetStaffMember,
  saveOnCall as liveSaveOnCall,
  getOnCallStaff as liveGetOnCallStaff,
  clearWeekOnCall as liveClearWeekOnCall,
} from './onCallDb.js'
import { getCurrentWeekStart } from '../schedule/generateSchedule.js'
import { logger } from '../logger.js'

export async function handleOnCallOffer(bot, msg, intent, db = null) {
  const _getStaffMember = db?.getStaffMember ?? liveGetStaffMember
  const _saveOnCall = db?.saveOnCall ?? liveSaveOnCall

  const userId = msg.from?.id
  const groupId = String(msg.chat.id)

  const staff = await _getStaffMember(userId)
  if (!staff) return

  const weekStart = getCurrentWeekStart()
  const allWeek = intent.all_week !== false
  const days = intent.days ?? []

  await _saveOnCall(staff.id, groupId, weekStart, days, allWeek)

  await bot.sendMessage(
    msg.chat.id,
    `✅ Got it ${staff.name} — you're on call this week! I'll ping you first if anyone needs coverage 🔔`
  )

  logger.bot(`${staff.name} registered as on-call for group ${groupId} (week ${weekStart})`)
}

// Re-export for convenience: gets on-call staff for next week.
export async function getOnCallStaff(groupId, db = null) {
  const _getOnCallStaff = db?.getOnCallStaff ?? liveGetOnCallStaff
  const weekStart = getCurrentWeekStart()
  return _getOnCallStaff(groupId, weekStart)
}

// Re-export for convenience: clears on-call for a given week.
export async function clearOnCall(groupId, weekStart, db = null) {
  const _clearWeekOnCall = db?.clearWeekOnCall ?? liveClearWeekOnCall
  return _clearWeekOnCall(groupId, weekStart)
}
