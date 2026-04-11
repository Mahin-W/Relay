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

  const request = await _saveRequest(groupId, groupName, shiftDesc, requestedBy, msg.from?.id ?? null)

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

  // Coverage speed: get top responders for priority DMs
  let topNames = new Set()
  try {
    const { getTopResponders, formatCoverageSpeedNotice } = await import('../intelligence/coverageSpeed.js')
    const top = await getTopResponders(groupId, 3)
    if (top.length >= 2) {
      topNames = new Set(top.map(t => t.staffName))

      // Compute team avg fill time from stats
      const avgFill = Math.round(top.reduce((sum, t) => sum + t.avgResponseMinutes, 0) / top.length)
      const notice = formatCoverageSpeedNotice(top, avgFill)

      // DM manager with speed notice (fire-and-forget)
      if (notice && requesterId) {
        import('../setup/setupDb.js').then(({ getManagerGroup }) =>
          getManagerGroup(requesterId).then(mg => {
            if (mg?.dm_chat_id) {
              bot.sendMessage(mg.dm_chat_id, notice, { parse_mode: 'Markdown' }).catch(() => {})
            }
          })
        ).catch(() => {})
      }
    }
  } catch (err) {
    logger.error(`Coverage speed check failed (non-fatal): ${err.message}`)
  }

  // Separate into priority (top responders + on-call) and everyone else
  const priority = []
  const rest = []
  for (const member of toNotify) {
    if (!member.dmChatId) continue
    const isTopResponder = topNames.has(member.firstName)
    const isOnCall = onCallSet.has(String(member.userId))
    if (isTopResponder || isOnCall) {
      priority.push({ ...member, isOnCall, isTopResponder })
    } else {
      rest.push({ ...member, isOnCall: false, isTopResponder: false })
    }
  }

  // DM priority responders immediately
  for (const member of priority) {
    try {
      const tag = member.isOnCall ? 'on call — first dibs' : 'top responder'
      const dmText = `🔔 *Coverage Needed — ${groupName}*\n\n` +
        `*Shift:* ${shiftLabel}\n` +
        `*Requested by:* ${requestedBy}\n\n` +
        `Can you cover it? Reply *yes* to volunteer ✋`
      await bot.sendMessage(member.dmChatId, dmText, { parse_mode: 'Markdown' })
      await _saveOutreach(request.id, member.userId)
      logger.bot(`DM sent to ${member.firstName} (${tag} — priority)`)
    } catch (err) {
      logger.error(`Failed to DM ${member.firstName}: ${err.message}`)
    }
  }

  // DM everyone else — immediately if no priority data, delayed 5min otherwise
  const sendToRest = async () => {
    for (const member of rest) {
      try {
        const dmText = `🔔 *Coverage Needed — ${groupName}*\n\n` +
          `*Shift:* ${shiftLabel}\n` +
          `*Requested by:* ${requestedBy}\n\n` +
          `Can you cover it? Reply *yes* to volunteer ✋`
        await bot.sendMessage(member.dmChatId, dmText, { parse_mode: 'Markdown' })
        await _saveOutreach(request.id, member.userId)
        logger.bot(`DM sent to ${member.firstName}`)
      } catch (err) {
        logger.error(`Failed to DM ${member.firstName}: ${err.message}`)
      }
    }
  }

  if (topNames.size >= 2 && rest.length > 0) {
    // Delay 5 minutes, then send to everyone else (fire-and-forget)
    setTimeout(() => {
      sendToRest().catch(err => logger.error(`Delayed DM blast failed: ${err.message}`))
    }, 5 * 60 * 1000)
    logger.bot(`${rest.length} remaining staff will be notified in 5 minutes`)
  } else {
    await sendToRest()
  }
}
