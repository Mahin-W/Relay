import { saveTradeRequest, markTradeCompleted, getGroupMembersWithDm, getOpenRequest, markCovered } from '../db.js'
import { swapPublishedScheduleAssignment } from '../availability/availabilityDb.js'
import { getShiftById, swapScheduleAssignment, getStaffForGroup, getShiftsForGroup } from '../setup/setupDb.js'
import { logger } from '../logger.js'
import { resolveShift } from './shiftResolver.js'
import { getPublishedSchedule } from '../availability/availabilityDb.js'
import { formatScheduleMessage } from '../schedule/generateSchedule.js'
import { matchShift, getCurrentWeekStart } from '../shiftMatcher.js'
import { getRecurringConstraints } from '../timeOff/recurringTimeOffDb.js'
import { getSetupSession } from '../setup/db/sessions.js'

// Finds a staff record by display name. Tries exact match first, then
// falls back to starts-with so "Mike" matches "Mike Chen" in the staff table.
function findStaffByName(allStaff, displayName) {
  if (!displayName) return undefined
  const norm = displayName.trim().toLowerCase()
  return (
    allStaff.find(s => s.name?.toLowerCase() === norm) ??
    allStaff.find(s => s.name?.toLowerCase().startsWith(norm + ' ')) ??
    allStaff.find(s => norm.startsWith(s.name?.toLowerCase() + ' ')) ??
    allStaff.find(s => s.name?.toLowerCase().startsWith(norm))
  )
}

async function resendSchedule(bot, groupId) {
  try {
    const schedule = await getPublishedSchedule(groupId)
    if (!schedule) return
    const formatted = formatScheduleMessage(schedule.assignments ?? [], schedule.gaps ?? [], schedule.week_start)
    await bot.sendMessage(groupId, `📋 *Updated Schedule*\n\n${formatted}`, { parse_mode: 'Markdown' })
  } catch (err) {
    logger.error(`resendSchedule failed: ${err.message}`)
  }
}

/**
 * Check whether a staff member has a recurring constraint that blocks them
 * from working the given shift.
 * Returns null if ok, or a human-readable reason string if blocked.
 */
async function checkConstraintViolation(staffId, shift, db = null) {
  try {
    const _getConstraints = db?.getRecurringConstraints
      ? (id) => db.getRecurringConstraints(id)
      : (id) => getRecurringConstraints(id, null)
    const constraints = await _getConstraints(staffId)
    if (!constraints || constraints.length === 0) return null

    const shiftDay = shift.day_of_week

    for (const c of constraints) {
      if (!c.active && c.active !== undefined) continue

      if (c.type === 'day_off') {
        // days can be stored as array field or day_of_week string
        const blockedDays = c.days ?? (c.day_of_week ? [c.day_of_week] : [])
        if (blockedDays.some(d => d?.toLowerCase() === shiftDay?.toLowerCase())) {
          return { reason: `a recurring day-off on ${shiftDay}`, constraintType: 'day_off', day: shiftDay }
        }
      }

      if (c.type === 'available_days') {
        const allowedDays = c.days ?? (c.day_of_week ? [c.day_of_week] : [])
        if (allowedDays.length > 0 && !allowedDays.some(d => d?.toLowerCase() === shiftDay?.toLowerCase())) {
          return { reason: `an availability constraint (not available on ${shiftDay})`, constraintType: 'available_days', day: shiftDay }
        }
      }

      if (c.type === 'time_constraint') {
        const latestEnd = c.latest_end ?? c.afterTime ?? null
        if (latestEnd && shift.end_time) {
          // Simple string comparison works for HH:MM format; end_time may be "5:00 PM" style
          const shiftEndNorm = normalizeTime(shift.end_time)
          const latestNorm = normalizeTime(latestEnd)
          if (shiftEndNorm && latestNorm && shiftEndNorm > latestNorm) {
            return { reason: `a time constraint (shift ends ${shift.end_time}, must finish by ${latestEnd})`, constraintType: 'time_constraint', day: shiftDay }
          }
        }
      }
    }
    return null
  } catch (err) {
    logger.error(`checkConstraintViolation failed: ${err.message}`)
    return null
  }
}

