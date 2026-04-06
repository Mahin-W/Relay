import { saveRequest, getOpenRequest, markCovered, getGroupMembersWithDm, saveOutreach, getOutreachByUser, updateCoverageRequestShift, getMostRecentRequest } from './db.js'
import { getPublishedSchedule } from './availability/availabilityDb.js'
import { formatScheduleMessage } from './schedule/generateSchedule.js'
import { isSetupComplete, getShiftById, findPersonShiftForDay, swapScheduleAssignment, getStaffForGroup } from './setup/setupDb.js'
import { matchShift, getShiftRoster, getCurrentWeekStart } from './shiftMatcher.js'
import { logger } from './logger.js'

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
const DAY_NAMES = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday']
const DAY_ABBREVS = { mon: 'Monday', tue: 'Tuesday', wed: 'Wednesday', thu: 'Thursday', fri: 'Friday', sat: 'Saturday', sun: 'Sunday' }

// Extract a day name from free-form text (e.g. "my friday shift" → "Friday")
function extractDayFromText(text) {
  const lower = (text || '').toLowerCase()
  for (const [abbr, full] of Object.entries(DAY_ABBREVS)) {
    if (new RegExp(`\\b${abbr}\\b`).test(lower)) return full
  }
  for (const d of DAY_NAMES) {
    if (lower.includes(d)) return d.charAt(0).toUpperCase() + d.slice(1)
  }
  return null
}

export async function handleCoverageRequest(bot, msg, intent) {
  const groupId = String(msg.chat.id)
  const groupName = msg.chat.title || 'Unknown Group'
  const requestedBy = intent.person || msg.from?.first_name || 'Someone'
  const requesterId = msg.from?.id
  const shiftDesc = intent.shift || 'unspecified shift'

  const request = await saveRequest(groupId, groupName, shiftDesc, requestedBy)

  // Try shift-aware message if setup is complete
  let matchedShift = null
  let roster = []
  const setupDone = await isSetupComplete(groupId)

  if (setupDone) {
    const mentionedDay = extractDayFromText(shiftDesc) || extractDayFromText(msg.text)
    let matchedWeekStart = null

    // 1. If a specific day is mentioned, look up the person's scheduled shift for that day
    if (mentionedDay) {
      const result = await findPersonShiftForDay(groupId, requestedBy, mentionedDay)
      if (result?.noShift) {
        // Person exists but has no shift that day — tell them explicitly
        await bot.sendMessage(msg.chat.id, `${requestedBy} doesn't have a ${mentionedDay} shift scheduled.`)
        return
      }
      if (result?.shift) {
        matchedShift = { ...result.shift, low_confidence: false }
        matchedWeekStart = result.weekStart
        logger.bot(`Matched shift from schedule: ${result.shift.name} (week ${matchedWeekStart})`)
      }
    }

    // 2. No day mentioned — try LLM fuzzy match
    if (!matchedShift) {
      if (!mentionedDay) {
        matchedShift = await matchShift(groupId, shiftDesc, msg.text)
        matchedWeekStart = getCurrentWeekStart()
      }

      // 3. Still no confident match — infer from a recent coverage request ("that one")
      if (!matchedShift || matchedShift.low_confidence) {
        const recentReq = await getMostRecentRequest(groupId)
        if (recentReq?.matched_shift_id && recentReq?.week_start) {
          const recentShift = await getShiftById(recentReq.matched_shift_id)
          if (recentShift) {
            matchedShift = { ...recentShift, low_confidence: false }
            matchedWeekStart = recentReq.week_start
            logger.bot(`Inferred shift from recent request: ${recentShift.name}`)
          }
        }
      }
    }

    if (matchedShift && !matchedShift.low_confidence) {
      roster = await getShiftRoster(matchedShift.id, matchedWeekStart)
      if (request) await updateCoverageRequestShift(request.id, matchedShift.id, matchedWeekStart)
    }
  }

  const groupText = buildRequestMessage(requestedBy, shiftDesc, matchedShift, roster, setupDone)
  await bot.sendMessage(msg.chat.id, groupText, { parse_mode: 'Markdown' })
  logger.bot(`Coverage request posted in ${groupName}: ${shiftDesc}`)

  // DM all registered staff (except the requester)
  if (request) {
    const staff = await getGroupMembersWithDm(groupId)
    const toNotify = staff.filter(s => s.userId !== requesterId)

    if (toNotify.length === 0) {
      logger.bot('No registered staff to DM — staff need to send /start to the bot in DM')
      return
    }

    logger.bot(`DMing ${toNotify.length} staff about coverage request`)

    const shiftLabel = matchedShift && !matchedShift.low_confidence
      ? `${matchedShift.name} (${matchedShift.day_of_week}, ${matchedShift.start_time}–${matchedShift.end_time})`
      : shiftDesc

    for (const member of toNotify) {
      try {
        await bot.sendMessage(
          member.dmChatId,
          `🔔 *Coverage Needed — ${groupName}*\n\n` +
          `*Shift:* ${shiftLabel}\n` +
          `*Requested by:* ${requestedBy}\n\n` +
          `Can you cover it? Reply *yes* to volunteer ✋`,
          { parse_mode: 'Markdown' }
        )
        await saveOutreach(request.id, member.userId)
        logger.bot(`DM sent to ${member.firstName}`)
      } catch (err) {
        logger.error(`Failed to DM ${member.firstName}: ${err.message}`)
      }
    }
  }
}

