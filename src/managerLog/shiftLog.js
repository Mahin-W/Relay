import { getManagerGroup } from '../setup/setupDb.js'
import { getShiftsForGroup } from '../setup/setupDb.js'
import { saveLogEntry, getLogEntries, searchLogEntries } from './shiftLogDb.js'
import { logger } from '../logger.js'

// ── Day / abbreviation maps ─────────────────────────────────────────────────

const DAY_NAMES = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']
const DAY_ABBREVS = { mon: 'Monday', tue: 'Tuesday', wed: 'Wednesday', thu: 'Thursday', fri: 'Friday', sat: 'Saturday', sun: 'Sunday' }
const MEAL_PERIODS = ['breakfast', 'brunch', 'lunch', 'dinner']
const TIME_INDICATORS = {
  'tonight': 'today',
  'this evening': 'today',
  'last night': 'yesterday',
  'this morning': 'today',
  'morning': null,
  'afternoon': null,
  'evening': null,
}

/**
 * Detect shift reference from free text. Pure function — no LLM.
 * @param {string} text
 * @param {Array} shifts - array of { name, day_of_week }
 * @returns {{ shiftName: string, dayOfWeek: string } | null}
 */
export function detectShiftReference(text, shifts) {
  if (!text || text.trim() === '') return null

  const lower = text.toLowerCase()

  // 1. Exact shift name match (highest priority)
  if (shifts && shifts.length > 0) {
    for (const shift of shifts) {
      if (lower.includes(shift.name.toLowerCase())) {
        return { shiftName: shift.name, dayOfWeek: shift.day_of_week }
      }
    }
  }

  // 2. Detect day name (full or abbreviated)
  let detectedDay = null
  for (const day of DAY_NAMES) {
    if (lower.includes(day.toLowerCase())) {
      detectedDay = day
      break
    }
  }
  if (!detectedDay) {
    for (const [abbrev, day] of Object.entries(DAY_ABBREVS)) {
      // Match abbreviation as a word boundary
      const re = new RegExp(`\\b${abbrev}\\b`, 'i')
      if (re.test(lower)) {
        detectedDay = day
        break
      }
    }
  }

  // 3. Detect meal period
  let detectedMeal = null
  for (const meal of MEAL_PERIODS) {
    if (lower.includes(meal)) {
      detectedMeal = meal.charAt(0).toUpperCase() + meal.slice(1)
      break
    }
  }

  // 4. Check time indicators
  let timeDay = null
  for (const [indicator, mappedDay] of Object.entries(TIME_INDICATORS)) {
    if (lower.includes(indicator)) {
      timeDay = mappedDay
      break
    }
  }

  // Combine results
  if (detectedDay && detectedMeal) {
    return { shiftName: `${detectedDay} ${detectedMeal}`, dayOfWeek: detectedDay }
  }
  if (detectedDay) {
    return { shiftName: null, dayOfWeek: detectedDay }
  }
  if (detectedMeal && timeDay) {
    return { shiftName: detectedMeal, dayOfWeek: timeDay }
  }
  if (detectedMeal) {
    return { shiftName: detectedMeal, dayOfWeek: null }
  }
  if (timeDay) {
    return { shiftName: null, dayOfWeek: timeDay }
  }

  return null
}

/**
 * Format a single log entry for display.
 * @param {{ entry_text, shift_name, day_of_week, created_at }} entry
 * @returns {string}
 */
export function formatLogEntry(entry) {
  const date = new Date(entry.created_at)
  const dayName = date.toLocaleDateString('en-US', { weekday: 'short', timeZone: 'UTC' })
  const monthDay = date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })
  const time = date.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'UTC' })

  let result = `${dayName}, ${monthDay} ${time}`
  if (entry.manager_id == null) {
    result += ` _(auto)_`
  }
  if (entry.shift_name) {
    result += `\n\u{1F4CB} ${entry.shift_name}`
  }
  result += `\n${entry.entry_text}`
  return result
}

/**
 * Format a collection of log entries as a logbook.
 * @param {Array} entries
 * @param {string} title
 * @returns {string}
 */
export function formatLogBook(entries, title = 'Recent log entries') {
  if (!entries || entries.length === 0) {
    return "No log entries yet. DM me notes after shifts and I'll keep a record."
  }

  // Group entries by week
  const weeks = new Map()
  for (const entry of entries) {
    const date = new Date(entry.created_at)
    // Get Monday of that week
    const day = date.getUTCDay()
    const diff = day === 0 ? -6 : 1 - day
    const monday = new Date(date)
    monday.setUTCDate(date.getUTCDate() + diff)
    const weekKey = monday.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })

    if (!weeks.has(weekKey)) weeks.set(weekKey, [])
    weeks.get(weekKey).push(entry)
  }

  let result = `\u{1F4D3} *${title}*\n`

  for (const [weekLabel, weekEntries] of weeks) {
    result += `\n*Week of ${weekLabel}:*\n`
    for (const entry of weekEntries) {
      const date = new Date(entry.created_at)
      const dayName = date.toLocaleDateString('en-US', { weekday: 'short', timeZone: 'UTC' })
      const time = date.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'UTC' })
      result += `\u2014 ${dayName} ${time}: ${entry.entry_text}\n`
    }
  }

  return result.trimEnd()
}

