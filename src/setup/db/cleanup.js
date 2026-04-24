import { createClient } from '@supabase/supabase-js'
import { logger } from '../../logger.js'

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY)

/**
 * Clear configuration data for a group before a fresh /setup run.
 * Deletes: schedule_assignments → availability → staff → shifts.
 * shift_requirements cascade-deletes with shifts (FK).
 * PRESERVES historical data: payroll_records, time_entries, coverage_requests,
 * trade_requests, manager_log_entries, staff_reliability_events, tip_records,
 * weekly_revenue, daily_revenue, and the setup_sessions row itself.
 */
export async function clearGroupSetupData(groupId, db = null) {
  if (db?.runCleanup) return db.runCleanup(groupId)
  try {
    await supabase.from('schedule_assignments').delete().eq('group_id', groupId)
    await supabase.from('availability').delete().eq('group_id', groupId)
    await supabase.from('staff').delete().eq('group_id', groupId)
    await supabase.from('shifts').delete().eq('group_id', groupId)
    logger.db(`Cleared setup data for group ${groupId} (assignments, availability, staff, shifts)`)
    return true
  } catch (err) {
    logger.error(`clearGroupSetupData failed: ${err.message}`)
    return false
  }
}
