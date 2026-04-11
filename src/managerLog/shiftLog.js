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

  const _getManagerGroup = db?.getManagerGroup ?? getManagerGroup
  const _getShiftsForGroup = db?.getShiftsForGroup ?? getShiftsForGroup

  const managerGroup = await _getManagerGroup(userId)
  if (!managerGroup) return

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