/**
 * Handle a manager DM as a shift log entry.
 * @param {object} bot
 * @param {object} msg
 * @param {object|null} db
 */
export async function handleLogEntry(bot, msg, db = null) {
  const userId = msg.from?.id
  const text = msg.text?.trim() ?? ''

  if (text.length <= 10) return false

  const _getManagerGroup = db?.getManagerGroup ?? getManagerGroup
  const _getShiftsForGroup = db?.getShiftsForGroup ?? getShiftsForGroup

  const managerGroup = await _getManagerGroup(userId)
  if (!managerGroup) return false

  const groupId = managerGroup.group_id
  const shifts = await _getShiftsForGroup(groupId).catch(() => [])
  const shiftRef = detectShiftReference(text, shifts)

  await saveLogEntry(groupId, userId, text, shiftRef, db)

  let reply = '\u{1F4DD} Logged'
  if (shiftRef) {
    const refLabel = [shiftRef.shiftName, shiftRef.dayOfWeek].filter(Boolean).join(' — ')
    reply += `\nLinked to ${refLabel}`
  }

  await bot.sendMessage(msg.chat.id, reply)
  return true
}

/**
 * Handle /log command.
 * @param {object} bot
 * @param {object} msg
 * @param {string} args - everything after /log
 * @param {object|null} db
 */
export async function handleLogCommand(bot, msg, args, db = null) {
  const userId = msg.from?.id
  const isGroup = ['group', 'supergroup'].includes(msg.chat?.type)

  const _getManagerGroup = db?.getManagerGroup ?? getManagerGroup

  const managerGroup = await _getManagerGroup(userId)
  if (!managerGroup) return

  const groupId = managerGroup.group_id
  const dmChatId = managerGroup.dm_chat_id || String(msg.chat.id)

  let entries
  let title
  if (args && args.trim()) {
    entries = await searchLogEntries(groupId, args.trim(), db)
    title = `Search results: "${args.trim()}"`
  } else {
    entries = await getLogEntries(groupId, 14, db)
    title = 'Recent log entries'
  }

  const formatted = formatLogBook(entries, title)
  await bot.sendMessage(dmChatId, formatted)

  if (isGroup) {
    await bot.sendMessage(String(msg.chat.id), '\u{1F4D3} Log sent to your DM')
  }
}

// ── Auto-generated shift log ────────────────────────────────────────────────

/**
 * Build a narrative string from shift data. Pure function — no DB/LLM.
 * @param {object} shiftData
 * @returns {string}
 */
export function buildShiftNarrative(shiftData) {
  const {
    shiftName, dayOfWeek, date,
    callouts, coverageEvents, lateArrivals, noShows, fullyCovered,
  } = shiftData

  let lines = [`*${shiftName}* \u2014 ${dayOfWeek} ${date}`]

  const hasEvents = (callouts?.length > 0) || (coverageEvents?.length > 0) ||
    (lateArrivals?.length > 0) || (noShows?.length > 0)

  if (!hasEvents) {
    lines.push('\u2705 Clean shift. No issues.')
    return lines.join('\n')
  }

  // Collect all events with timestamps for chronological sorting
  const events = []

  for (const c of (callouts ?? [])) {
    events.push({
      time: c.reportedAt ?? null,
      text: `${c.staffName} called out ${c.minutesBefore}min before shift.`,
    })
  }

  for (const cov of (coverageEvents ?? [])) {
    if (cov.wasPartial) {
      events.push({
        time: cov.confirmedAt ?? cov.requestedAt ?? null,
        text: `${cov.coveredBy} covered ${cov.partialFrom}\u2013${cov.partialTo} (${cov.fillMinutes}min to confirm).`,
      })
    } else {
      events.push({
        time: cov.confirmedAt ?? cov.requestedAt ?? null,
        text: `${cov.coveredBy} covered (${cov.fillMinutes}min to confirm).`,
      })
    }
  }

  for (const la of (lateArrivals ?? [])) {
    events.push({
      time: null,
      text: `${la.staffName} arrived ${la.minutesLate}min late.`,
    })
  }

  for (const ns of (noShows ?? [])) {
    events.push({
      time: null,
      text: `\u26A0\uFE0F ${ns.staffName} no-showed.`,
    })
  }

  // Sort chronologically; null-timed events last
  events.sort((a, b) => {
    if (a.time && b.time) return new Date(a.time) - new Date(b.time)
    if (a.time && !b.time) return -1
    if (!a.time && b.time) return 1
    return 0
  })

  for (const ev of events) {
    lines.push(ev.text)
  }

  // Coverage summary
  if (callouts?.length > 0 || noShows?.length > 0) {
    if (fullyCovered) {
      lines.push('Full coverage achieved.')
    } else {
      lines.push('\u26A0\uFE0F Shift ran understaffed.')
    }
  }

  return lines.join('\n')
}

