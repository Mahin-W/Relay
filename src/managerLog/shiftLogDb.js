import { createClient } from '@supabase/supabase-js'
import { logger } from '../logger.js'

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY)

/**
 * Save a shift log entry for a manager.
 * @returns saved row or null on error
 */
export async function saveLogEntry(groupId, managerId, entryText, weekStart, db = null) {
  if (db?.saveLogEntry) return db.saveLogEntry(groupId, managerId, entryText, weekStart)
  try {
    const { data, error } = await supabase
      .from('manager_log_entries')
      .insert([{ group_id: groupId, manager_id: managerId, entry_text: entryText, week_start: weekStart }])
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
 * Get log entries for a group + week, sorted by created_at ASC.
 * @returns array of entries or [] on error
 */
export async function getLogEntries(groupId, weekStart, db = null) {
  if (db?.getLogEntries) return db.getLogEntries(groupId, weekStart)
  try {
    const { data, error } = await supabase
      .from('manager_log_entries')
      .select('*')
      .eq('group_id', groupId)
      .eq('week_start', weekStart)
      .order('created_at', { ascending: true })
    if (error) { logger.error(`getLogEntries failed: ${error.message}`); return [] }
    return data ?? []
  } catch (err) {
    logger.error(`getLogEntries error: ${err.message}`)
    return []
  }
}
