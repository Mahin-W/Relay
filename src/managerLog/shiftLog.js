import { getManagerGroup } from '../setup/setupDb.js'
import { saveLogEntry } from './shiftLogDb.js'
import { logger } from '../logger.js'

/**
 * Returns the Monday of the current week as 'YYYY-MM-DD'.
 */
function getCurrentWeekStart() {
  const now = new Date()
  const day = now.getUTCDay() // 0 = Sunday
  const diff = day === 0 ? -6 : 1 - day // shift so Monday = 0
  const monday = new Date(now)
  monday.setUTCDate(now.getUTCDate() + diff)
  return monday.toISOString().slice(0, 10)
}

/**
 * Handle an incoming DM and save it as a manager shift log entry.
 *
 * @param {object} bot - Telegram bot instance
 * @param {object} msg - Telegram message object
 * @param {object|null} db - Optional mock DB object for testing
 * @param {Function|null} _getManagerGroup - Injectable for testing; uses real import when null
 * @returns {boolean} true if handled, false if not applicable
 */
export async function handleManagerLogEntry(bot, msg, db = null, _getManagerGroup = null) {
  const text = msg.text?.trim() ?? ''
  if (text.length <= 10) return false

  const managerId = msg.from?.id
  const resolveManagerGroup = _getManagerGroup ?? getManagerGroup
  const managerGroup = await resolveManagerGroup(managerId)
  if (!managerGroup) return false

  const groupId = managerGroup.group_id
  const weekStart = getCurrentWeekStart()

  const saved = await saveLogEntry(groupId, managerId, text, weekStart, db)
  if (!saved) {
    logger.error(`shiftLog: saveLogEntry returned null for manager ${managerId}`)
  }

  await bot.sendMessage(msg.chat.id, '📝 Logged.')
  return true
}

/**
 * Format log entries for display (used by /viewlog).
 *
 * @param {Array} entries - Array of log entry rows
 * @param {string} weekStart - 'YYYY-MM-DD'
 * @returns {string}
 */
export function formatLogEntries(entries, weekStart) {
  if (!entries || entries.length === 0) {
    return `No log entries for week of ${weekStart}.`
  }
  const lines = entries.map((e, i) => `${i + 1}. ${e.entry_text}`)
  const count = entries.length
  return `📋 Shift Log — Week of ${weekStart}\n\n${lines.join('\n')}\n\n${count} ${count === 1 ? 'entry' : 'entries'}`
}