/**
 * Compile shift data from DB for narrative generation.
 * @param {string} groupId
 * @param {string} shiftId
 * @param {string} shiftDate
 * @param {string} shiftName
 * @param {string} dayOfWeek
 * @param {object|null} db
 * @returns {object} shiftData suitable for buildShiftNarrative
 */
export async function compileShiftData(groupId, shiftId, shiftDate, shiftName, dayOfWeek, db = null) {
  const _getAssignments = db?.getScheduleAssignments
  const _getCoverageRequests = db?.getCoverageRequestsForShift
  const _getReliabilityEvents = db?.getReliabilityEventsForDate
  const _getNoShows = db?.getNoShowEventsForShift

  const [assignments, coverageReqs, reliabilityEvents, noShowEvents] = await Promise.all([
    _getAssignments ? _getAssignments(groupId, shiftId, shiftDate) : [],
    _getCoverageRequests ? _getCoverageRequests(groupId, shiftId, shiftDate) : [],
    _getReliabilityEvents ? _getReliabilityEvents(groupId, shiftDate) : [],
    _getNoShows ? _getNoShows(groupId, shiftId, shiftDate) : [],
  ])

  const staffScheduled = (assignments ?? []).map(a => ({
    staffId: a.staff_id,
    staffName: a.staff_name,
  }))

  // Extract callouts from coverage requests (anyone who requested coverage = called out)
  const callouts = (coverageReqs ?? [])
    .filter(r => r.requested_by)
    .map(r => ({
      staffName: r.requested_by,
      reportedAt: r.created_at,
      minutesBefore: null, // Could be computed if shift start time known
    }))

  const coverageEvents = (coverageReqs ?? [])
    .filter(r => r.covered_by && r.status === 'covered')
    .map(r => {
      const fillMinutes = (r.covered_at && r.created_at)
        ? Math.round((new Date(r.covered_at) - new Date(r.created_at)) / 60000)
        : null
      return {
        requestedBy: r.requested_by,
        coveredBy: r.covered_by,
        requestedAt: r.created_at,
        confirmedAt: r.covered_at,
        fillMinutes,
        wasPartial: false,
      }
    })

  const lateArrivals = (reliabilityEvents ?? [])
    .filter(e => e.event_type === 'late_arrival')
    .map(e => ({
      staffName: e.metadata?.staff_name ?? 'Unknown',
      minutesLate: e.metadata?.minutes_late ?? 0,
    }))

  const noShows = (noShowEvents ?? []).map(e => ({
    staffName: e.staff_name,
  }))

  const hasCoverageGaps = coverageReqs?.some(r => r.status === 'open') ?? false
  const fullyCovered = noShows.length === 0 && !hasCoverageGaps

  return {
    shiftName,
    dayOfWeek,
    date: shiftDate,
    staffScheduled,
    callouts,
    coverageEvents,
    lateArrivals,
    noShows,
    fullyCovered,
  }
}

/**
 * Auto-log a shift's events. Silent background operation.
 * @param {object} bot
 * @param {string} groupId
 * @param {string} shiftId
 * @param {string} shiftDate
 * @param {string} shiftName
 * @param {string} dayOfWeek
 * @param {object|null} db
 */
export async function autoLogShift(bot, groupId, shiftId, shiftDate, shiftName, dayOfWeek, db = null) {
  // Check for duplicate
  const _getLogEntryForShiftDate = db?.getLogEntryForShiftDate
  if (_getLogEntryForShiftDate) {
    const existing = await _getLogEntryForShiftDate(groupId, shiftName, shiftDate)
    if (existing) return
  }

  const shiftData = await compileShiftData(groupId, shiftId, shiftDate, shiftName, dayOfWeek, db)
  const narrative = buildShiftNarrative(shiftData)

  // Compute weekStart (Monday of the week containing shiftDate)
  const d = new Date(shiftDate)
  const day = d.getUTCDay()
  const diff = day === 0 ? -6 : 1 - day
  const monday = new Date(d)
  monday.setUTCDate(d.getUTCDate() + diff)
  const weekStart = monday.toISOString().slice(0, 10)

  const shiftRef = { shiftName, dayOfWeek, weekStart }
  const _saveLogEntry = db?.saveLogEntry ?? saveLogEntry
  await _saveLogEntry(groupId, null, narrative, shiftRef)
  // Silent — no bot.sendMessage
}