export async function handleCoverageConfirmation(bot, msg, intent) {
  const groupId = String(msg.chat.id)
  const volunteer = intent.person || msg.from?.first_name || 'Someone'

  const openRequest = await getOpenRequest(groupId)

  if (!openRequest) {
    await bot.sendMessage(msg.chat.id, 'No open coverage requests right now 👍')
    logger.bot('Confirmation received but no open request found')
    return
  }

  if (volunteer.toLowerCase() === openRequest.requested_by?.toLowerCase()) {
    await bot.sendMessage(msg.chat.id, `You can't cover your own shift, ${volunteer} 😅`)
    return
  }

  await markCovered(openRequest.id, volunteer)

  const text = await buildConfirmationMessage(volunteer, openRequest)
  await bot.sendMessage(msg.chat.id, text, { parse_mode: 'Markdown' })
  await resendSchedule(bot, groupId)
  logger.success(`${volunteer} is covering "${openRequest.shift_description}" in ${msg.chat.title || groupId}`)
}

// Called when someone replies yes/I can cover in a DM
export async function handleDmConfirmation(bot, msg) {
  const userId = msg.from?.id
  const volunteer = msg.from?.first_name || 'Someone'

  const request = await getOutreachByUser(userId)

  if (!request) {
    await bot.sendMessage(msg.chat.id, "There's no open coverage request waiting on you right now 👍")
    return
  }

  // Race condition guard: verify it's still open
  const openRequest = await getOpenRequest(request.group_id)
  if (!openRequest || openRequest.id !== request.id) {
    await bot.sendMessage(msg.chat.id, "That shift was already covered by someone else — thanks for offering! 🙏")
    return
  }

  if (volunteer.toLowerCase() === openRequest.requested_by?.toLowerCase()) {
    await bot.sendMessage(msg.chat.id, `You can't cover your own shift 😅`)
    return
  }

  await markCovered(request.id, volunteer)

  // Update schedule_assignments if we have shift info
  if (openRequest.matched_shift_id && openRequest.week_start) {
    try {
      const allStaff = await getStaffForGroup(request.group_id)
      const volunteerStaff = allStaff.find(s => s.name?.toLowerCase() === volunteer.toLowerCase())
      const requesterStaff = allStaff.find(s => s.name?.toLowerCase() === openRequest.requested_by?.toLowerCase())
      if (volunteerStaff && requesterStaff) {
        await swapScheduleAssignment(request.group_id, openRequest.matched_shift_id, openRequest.week_start, requesterStaff.id, volunteerStaff.id)
        logger.bot(`Schedule updated: ${requesterStaff.name} → ${volunteerStaff.name}`)
      }
    } catch (err) {
      logger.error(`Schedule swap failed: ${err.message}`)
    }
  }

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

// ── Resend published schedule ─────────────────────────────────────────────────

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

// ── Message builders ──────────────────────────────────────────────────────────

function buildRequestMessage(requestedBy, shiftDesc, matchedShift, roster, setupDone) {
  if (matchedShift && !matchedShift.low_confidence) {
    const rosterLines =
      roster.length > 0
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

  // Fallback — simple message
  let text =
    `📋 *Shift Coverage Needed*\n\n` +
    `*Shift:* ${shiftDesc}\n` +
    `*Requested by:* ${requestedBy}\n\n` +
    `Reply *I can cover* to volunteer ✋`

  if (setupDone && !matchedShift) {
    text += `\n\n_(Shift not identified — please specify day and time)_`
  }

  return text
}

async function buildConfirmationMessage(volunteer, openRequest) {
  // If request was linked to a specific shift, show full details
  if (openRequest.matched_shift_id) {
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
  }

  return (
    `✅ *Shift Covered*\n\n` +
    `*${volunteer}* is covering the *${openRequest.shift_description}* shift.\n\n` +
    `_Manager — you're all set_ 👍`
  )
}
