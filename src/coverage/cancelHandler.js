import { getActiveRequest, cancelRequestById } from '../db.js'
import { getManagerGroup, getStaffForGroup, swapScheduleAssignment } from '../setup/setupDb.js'
import { swapPublishedScheduleAssignment } from '../availability/availabilityDb.js'
import { logger } from '../logger.js'

// Reverse a previously-applied coverage swap, putting the original requester
// back on the shift and removing the volunteer. Mirrors swapIfPossible() in
// confirmationHandler.js.
async function revertSwap(request, groupId) {
  if (!request.matched_shift_id || !request.week_start) return { ok: true, volunteerStaff: null }
  try {
    const allStaff = await getStaffForGroup(groupId)
    const requesterStaff = allStaff.find(s => s.name?.toLowerCase() === request.requested_by?.toLowerCase())
    const volunteerStaff = request.covered_by
      ? allStaff.find(s => s.name?.toLowerCase() === request.covered_by.toLowerCase())
      : null
    if (!requesterStaff || !volunteerStaff) {
      return { ok: true, volunteerStaff: null }
    }
    await swapScheduleAssignment(groupId, request.matched_shift_id, request.week_start, volunteerStaff.id, requesterStaff.id)
    try {
      await swapPublishedScheduleAssignment(groupId, request.matched_shift_id, volunteerStaff.id, requesterStaff.name, requesterStaff.id)
    } catch (publishErr) {
      // Best-effort rollback of the assignments swap so the two tables don't drift.
      try {
        await swapScheduleAssignment(groupId, request.matched_shift_id, request.week_start, requesterStaff.id, volunteerStaff.id)
      } catch (rollbackErr) {
        logger.error(`cancel revertSwap rollback failed: ${rollbackErr.message}`)
      }
      throw publishErr
    }
    return { ok: true, volunteerStaff }
  } catch (err) {
    logger.error(`cancel revertSwap failed: ${err.message}`)
    return { ok: false, error: err.message, volunteerStaff: null }
  }
}

export async function handleCoverageCancel(bot, msg) {
  const groupId = String(msg.chat.id)
  const userId = msg.from?.id
  const senderName = msg.from?.first_name || 'Someone'

  const managerGroup = await getManagerGroup(userId)
  const isManager = managerGroup?.group_id === groupId

  // Find an active (open OR covered) request for this user — managers can cancel any.
  const request = isManager
    ? await getActiveRequest(groupId)
    : await getActiveRequest(groupId, senderName)

  if (!request) {
    await bot.sendMessage(msg.chat.id, isManager
      ? `No coverage request to cancel 👍`
      : `No coverage request from you to cancel 👍`
    )
    return
  }

  // If the request was already covered, undo the schedule swap and DM the volunteer
  // so they're not still expecting to work it.
  let revertedVolunteer = null
  if (request.status === 'covered') {
    const result = await revertSwap(request, groupId)
    if (!result.ok) {
      await bot.sendMessage(msg.chat.id,
        `⚠️ Couldn't roll back the schedule swap for that coverage — leaving the assignment as-is. Please fix manually.`)
      return
    }
    revertedVolunteer = result.volunteerStaff
  }

  const cancelled = await cancelRequestById(request.id)
  if (!cancelled) {
    await bot.sendMessage(msg.chat.id, `Couldn't cancel — try again 👍`)
    return
  }

  if (revertedVolunteer && revertedVolunteer.dm_chat_id) {
    await bot.sendMessage(
      String(revertedVolunteer.dm_chat_id),
      `Heads up — ${request.requested_by} just cancelled the coverage request you took on (${request.shift_description}). You're off the hook 🙏`
    ).catch(() => {})
  }

  await bot.sendMessage(msg.chat.id,
    request.status === 'covered' && revertedVolunteer
      ? `✅ Coverage cancelled — ${revertedVolunteer.name} was unassigned and notified.`
      : `✅ Coverage request cancelled.`)

  logger.bot(`Coverage request cancelled by ${isManager ? 'manager' : senderName} in ${msg.chat.title || groupId}` +
    (revertedVolunteer ? ` (volunteer ${revertedVolunteer.name} reverted)` : ''))
}