/** Normalize time strings to 24h "HH:MM" for comparison. Returns null if unparseable. */
function normalizeTime(timeStr) {
  if (!timeStr) return null
  // Already HH:MM or HH:MM:SS
  const hhmm = timeStr.match(/^(\d{1,2}):(\d{2})/)
  if (hhmm) return hhmm[1].padStart(2, '0') + ':' + hhmm[2]
  // 12h format like "5:00 PM"
  const ampm = timeStr.match(/^(\d{1,2}):(\d{2})\s*(AM|PM)/i)
  if (ampm) {
    let h = parseInt(ampm[1], 10)
    const m = ampm[2]
    const period = ampm[3].toUpperCase()
    if (period === 'PM' && h !== 12) h += 12
    if (period === 'AM' && h === 12) h = 0
    return String(h).padStart(2, '0') + ':' + m
  }
  return null
}

export async function handleTradeRequest(bot, msg, intent, db = null) {
  const _saveTradeRequest = db?.saveTradeRequest ?? saveTradeRequest

  const groupId = String(msg.chat.id)
  const groupName = msg.chat.title || 'Unknown Group'
  const requestedBy = intent.person || msg.from?.first_name || 'Someone'
  const requesterId = msg.from?.id
  const shiftDesc = intent.shift || 'unspecified shift'

  let matchedShift = intent._preResolvedShift ?? null
  let matchedWeekStart = intent._preResolvedWeekStart ?? null
  if (!matchedShift) {
    const resolved = await resolveShift(bot, msg, groupId, shiftDesc, requestedBy, 'trade_request', intent)
    matchedShift = resolved.matchedShift
    matchedWeekStart = resolved.matchedWeekStart
  }
  if (!matchedShift) return

  const trade = await _saveTradeRequest(groupId, groupName, requesterId, requestedBy, matchedShift.id, matchedShift.name, matchedWeekStart)
  if (!trade) {
    await bot.sendMessage(msg.chat.id, 'Something went wrong — try again.')
    return
  }

  await bot.sendMessage(
    msg.chat.id,
    `🔄 *Shift Trade Offer*\n\n` +
    `*${requestedBy}* wants to trade:\n` +
    `📅 *${matchedShift.name}* — ${matchedShift.day_of_week}, ${matchedShift.start_time}–${matchedShift.end_time}\n\n` +
    `Reply *"trade my [shift name]"* to swap with them.`,
    { parse_mode: 'Markdown' }
  )
  logger.bot(`Trade request posted in ${groupName}: ${matchedShift.name}`)

  // DM all registered staff (informational — tell them to reply in group or DM)
  const staff = await getGroupMembersWithDm(groupId).catch(() => [])
  const toNotify = staff.filter(s => s.userId !== requesterId)
  for (const member of toNotify) {
    try {
      await bot.sendMessage(
        member.dmChatId,
        `🔄 *Shift Trade Available — ${groupName}*\n\n` +
        `*${requestedBy}* wants to trade:\n` +
        `📅 *${matchedShift.name}* — ${matchedShift.day_of_week}, ${matchedShift.start_time}–${matchedShift.end_time}\n\n` +
        `Interested? Reply *"trade my [shift name]"* here or in the group to swap.`,
        { parse_mode: 'Markdown' }
      )
    } catch (err) {
      logger.error(`Failed to DM ${member.firstName} about trade: ${err.message}`)
    }
  }
}

