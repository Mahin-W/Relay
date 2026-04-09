import {
  saveTimeOffRequest,
  getPendingTimeOffByName,
  updateTimeOffStatus,
  getStaffDmChatId,
} from './timeOffDb.js'
import { getSetupSession, getManagerGroup } from '../setup/setupDb.js'
import { saveAvailability } from '../availability/availabilityDb.js'
import { logger } from '../logger.js'

function computeWeekStart(dateString) {
  if (!dateString || dateString === 'unknown date') return null

  const norm = dateString.trim().toLowerCase()
  const DAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday']

  const dayIndex = DAYS.findIndex(d => norm.includes(d))
  if (dayIndex !== -1) {
    const today = new Date()
    const todayDay = today.getDay()
    let daysAhead = dayIndex - todayDay
    if (daysAhead <= 0) daysAhead += 7
    const target = new Date(today)
    target.setDate(today.getDate() + daysAhead)
    const dayOfWeek = target.getDay()
    const daysFromMonday = dayOfWeek === 0 ? -6 : 1 - dayOfWeek
    const monday = new Date(target)
    monday.setDate(target.getDate() + daysFromMonday)
    return monday.toISOString().slice(0, 10)
  }

  const currentYear = new Date().getFullYear()
  const candidates = [
    new Date(`${dateString} ${currentYear}`),
    new Date(dateString),
  ]
  for (const d of candidates) {
    if (!isNaN(d.getTime())) {
      const dayOfWeek = d.getDay()
      const daysFromMonday = dayOfWeek === 0 ? -6 : 1 - dayOfWeek
      const monday = new Date(d)
      monday.setDate(d.getDate() + daysFromMonday)
      return monday.toISOString().slice(0, 10)
    }
  }

  return null
}

export async function handleTimeOffRequest(bot, msg, intent, db = null) {
  const _saveTimeOffRequest = db?.saveTimeOffRequest ?? saveTimeOffRequest
  const _getSetupSession = db?.getSetupSession ?? getSetupSession

  const groupId = String(msg.chat.id)
  const staffName = intent.person || msg.from?.first_name || 'Someone'
  const staffTelegramId = msg.from?.id
  const requestedDate = intent.date || 'unknown date'

  const weekStart = computeWeekStart(requestedDate)
  const request = await _saveTimeOffRequest(groupId, staffTelegramId, staffName, requestedDate, weekStart)

  await bot.sendMessage(
    msg.chat.id,
    `📋 Got it ${staffName} — time-off request for ${requestedDate} sent to manager.`,
  )
  logger.bot(`Time-off request saved for ${staffName} on ${requestedDate}`)

  const session = await _getSetupSession(groupId)
  if (!session?.dm_chat_id) {
    logger.bot('No manager DM found — skipping manager notification')
    return request
  }

  await bot.sendMessage(
    session.dm_chat_id,
    `⏳ *Time-off request*\n👤 ${staffName} is asking for ${requestedDate} off.\nReply *approve ${staffName}* or *deny ${staffName}*`,
    { parse_mode: 'Markdown' },
  )
  logger.bot(`Time-off request DM sent to manager for ${staffName}`)

  return request
}

export async function handleManagerTimeOffReply(bot, msg, db = null) {
  const _getManagerGroup = db?.getManagerGroup ?? getManagerGroup
  const _getPendingTimeOffByName = db?.getPendingTimeOffByName ?? getPendingTimeOffByName
  const _updateTimeOffStatus = db?.updateTimeOffStatus ?? updateTimeOffStatus
  const _getStaffDmChatId = db?.getStaffDmChatId ?? getStaffDmChatId
  const _saveAvailability = db?.saveAvailability ?? saveAvailability

  const text = msg.text?.trim() ?? ''
  const match = text.match(/^(approve|deny)\s+(\S+)/i)
  if (!match) return false

  const action = match[1].toLowerCase()
  const staffName = match[2]
  const managerId = msg.from?.id

  const managerGroup = await _getManagerGroup(managerId)
  if (!managerGroup) return false

  const { group_id: groupId, group_name: groupName } = managerGroup

  const request = await _getPendingTimeOffByName(groupId, staffName)
  if (!request) return false

  const newStatus = action === 'approve' ? 'approved' : 'denied'
  await _updateTimeOffStatus(request.id, newStatus)

  const staffDm = await _getStaffDmChatId(request.staff_telegram_id)
  if (staffDm?.dm_chat_id) {
    if (newStatus === 'approved') {
      await bot.sendMessage(
        staffDm.dm_chat_id,
        `✅ Your time-off for ${request.requested_date} has been approved 👍`,
      )
    } else {
      const managerNameHint = managerGroup.setup_data?.managerName || 'your manager'
      await bot.sendMessage(
        staffDm.dm_chat_id,
        `❌ Your time-off for ${request.requested_date} was denied. Check with ${managerNameHint} if you have questions.`,
      )
    }
  }

  if (newStatus === 'approved' && request.staff_telegram_id && request.week_start) {
    await _saveAvailability(
      request.staff_telegram_id,
      groupId,
      request.week_start,
      [],
      false,
      true,
      'time_off_approved',
    ).catch(err => logger.error(`saveAvailability failed: ${err.message}`))
  }

  logger.bot(`Time-off ${newStatus} for ${staffName} by manager in ${groupName}`)
  return true
}
