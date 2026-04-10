import { getOpenRequest, markCovered, getOutreachByUser } from '../db.js'
import { getPublishedSchedule, swapPublishedScheduleAssignment } from '../availability/availabilityDb.js'
import { formatScheduleMessage } from '../schedule/generateSchedule.js'
import { getShiftById, swapScheduleAssignment, getStaffForGroup } from '../setup/setupDb.js'
import { logger } from '../logger.js'
import { recordEvent as liveRecordEvent } from '../reliability/reliabilityDb.js'

async function swapIfPossible(openRequest, volunteer, groupId) {
  if (!openRequest.matched_shift_id || !openRequest.week_start) return
  try {
    const allStaff = await getStaffForGroup(groupId)
    const volunteerStaff = allStaff.find(s => s.name?.toLowerCase() === volunteer.toLowerCase())
    const requesterStaff = allStaff.find(s => s.name?.toLowerCase() === openRequest.requested_by?.toLowerCase())
    if (volunteerStaff && requesterStaff) {
      await swapScheduleAssignment(groupId, openRequest.matched_shift_id, openRequest.week_start, requesterStaff.id, volunteerStaff.id)
      await swapPublishedScheduleAssignment(groupId, openRequest.matched_shift_id, requesterStaff.id, volunteerStaff.name, volunteerStaff.id)
      logger.bot(`Schedule updated: ${requesterStaff.name} → ${volunteerStaff.name}`)
    } else {
      logger.bot(`Could not swap — staff not found (volunteer: ${volunteer}, requester: ${openRequest.requested_by})`)
    }
  } catch (err) {
    logger.error(`swapIfPossible failed: ${err.message}`)
  }
}

async function resendSchedule(bot, groupId) {
  try {
    const schedule = await getPublishedSchedule(groupId)
    if (!schedule) {
      logger.bot('No published schedule found — skipping resend')
      return
    }
    const formatted = formatScheduleMessage(schedule.assignments ?? [], schedule.gaps ?? [], schedule.week_start)
    await bot.sendMessage(groupId, `📋 *Updated Schedule*\n\n${formatted}`, { parse_mode: 'Markdown' })
  } catch (err) {
    logger.error(`resendSchedule failed: ${err.message}`)
  }
}

async function buildConfirmationMessage(volunteer, openRequest) {
  if (openRequest.matched_shift_id) {
    try {
      const shift = await getShiftById(openRequest.matched_shift_id)
      if (shift) {
        return (
          `✅ *Shift Covered*\n\n` +
          `📅 *Shift:* ${shift.name} — ${shift.day_of_week}, ${shift.start_time}–${shift.end_time}\n` +
          `✅ *Covered by:* ${volunteer}\n` +
          `👤 *Originally:* ${openRequest.requested_by}\n\n` +
          `_Manager — you're all set_ 👍`
        )
      }
    } catch (err) {
      logger.error(`getShiftById failed in buildConfirmationMessage: ${err.message}`)
    }
  }

  return (
    `✅ *Shift Covered*\n\n` +
    `*${volunteer}* is covering the *${openRequest.shift_description}* shift.\n\n` +
    `_Manager — you're all set_ 👍`
  )
}

export async function handleCoverageConfirmation(bot, msg, intent, db = null) {
  const _getOpenRequest = db?.getOpenRequest ?? getOpenRequest
  const _markCovered = db?.markCovered ?? markCovered
  const _recordEvent = db?.recordEvent ?? liveRecordEvent

  const groupId = String(msg.chat.id)
  const volunteer = intent.person || msg.from?.first_name || 'Someone'

  const openRequest = await _getOpenRequest(groupId)

  if (!openRequest) {
    await bot.sendMessage(msg.chat.id, 'No open coverage requests right now 👍')
    return
  }

  const volunteerId = msg.from?.id
  const isRequester = volunteerId && openRequest.requester_telegram_id
    ? String(volunteerId) === String(openRequest.requester_telegram_id)
    : volunteer.toLowerCase() === openRequest.requested_by?.toLowerCase()  // legacy fallback

  if (isRequester) {
    await bot.sendMessage(msg.chat.id, `You can't cover your own shift, ${volunteer} 😅`)
    return
  }

  const marked = await _markCovered(openRequest.id, volunteer)
  if (!marked) {
    await bot.sendMessage(msg.chat.id, 'That shift was already covered by someone else — thanks for offering! 🙏')
    return
  }

  // Record reliability event — fire-and-forget, never crashes handler
  if (msg.from?.id) {
    _recordEvent(msg.from.id, groupId, 'covered_someone').catch(err =>
      logger.error(`recordEvent covered_someone failed: ${err.message}`)
    )
  }

  await swapIfPossible(openRequest, volunteer, groupId)

  const text = await buildConfirmationMessage(volunteer, openRequest)
  await bot.sendMessage(msg.chat.id, text, { parse_mode: 'Markdown' })
  await resendSchedule(bot, groupId)
  logger.success(`${volunteer} is covering "${openRequest.shift_description}" in ${msg.chat.title || groupId}`)
}

export async function handleDmConfirmation(bot, msg) {
  const userId = msg.from?.id
  const volunteer = msg.from?.first_name || 'Someone'

  const request = await getOutreachByUser(userId)

  if (!request) {
    await bot.sendMessage(msg.chat.id, "There's no open coverage request waiting on you right now 👍")
    return
  }

  const openRequest = await getOpenRequest(request.group_id)
  if (!openRequest || openRequest.id !== request.id) {
    await bot.sendMessage(msg.chat.id, "That shift was already covered by someone else — thanks for offering! 🙏")
    return
  }

  const isDmRequester = userId && openRequest.requester_telegram_id
    ? String(userId) === String(openRequest.requester_telegram_id)
    : volunteer.toLowerCase() === openRequest.requested_by?.toLowerCase()  // legacy fallback

  if (isDmRequester) {
    await bot.sendMessage(msg.chat.id, `You can't cover your own shift 😅`)
    return
  }

  const marked = await markCovered(request.id, volunteer)
  if (!marked) {
    await bot.sendMessage(msg.chat.id, 'Something went wrong — try again.')
    return
  }

  await swapIfPossible(openRequest, volunteer, request.group_id)

  await bot.sendMessage(
    msg.chat.id,
    `✅ Got it! You're covering the *${request.shift_description}* shift.\n\nThe group has been notified.`,
    { parse_mode: 'Markdown' }
  )

  const groupText = await buildConfirmationMessage(volunteer, openRequest)
  await bot.sendMessage(request.group_id, groupText, { parse_mode: 'Markdown' })
  await resendSchedule(bot, request.group_id)
  logger.success(`${volunteer} confirmed via DM — covering "${request.shift_description}" in ${request.group_name}`)
}
