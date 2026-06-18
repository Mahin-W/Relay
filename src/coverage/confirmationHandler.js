import { getOpenRequest, markCovered, getOutreachByUser, revertCovered } from '../db.js'
import { getPublishedSchedule, swapPublishedScheduleAssignment } from '../availability/availabilityDb.js'
import { formatScheduleMessage } from '../schedule/generateSchedule.js'
import { getShiftById, swapScheduleAssignment, getStaffForGroup, getShiftRequirements } from '../setup/setupDb.js'
import { logger } from '../logger.js'
import { recordEvent as liveRecordEvent } from '../reliability/reliabilityDb.js'
import { saveMoraleEvent } from '../intelligence/moraleDb.js'
import { classifySentiment } from '../intelligence/moraleTracker.js'

// Returns { ok: true } when the swap (or no-op) succeeded, or { ok: false, reason }
// when the schedule write failed and the caller should compensate by reverting
// the coverage_requests row back to 'open'. We treat "staff not found" as ok:true
// because there is no schedule row to update — the cover is bot-side only.
async function swapIfPossible(openRequest, volunteer, groupId) {
  if (!openRequest.matched_shift_id || !openRequest.week_start) return { ok: true }
  try {
    const allStaff = await getStaffForGroup(groupId)
    const volunteerStaff = allStaff.find(s => s.name?.toLowerCase() === volunteer.toLowerCase())
    const requesterStaff = allStaff.find(s => s.name?.toLowerCase() === openRequest.requested_by?.toLowerCase())
    if (!volunteerStaff || !requesterStaff) {
      logger.bot(`Could not swap — staff not found (volunteer: ${volunteer}, requester: ${openRequest.requested_by})`)
      return { ok: true }
    }
    // Sequential writes — both must succeed. If the published-schedule write
    // fails after the assignments write, the assignments table is still the
    // authoritative source for payroll/timeclock; we then return ok:false so
    // the caller reverts the coverage_requests row.
    await swapScheduleAssignment(groupId, openRequest.matched_shift_id, openRequest.week_start, requesterStaff.id, volunteerStaff.id)
    try {
      await swapPublishedScheduleAssignment(groupId, openRequest.matched_shift_id, requesterStaff.id, volunteerStaff.name, volunteerStaff.id)
    } catch (publishErr) {
      // Roll the assignments swap back so both tables stay consistent.
      try {
        await swapScheduleAssignment(groupId, openRequest.matched_shift_id, openRequest.week_start, volunteerStaff.id, requesterStaff.id)
      } catch (rollbackErr) {
        logger.error(`swap rollback also failed: ${rollbackErr.message}`)
      }
      throw publishErr
    }
    logger.bot(`Schedule updated: ${requesterStaff.name} → ${volunteerStaff.name}`)
    return { ok: true }
  } catch (err) {
    logger.error(`swapIfPossible failed: ${err.message}`)
    return { ok: false, reason: err.message }
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

// Validate that a volunteer's role qualifies them to cover a shift.
// Returns { ok: true } if qualified, or { ok: false, reason, requiredRoles } if not.
async function checkVolunteerRole(openRequest, volunteerName, groupId, db) {
  try {
    const _getStaffForGroup = db?.getStaffForGroup ?? getStaffForGroup
    const _getShiftRequirements = db?.getShiftRequirements ?? getShiftRequirements

    // Only check if the request has a matched shift
    if (!openRequest.matched_shift_id) return { ok: true }

    const requirements = await _getShiftRequirements(openRequest.matched_shift_id)
    if (!requirements || requirements.length === 0) return { ok: true }

    const requiredRoles = [...new Set(requirements.map(r => r.role).filter(Boolean))]
    if (requiredRoles.length === 0) return { ok: true }

    const allStaff = await _getStaffForGroup(groupId)
    const volunteerStaff = allStaff.find(s => s.name?.toLowerCase() === volunteerName.toLowerCase())
    if (!volunteerStaff) return { ok: true }  // unknown volunteer, let it through

    // Check manager pre-approval
    const preApproved = openRequest.manager_approved_volunteers
    if (Array.isArray(preApproved) && preApproved.includes(volunteerName)) return { ok: true }

    // Null role — not qualified
    if (volunteerStaff.role == null) {
      return { ok: false, reason: 'no_role', requiredRoles }
    }

    // Check primary role match
    if (requiredRoles.includes(volunteerStaff.role)) return { ok: true }

    // Check cross-training (stored as array of role strings on staff, or via crossTraining table)
    const crossTraining = volunteerStaff.cross_training ?? []
    const hasCrossTraining = crossTraining.some(ct => requiredRoles.includes(ct))
    if (hasCrossTraining) return { ok: true }

    return { ok: false, reason: 'role_mismatch', volunteerRole: volunteerStaff.role, requiredRoles }
  } catch (err) {
    logger.error(`checkVolunteerRole failed: ${err.message}`)
    return { ok: true }  // fail-open: don't block coverage on role-check errors
  }
}

export async function handleCoverageConfirmation(bot, msg, intent, db = null) {
  const _getOpenRequest = db?.getOpenRequest ?? getOpenRequest
  const _markCovered = db?.markCovered ?? markCovered
  const _recordEvent = db?.recordEvent ?? liveRecordEvent
  const _getManagerDmChatId = db?.getManagerDmChatId ?? null

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

  // ── E2: role validation ──────────────────────────────────────────────────
  const roleCheck = await checkVolunteerRole(openRequest, volunteer, groupId, db)
  if (!roleCheck.ok) {
    const managerChatId = _getManagerDmChatId
      ? await _getManagerDmChatId(groupId)
      : null

    if (roleCheck.reason === 'no_role') {
      await bot.sendMessage(
        msg.from?.id ?? msg.chat.id,
        `You don't have a role set yet — ask Tony to set your role first.`
      )
      if (managerChatId) {
        await bot.sendMessage(
          managerChatId,
          `${volunteer} offered to cover but has no role set. Please approve manually or set their role first.`
        )
      }
    } else {
      const needed = roleCheck.requiredRoles.join(', ')
      await bot.sendMessage(
        msg.from?.id ?? msg.chat.id,
        `You're a ${roleCheck.volunteerRole} but this shift needs ${needed} — manager approval needed.`
      )
      if (managerChatId) {
        await bot.sendMessage(
          managerChatId,
          `${volunteer} (${roleCheck.volunteerRole}) offered to cover a ${needed} shift. Approve manually if OK.`
        )
      }
    }
    return
  }

  // ── G.05: OT warning — check if volunteer would exceed 40h this week ────
  try {
    const _getPayrollForWeek = db?.getPayrollForWeek ?? null
    const _getTimeEntriesForWeek = db?.getTimeEntriesForWeek ?? null
    const weekStart = openRequest.week_start ?? null
    const managerChatId = _getManagerDmChatId ? await _getManagerDmChatId(groupId) : null

    if (managerChatId && weekStart) {
      let currentHours = 0

      // Try payroll records first (most accurate)
      if (_getPayrollForWeek) {
        const payrollRows = await _getPayrollForWeek(groupId, weekStart)
        const allStaff = await (db?.getStaffForGroup ?? getStaffForGroup)(groupId)
        const volunteerStaff = allStaff.find(s => s.name?.toLowerCase() === volunteer.toLowerCase())
        if (volunteerStaff) {
          const row = payrollRows.find(r => r.staff_id === volunteerStaff.id)
          currentHours = Number(row?.total_hours ?? row?.hours ?? 0)
        }
      } else if (_getTimeEntriesForWeek) {
        // Fall back to time entries
        const entries = await _getTimeEntriesForWeek(groupId, weekStart)
        const allStaff = await (db?.getStaffForGroup ?? getStaffForGroup)(groupId)
        const volunteerStaff = allStaff.find(s => s.name?.toLowerCase() === volunteer.toLowerCase())
        if (volunteerStaff) {
          const staffEntries = entries.filter(e => e.staff_id === volunteerStaff.id && e.clock_out)
          for (const e of staffEntries) {
            const ms = new Date(e.clock_out).getTime() - new Date(e.clock_in).getTime()
            currentHours += ms / 3600000
          }
          currentHours = Math.round(currentHours * 10) / 10
        }
      }

      const SHIFT_ESTIMATE = 6 // hours — conservative estimate when shift info unavailable
      if (currentHours + SHIFT_ESTIMATE > 40) {
        await bot.sendMessage(
          managerChatId,
          `⚠️ Heads up: ${volunteer} volunteering for coverage may push them over 40h this week (${currentHours}h + ~${SHIFT_ESTIMATE}h = OT). Coverage has been accepted, but please verify payroll.`
        )
      }
    }
  } catch (err) {
    logger.error(`G.05 OT check failed: ${err.message}`)
  }

  const marked = await _markCovered(openRequest.id, volunteer)
  if (!marked) {
    // Lost the race — send a DM only to the volunteer; never post to the group.
    const loserDmId = msg.from?.id ?? msg.chat.id
    await bot.sendMessage(loserDmId, 'Thanks for offering — that shift was just covered by someone else 🙏')
    return
  }

  // Atomic with markCovered: if the schedule swap fails, undo the coverage row
  // so we never end up "covered in DB but original requester still on the schedule".
  const swap = await swapIfPossible(openRequest, volunteer, groupId)
  if (!swap.ok) {
    await revertCovered(openRequest.id, volunteer)
    await bot.sendMessage(
      msg.chat.id,
      `⚠️ Couldn't update the schedule for that coverage — the request is still open. Please try again or ask a manager to swap manually.`
    )
    return
  }

  // Record reliability event — fire-and-forget, never crashes handler.
  // Moved AFTER swap so we don't credit a volunteer for a coverage that was reverted.
  if (msg.from?.id) {
    _recordEvent(msg.from.id, groupId, 'covered_someone').catch(err =>
      logger.error(`recordEvent covered_someone failed: ${err.message}`)
    )
  }

  // Track morale event — fire-and-forget
  try {
    const allStaff = await getStaffForGroup(groupId)
    const staff = allStaff.find(s => s.name?.toLowerCase() === volunteer.toLowerCase())
    if (staff) {
      const sentiment = classifySentiment(msg.text || '')
      const responseMinutes = openRequest.created_at
        ? Math.round((Date.now() - new Date(openRequest.created_at).getTime()) / 60000)
        : null
      saveMoraleEvent(groupId, staff.id, {
        type: 'coverage_accept', responseMinutes, sentiment, weekStart: openRequest.week_start,
      }).catch(() => {})
    }
  } catch (_) {}

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
    await bot.sendMessage(msg.chat.id, 'That shift was already covered by someone else — thanks for offering! 🙏')
    return
  }

  const swap = await swapIfPossible(openRequest, volunteer, request.group_id)
  if (!swap.ok) {
    await revertCovered(openRequest.id, volunteer)
    await bot.sendMessage(
      msg.chat.id,
      `⚠️ Couldn't update the schedule for that coverage — the request is still open. Please try again.`
    )
    return
  }

  // Track morale event — fire-and-forget
  try {
    const allStaff = await getStaffForGroup(request.group_id)
    const staff = allStaff.find(s => s.name?.toLowerCase() === volunteer.toLowerCase())
    if (staff) {
      const sentiment = classifySentiment(msg.text || '')
      const responseMinutes = openRequest.created_at
        ? Math.round((Date.now() - new Date(openRequest.created_at).getTime()) / 60000)
        : null
      saveMoraleEvent(request.group_id, staff.id, {
        type: 'coverage_accept', responseMinutes, sentiment, weekStart: openRequest.week_start,
      }).catch(() => {})
    }
  } catch (_) {}

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