export async function handleTradeOffer(bot, msg, intent, openTrade, db = null) {
  const groupId = String(msg.chat.id)
  const offererName = intent.person || msg.from?.first_name || 'Someone'
  const offererId = msg.from?.id
  const shiftDesc = intent.shift || 'unspecified shift'

  if (offererId === openTrade.requester_id) {
    await bot.sendMessage(msg.chat.id, `You can't trade with yourself, ${offererName} 😅`)
    return
  }

  let offeredShift = intent._preResolvedShift ?? null
  let offeredWeekStart = intent._preResolvedWeekStart ?? null
  if (!offeredShift) {
    const resolved = await resolveShift(bot, msg, groupId, shiftDesc, offererName, 'trade_offer', { ...intent, openTrade })
    offeredShift = resolved.matchedShift
    offeredWeekStart = resolved.matchedWeekStart
  }
  if (!offeredShift) return

  const requestedShift = await getShiftById(openTrade.shift_id)
  if (!requestedShift) {
    await bot.sendMessage(msg.chat.id, 'Something went wrong — try again.')
    return
  }

  const allStaff = await getStaffForGroup(groupId)
  const requesterStaff = allStaff.find(s => s.name?.toLowerCase() === openTrade.requester_name?.toLowerCase())
  const offererStaff = allStaff.find(s => s.name?.toLowerCase() === offererName.toLowerCase())

  if (!requesterStaff || !offererStaff) {
    logger.bot(`Trade swap failed — staff record not found (requester: ${openTrade.requester_name}, offerer: ${offererName})`)
    await bot.sendMessage(msg.chat.id, `⚠️ Trade couldn't be completed — couldn't match staff records. Please try again or contact your manager.`)
    return
  }

  // ── Recurring-constraint gate ──────────────────────────────────────────────
  // Offerer moves TO requestedShift; requester moves TO offeredShift.
  const offererViolation = await checkConstraintViolation(offererStaff.id, requestedShift, db)
  const requesterViolation = await checkConstraintViolation(requesterStaff.id, offeredShift, db)

  if (offererViolation || requesterViolation) {
    const violation = offererViolation ?? requesterViolation
    const blockedName = offererViolation ? offererName : openTrade.requester_name
    const blockedShift = offererViolation ? requestedShift : offeredShift
    const rejectMsg =
      `You have ${violation.reason} — can't trade into that shift. Manager must override.`
    await bot.sendMessage(msg.chat.id, `⚠️ ${rejectMsg}`)

    // DM the blocked person
    const blockedStaff = offererViolation ? offererStaff : requesterStaff
    if (blockedStaff.dm_chat_id) {
      await bot.sendMessage(String(blockedStaff.dm_chat_id), rejectMsg).catch(() => {})
    }

    // DM the manager
    try {
      const _getSession = db?.getSetupSession
        ? (id) => db.getSetupSession(id)
        : (id) => getSetupSession(id)
      const session = await _getSession(groupId)
      if (session?.dm_chat_id) {
        await bot.sendMessage(
          String(session.dm_chat_id),
          `⚠️  ${blockedName} tried to trade into ${blockedShift.day_of_week} ${blockedShift.name} but has a ${violation.constraintType} constraint — not executed.`
        )
      }
    } catch (sessionErr) {
      logger.error(`constraint-gate manager DM failed: ${sessionErr.message}`)
    }
    return
  }

  try {
    await swapScheduleAssignment(groupId, openTrade.shift_id, openTrade.week_start, requesterStaff.id, offererStaff.id)
    await swapPublishedScheduleAssignment(groupId, openTrade.shift_id, requesterStaff.id, offererName, offererStaff.id)
    await swapScheduleAssignment(groupId, offeredShift.id, offeredWeekStart, offererStaff.id, requesterStaff.id)
    await swapPublishedScheduleAssignment(groupId, offeredShift.id, offererStaff.id, openTrade.requester_name, requesterStaff.id)
  } catch (swapErr) {
    logger.error(`Trade swap failed: ${swapErr.message}`)
    await bot.sendMessage(msg.chat.id, `⚠️ Trade couldn't be completed — please check the schedule and try again.`)
    return
  }

  logger.bot(`Trade complete: ${openTrade.requester_name} ↔ ${offererName}`)
  await markTradeCompleted(openTrade.id, offererId, offererName, offeredShift.id, offeredShift.name)

  await bot.sendMessage(
    msg.chat.id,
    `✅ *Shift Trade Confirmed!*\n\n` +
    `📅 *${openTrade.requester_name}* now has: *${offeredShift.name}* — ${offeredShift.day_of_week}, ${offeredShift.start_time}–${offeredShift.end_time}\n` +
    `📅 *${offererName}* now has: *${requestedShift.name}* — ${requestedShift.day_of_week}, ${requestedShift.start_time}–${requestedShift.end_time}`,
    { parse_mode: 'Markdown' }
  )
  await resendSchedule(bot, groupId)
}

