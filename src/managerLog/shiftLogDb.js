import { getDb } from '../db.js'
import { logger } from '../logger.js'

/**
 * Save a shift log entry.
 * @param {string} groupId
 * @param {number} managerId
 * @param {string} text
 * @param {object|null} shiftReference - { shiftName, dayOfWeek, weekStart }
 * @param {object|null} db - mock DB for testing
 * @returns saved record or null
 */
export async function saveLogEntry(groupId, managerId, text, shiftReference, db = null) {
  if (db?.saveLogEntry) return db.saveLogEntry(groupId, managerId, text, shiftReference)
  try {
    const { data, error } = await getDb()
      .from('manager_log_entries')
      .insert([{
        group_id: groupId,
        manager_id: managerId,
        entry_text: text,
        shift_name: shiftReference?.shiftName ?? null,
        day_of_week: shiftReference?.dayOfWeek ?? null,
        week_start: shiftReference?.weekStart ?? null,
      }])
      .select()
      .single()
    if (error) { logger.error(`saveLogEntry failed: ${error.message}`); return null }
    return data
  } catch (err) {
    logger.error(`saveLogEntry error: ${err.message}`)
    return null
  }
}

/**
 * Get recent log entries for a group.
 * @param {string} groupId
 * @param {number} limit - max entries to return
 * @param {object|null} db
 * @returns array of entries
 */
export async function getLogEntries(groupId, limit = 14, db = null) {
  if (db?.getLogEntries) return db.getLogEntries(groupId, limit)
  try {
    const { data, error } = await getDb()
      .from('manager_log_entries')
      .select('*')
      .eq('group_id', groupId)
      .order('created_at', { ascending: false })
      .limit(limit)
    if (error) { logger.error(`getLogEntries failed: ${error.message}`); return [] }
    return data ?? []
  } catch (err) {
    logger.error(`getLogEntries error: ${err.message}`)
    return []
  }
}

/**
 * Search log entries by text (ILIKE).
 * @param {string} groupId
 * @param {string} query
 * @param {object|null} db
 * @returns matching entries
 */
export async function searchLogEntries(groupId, query, db = null) {
  if (db?.searchLogEntries) return db.searchLogEntries(groupId, query)
  try {
    const { data, error } = await getDb()
      .from('manager_log_entries')
      .select('*')
      .eq('group_id', groupId)
      .ilike('entry_text', `%${query}%`)
      .order('created_at', { ascending: false })
      .limit(20)
    if (error) { logger.error(`searchLogEntries failed: ${error.message}`); return [] }
    return data ?? []
  } catch (err) {
    logger.error(`searchLogEntries error: ${err.message}`)
    return []
  }
}
