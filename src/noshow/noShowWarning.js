import cron from 'node-cron'
import { logger } from '../logger.js'
import { getUpcomingShifts, markWarned, wasWarned, getConfiguredGroups } from './noShowDb.js'
import { getSetupSession } from '../setup/setupDb.js'
import { recordEvent as liveRecordEvent } from '../reliability/reliabilityDb.js'

// ── Time parsing ──────────────────────────────────────────────────────────

function parseShiftTime(timeStr) {
  const s = String(timeStr).trim().toLowerCase()

  // "18:00" or "06:00" (24h)
  const h24 = s.match(/^(\d{1,2}):(\d{2})$/)
  if (h24) return { hours: parseInt(h24[1]), minutes: parseInt(h24[2]) }

  // "6:00am" or "6:00pm"
  const h12c = s.match(/^(\d{1,2}):(\d{2})(am|pm)$/)
  if (h12c) {
    let h = parseInt(h12c[1])
    const m = parseInt(h12c[2])
    if (h12c[3] === 'pm' && h !== 12) h += 12
    if (h12c[3] === 'am' && h === 12) h = 0
    return { hours: h, minutes: m }
  }

  // "6am" or "6pm"
  const h12 = s.match(/^(\d{1,2})(am|pm)$/)
  if (h12) {
    let h = parseInt(h12[1])
    if (h12[2] === 'pm' && h !== 12) h += 12
    if (h12[2] === 'am' && h === 12) h = 0
    return { hours: h, minutes: 0 }
  }

  return null
}

/**
 * Returns true if shift starts within [windowMinutes-5, windowMinutes+5] minutes.
 * Accepts optional `now` for testability.
 */
export function isShiftStartingSoon(shiftStartTime, windowMinutes = 30, now = new Date()) {
  const parsed = parseShiftTime(shiftStartTime)
  if (!parsed) return false

  const shiftTime = new Date(now)
  shiftTime.setHours(parsed.hours, parsed.minutes, 0, 0)

  const diffMin = (shiftTime.getTime() - now.getTime()) / 60000
  return diffMin >= windowMinutes - 5 && diffMin <= windowMinutes + 5
}

/**
 * Returns human-readable time until shift, e.g. "~30 minutes".
 * Accepts optional `now` for testability.
 */
export function formatTimeUntilShift(shiftStartTime, now = new Date()) {
  const parsed = parseShiftTime(shiftStartTime)
  if (!parsed) return 'soon'

  const shiftTime = new Date(now)
  shiftTime.setHours(parsed.hours, parsed.minutes, 0, 0)

  const diffMin = Math.round((shiftTime.getTime() - now.getTime()) / 60000)
  return `~${diffMin} minutes`
}

function buildWarningMessage(assignment) {
  const timeUntil = formatTimeUntilShift(assignment.start_time)
  return [
    '⚠️ *Heads up — shift starting soon*',
    `👤 ${assignment.staff_name} is scheduled for ${assignment.shift_name} in ${timeUntil}`,
    `📅 Starts at ${assignment.start_time}`,
    '',
    'No confirmation from them yet.',
    "Worth a quick check if you haven't heard from them.",
  ].join('\n')
}

// ── Main check (wired by cron) ────────────────────────────────────────────

export async function checkUpcomingShifts(bot, db = null) {
  const _getConfiguredGroups = db?.getConfiguredGroups ?? getConfiguredGroups
  const _getUpcomingShifts = db?.getUpcomingShifts ?? getUpcomingShifts
  const _wasWarned = db?.wasWarned ?? wasWarned
  const _markWarned = db?.markWarned ?? markWarned
  const _getSetupSession = db?.getSetupSession ?? getSetupSession
  const _recordEvent = db?.recordEvent ?? liveRecordEvent

  let checked = 0, warned = 0, skipped = 0

  const groups = await _getConfiguredGroups()
  for (const groupId of groups) {
    const assignments = await _getUpcomingShifts(groupId)
    const upcoming = assignments.filter(a => isShiftStartingSoon(a.start_time))

    for (const assignment of upcoming) {
      checked++
      if (await _wasWarned(assignment.id)) { skipped++; continue }

      const session = await _getSetupSession(groupId)
      if (!session?.dm_chat_id) { skipped++; continue }

      await bot.sendMessage(
        session.dm_chat_id,
        buildWarningMessage(assignment),
        { parse_mode: 'Markdown' }
      )
      await _markWarned(assignment.id, groupId)
      if (assignment.staff_id) {
        _recordEvent(assignment.staff_id, groupId, 'no_call_no_show').catch(err =>
          logger.error(`recordEvent no_call_no_show failed: ${err.message}`)
        )
      }
      warned++
    }
  }

  logger.info(`No-show check: checked=${checked} warned=${warned} skipped=${skipped}`)
  return { checked, warned, skipped }
}

export function startNoShowCron(bot) {
  cron.schedule('*/15 * * * *', async () => {
    try {
      const result = await checkUpcomingShifts(bot)
      logger.info(`No-show cron: ${JSON.stringify(result)}`)
    } catch (err) {
      logger.error(`No-show cron error: ${err.message}`)
    }
  })
  logger.info('No-show cron started (every 15 min)')
}