// Handles a trade offer made in the group chat in response to an open coverage request.
// Instead of just covering the shift, the offerer proposes a swap.
export async function handleCoverageTradeOffer(bot, msg, intent, openRequest) {
  const groupId = String(msg.chat.id)
  const offererName = intent.person || msg.from?.first_name || 'Someone'
  const offererId = msg.from?.id
  const shiftDesc = intent.shift || 'unspecified shift'

  if (String(offererId) === String(openRequest.requester_id) ||
      offererName.toLowerCase() === openRequest.requested_by?.toLowerCase()) {
    await bot.sendMessage(msg.chat.id, `You can't trade for your own coverage request, ${offererName} 😅`)
    return
  }

  let offeredShift = intent._preResolvedShift ?? null
  let offeredWeekStart = intent._preResolvedWeekStart ?? null
  if (!offeredShift) {
    const resolved = await resolveShift(bot, msg, groupId, shiftDesc, offererName, 'trade_offer', { ...intent, openRequest })
    offeredShift = resolved.matchedShift
    offeredWeekStart = resolved.matchedWeekStart
  }
  if (!offeredShift) return

  const requestedShift = openRequest.matched_shift_id ? await getShiftById(openRequest.matched_shift_id).catch(() => null) : null

  if (requestedShift) {
    const allStaff = await getStaffForGroup(groupId).catch(() => [])
    const requesterStaff = findStaffByName(allStaff, openRequest.requested_by)
    const offererStaff = findStaffByName(allStaff, offererName)

    if (!requesterStaff || !offererStaff) {
      logger.bot(`Coverage trade swap failed — staff not found (requester: ${openRequest.requested_by}, offerer: ${offererName})`)
      await bot.sendMessage(msg.chat.id,
        `⚠️ Couldn't complete the trade — staff records not found for one or both people. The coverage request is still open.`)
      return
    }

    try {
      await swapScheduleAssignment(groupId, offeredShift.id, offeredWeekStart, offererStaff.id, requesterStaff.id)
      await swapPublishedScheduleAssignment(groupId, offeredShift.id, offererStaff.id, openRequest.requested_by, requesterStaff.id)
      await swapScheduleAssignment(groupId, requestedShift.id, openRequest.week_start, requesterStaff.id, offererStaff.id)
      await swapPublishedScheduleAssignment(groupId, requestedShift.id, requesterStaff.id, offererName, offererStaff.id)
      logger.bot(`Trade-coverage swap: ${openRequest.requested_by} ↔ ${offererName}`)
    } catch (swapErr) {
      logger.error(`Coverage trade swap error: ${swapErr.message}`)
      await bot.sendMessage(msg.chat.id,
        `⚠️ Trade couldn't be completed — schedule update failed. The coverage request is still open.`)
      return
    }
  }

  await markCovered(openRequest.id, offererName)

  const text = requestedShift
    ? `✅ *Shift Trade — Coverage Resolved*\n\n` +
      `📅 *${openRequest.requested_by}* now has: *${offeredShift.name}* — ${offeredShift.day_of_week}, ${offeredShift.start_time}–${offeredShift.end_time}\n` +
      `📅 *${offererName}* now has: *${requestedShift.name}* — ${requestedShift.day_of_week}, ${requestedShift.start_time}–${requestedShift.end_time}`
    : `✅ *Shift Trade — Coverage Resolved*\n\n` +
      `*${offererName}* is covering *${openRequest.requested_by}*'s shift via trade of their *${offeredShift.name}*.`

  await bot.sendMessage(msg.chat.id, text, { parse_mode: 'Markdown' })
  await resendSchedule(bot, groupId)
  logger.success(`${offererName} resolved coverage via trade in ${msg.chat.title || groupId}`)
}

