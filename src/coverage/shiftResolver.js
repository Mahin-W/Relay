import { getPublishedSchedule } from '../availability/availabilityDb.js'
import { isSetupComplete, getShiftsForGroup } from '../setup/setupDb.js'
import { matchShift, getCurrentWeekStart } from '../shiftMatcher.js'
import { getMostRecentRequest } from '../db.js'
import { getShiftById } from '../setup/setupDb.js'
import { logger } from '../logger.js'
import { setPendingClarification, extractDayFromText } from './pendingState.js'

// Resolves which shift is being referred to. Sends clarification if ambiguous.
// Returns { matchedShift, matchedWeekStart } or { matchedShift: null, matchedWeekStart: null }.
export async function resolveShift(bot, msg, groupId, shiftDesc, requesterName, intentType, intent) {
  const mentionedDay = extractDayFromText(shiftDesc) || extractDayFromText(msg.text)
  let matchedShift = null
  let matchedWeekStart = null

  try {
    const setupDone = await isSetupComplete(groupId)
    if (!setupDone) return { matchedShift: null, matchedWeekStart: null }

    if (mentionedDay) {
      const dayShifts = await getShiftsForGroup(groupId)
        .then(all => all.filter(s => s.day_of_week?.toLowerCase() === mentionedDay.toLowerCase()))
        .catch(() => [])

      if (dayShifts.length === 1) {
        matchedShift = { ...dayShifts[0], low_confidence: false }
        matchedWeekStart = getCurrentWeekStart()
        logger.bot(`Matched sole ${mentionedDay} shift: ${matchedShift.name}`)
      } else if (dayShifts.length > 1) {
        const schedule = await getPublishedSchedule(groupId).catch(() => null)
        const nameLower = requesterName.toLowerCase()
        const personal = schedule?.assignments
          ? dayShifts.filter(s =>
              schedule.assignments.some(a =>
                a.shiftId === s.id && a.staffName?.toLowerCase() === nameLower
              )
            )
          : []

        if (personal.length === 1) {
          matchedShift = { ...personal[0], low_confidence: false }
          matchedWeekStart = schedule.week_start
          logger.bot(`Narrowed to ${requesterName}'s ${mentionedDay} shift: ${matchedShift.name}`)
        } else {
          const options = dayShifts.map(s => `• *${s.name}* (${s.start_time}–${s.end_time})`).join('\n')
          await bot.sendMessage(
            msg.chat.id,
            `Which ${mentionedDay} shift, ${requesterName}?\n\n${options}\n\nReply with the shift name.`,
            { parse_mode: 'Markdown' }
          )
          setPendingClarification(groupId, msg.from?.id, {
            intentType,
            intent,
            dayShifts,
            matchedWeekStart: getCurrentWeekStart(),
          })
          return { matchedShift: null, matchedWeekStart: null }
        }
      }
    }

    if (!matchedShift) {
      matchedShift = await matchShift(groupId, shiftDesc, msg.text)
      matchedWeekStart = getCurrentWeekStart()
    }

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
  } catch (err) {
    logger.error(`resolveShift failed: ${err.message}`)
  }

  if (!matchedShift || matchedShift.low_confidence) {
    const shifts = await getShiftsForGroup(groupId).catch(() => [])
    let clarifyText = `🤔 I'm not sure which shift you mean, ${requesterName}. Which shift?`
    if (shifts.length > 0) {
      const shiftLines = shifts.map(s => `• *${s.name}* — ${s.day_of_week}, ${s.start_time}–${s.end_time}`).join('\n')
      clarifyText += `\n\n${shiftLines}\n\nReply like: _"cover my [shift name]"_`
    } else {
      clarifyText += ` Reply with the day and time (e.g. _"cover my Friday 5pm shift"_).`
    }
    await bot.sendMessage(msg.chat.id, clarifyText, { parse_mode: 'Markdown' })
    return { matchedShift: null, matchedWeekStart: null }
  }

  return { matchedShift, matchedWeekStart }
}
