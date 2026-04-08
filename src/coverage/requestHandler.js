import { saveRequest, getGroupMembersWithDm, saveOutreach, updateCoverageRequestShift } from '../db.js'
import { getShiftRoster } from '../shiftMatcher.js'
import { logger } from '../logger.js'
import { resolveShift } from './shiftResolver.js'
import { getOnCallStaff as liveGetOnCallStaff } from '../oncall/onCallDb.js'
import { recordEvent as liveRecordEvent } from '../reliability/reliabilityDb.js'

function buildRequestMessage(requestedBy, shiftDesc, matchedShift, roster) {
  if (matchedShift && !matchedShift.low_confidence) {
    const rosterLines = roster.length > 0
      ? roster.map(r => `• ${r.staffName} _(${r.roleName})_`).join('\n')
      : '• No assignments recorded yet'

    return (
      `📋 *Shift Coverage Needed*\n\n` +
      `📅 *Shift:* ${matchedShift.name}\n` +
      `🕐 *When:* ${matchedShift.day_of_week}, ${matchedShift.start_time}–${matchedShift.end_time}\n` +
      `👤 *Requested by:* ${requestedBy}\n\n` +
      `*Currently scheduled:*\n${rosterLines}\n\n` +
      `✋ Reply *I can cover* to volunteer.`
    )
  }

  return (
    `📋 *Shift Coverage Needed*\n\n` +
    `*Shift:* ${shiftDesc}\n` +
    `*Requested by:* ${requestedBy}\n\n` +
    `Reply *I can cover* to volunteer ✋\n\n` +
    `_(Shift not identified — reply with day and time if needed)_`
  )
}

export async function handleCoverageRequest(bot, msg, intent, db = null) {
  const _saveRequest = db?.saveRequest ?? saveRequest
  const _getGroupMembersWithDm = db?.getGroupMembersWithDm ?? getGroupMembersWithDm
  const _saveOutreach = db?.saveOutreach ?? saveOutreach
  const _updateCoverageRequestShift = db?.updateCoverageRequestShift ?? updateCoverageRequestShift
  const _getShiftRoster = db?.getShiftRoster ?? getShiftRoster
  const _getOnCallStaff = db?.getOnCallStaff ?? liveGetOnCallStaff
  const _recordEvent = db?.recordEvent ?? liveRecordEvent

  const groupId = String(msg.chat.id)
  const groupName = msg.chat.title || 'Unknown Group'
  const requestedBy = intent.person || msg.from?.first_name || 'Someone'
  const requesterId = msg.from?.id
  const shiftDesc = intent.shift || 'unspecified shift'

  const request = await _saveRequest(groupId, groupName, shiftDesc, requestedBy)

  // Record reliability event — fire-and-forget, never crashes handler
  if (requesterId) {
    _recordEvent(requesterId, groupId, 'called_out').catch(err =>
      logger.error(`recordEvent called_out failed: ${err.message}`)
    )
  }

  let matchedShift = intent._preResolvedShift ?? null
  let matchedWeekStart = intent._preResolvedWeekStart ?? null
  if (!matchedShift) {
    const resolved = await resolveShift(bot, msg, groupId, shiftDesc, requestedBy, 'coverage_request', intent)
    matchedShift = resolved.matchedShift
    matchedWeekStart = resolved.matchedWeekStart
  }
  if (!matchedShift) return

  const roster = await _getShiftRoster(matchedShift.id, matchedWeekStart).catch(() => [])
  if (request) {
    await _updateCoverageRequestShift(request.id, matchedShift.id, matchedWeekStart).catch(err =>
      logger.error(`updateCoverageRequestShift failed: ${err.message}`)
    )
  }

  const groupText = buildRequestMessage(requestedBy, shiftDesc, matchedShift, roster)
  await bot.sendMessage(msg.chat.id, groupText, { parse_mode: 'Markdown' })
  logger.bot(`Coverage request posted in ${groupName}: ${shiftDesc}`)

  if (!request) {
    logger.error('saveRequest failed — skipping staff DMs')
    return
  }

  const staff = await _getGroupMembersWithDm(groupId).catch(() => [])
  const toNotify = staff.filter(s => s.userId !== requesterId)

  if (toNotify.length === 0) {
    logger.bot('No registered staff to DM')
    return
  }

  const shiftLabel = `${matchedShift.name} (${matchedShift.day_of_week}, ${matchedShift.start_time}–${matchedShift.end_time})`

  const onCallRecords = await _getOnCallStaff(groupId, matchedWeekStart).catch(() => [])
  const onCallSet = new Set(onCallRecords.map(r => String(r.staff_id)))

  for (const member of toNotify) {
    if (!member.dmChatId) continue
    try {
      const isOnCall = onCallSet.has(String(member.userId))
      const dmText = isOnCall
        ? `🔔 *You're on call — first dibs!*\n\n` +
          `*Shift:* ${shiftLabel}\n` +
          `*Requested by:* ${requestedBy}\n\n` +
          `Can you cover it? Reply *yes* to volunteer ✋`
        : `🔔 *Coverage Needed — ${groupName}*\n\n` +
          `*Shift:* ${shiftLabel}\n` +
          `*Requested by:* ${requestedBy}\n\n` +
          `Can you cover it? Reply *yes* to volunteer ✋`
      await bot.sendMessage(member.dmChatId, dmText, { parse_mode: 'Markdown' })
      await _saveOutreach(request.id, member.userId)
      logger.bot(`DM sent to ${member.firstName}${isOnCall ? ' (on-call priority)' : ''}`)
    } catch (err) {
      logger.error(`Failed to DM ${member.firstName}: ${err.message}`)
    }
  }
}