// Handles a trade offer sent via DM in response to a coverage outreach message.
export async function handleDmCoverageTradeOffer(bot, msg, intent, openRequest) {
  const offererName = msg.from?.first_name || 'Someone'
  const groupId = openRequest.group_id
  const shiftDesc = intent.shift || 'unspecified shift'

  if (offererName.toLowerCase() === openRequest.requested_by?.toLowerCase()) {
    await bot.sendMessage(msg.chat.id, `You can't trade for your own coverage request 😅`)
    return
  }

  // Resolve shift without pending-clarification state (DM context — no group message trigger)
  const offeredShift = await matchShift(groupId, shiftDesc, msg.text).catch(() => null)
  if (!offeredShift || offeredShift.low_confidence) {
    const shifts = await getShiftsForGroup(groupId).catch(() => [])
    let clarifyText = `🤔 I'm not sure which shift you mean. Which shift do you want to trade?`
    if (shifts.length > 0) {
      const lines = shifts.map(s => `• *${s.name}* — ${s.day_of_week}, ${s.start_time}–${s.end_time}`).join('\n')
      clarifyText += `\n\n${lines}\n\nReply like: _"trade my [shift name]"_`
    }
    await bot.sendMessage(msg.chat.id, clarifyText, { parse_mode: 'Markdown' })
    return
  }

  const offeredWeekStart = getCurrentWeekStart()
  const requestedShift = openRequest.matched_shift_id ? await getShiftById(openRequest.matched_shift_id).catch(() => null) : null

  if (requestedShift) {
    const allStaff = await getStaffForGroup(groupId).catch(() => [])
    const requesterStaff = findStaffByName(allStaff, openRequest.requested_by)
    const offererStaff = findStaffByName(allStaff, offererName)

    if (!requesterStaff || !offererStaff) {
      logger.bot(`DM coverage trade swap failed — staff not found (requester: ${openRequest.requested_by}, offerer: ${offererName})`)
      await bot.sendMessage(msg.chat.id,
        `⚠️ Couldn't complete the trade — staff records not found. The coverage request is still open.`)
      await bot.sendMessage(groupId,
        `⚠️ Trade couldn't be completed — staff records not found for one or both people. The coverage request is still open.`)
      return
    }

    try {
      await swapScheduleAssignment(groupId, offeredShift.id, offeredWeekStart, offererStaff.id, requesterStaff.id)
      await swapPublishedScheduleAssignment(groupId, offeredShift.id, offererStaff.id, openRequest.requested_by, requesterStaff.id)
      await swapScheduleAssignment(groupId, requestedShift.id, openRequest.week_start, requesterStaff.id, offererStaff.id)
      await swapPublishedScheduleAssignment(groupId, requestedShift.id, requesterStaff.id, offererName, offererStaff.id)
      logger.bot(`DM trade-coverage swap: ${openRequest.requested_by} ↔ ${offererName}`)
    } catch (swapErr) {
      logger.error(`DM coverage trade swap error: ${swapErr.message}`)
      await bot.sendMessage(msg.chat.id,
        `⚠️ Trade couldn't be completed — schedule update failed. The coverage request is still open.`)
      await bot.sendMessage(groupId,
        `⚠️ Trade couldn't be completed — please check the schedule and try again.`)
      return
    }
  }

  await markCovered(openRequest.id, offererName)

  await bot.sendMessage(
    msg.chat.id,
    `✅ Done! You're trading your *${offeredShift.name}* for *${openRequest.requested_by}*'s shift.\n\nThe group has been notified.`,
    { parse_mode: 'Markdown' }
  )

  const groupText = requestedShift
    ? `✅ *Shift Trade — Coverage Resolved*\n\n` +
      `📅 *${openRequest.requested_by}* now has: *${offeredShift.name}* — ${offeredShift.day_of_week}, ${offeredShift.start_time}–${offeredShift.end_time}\n` +
      `📅 *${offererName}* now has: *${requestedShift.name}* — ${requestedShift.day_of_week}, ${requestedShift.start_time}–${requestedShift.end_time}`
    : `✅ *Shift Trade — Coverage Resolved*\n\n` +
      `*${offererName}* is covering *${openRequest.requested_by}*'s shift via trade of their *${offeredShift.name}*.`

  await bot.sendMessage(groupId, groupText, { parse_mode: 'Markdown' })
  await resendSchedule(bot, groupId)
  logger.success(`${offererName} resolved coverage via DM trade in group ${groupId}`)
}
