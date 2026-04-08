import { createClient } from '@supabase/supabase-js'
import { logger } from '../logger.js'

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY)

/**
 * Returns group_ids for all groups where setup is complete.
 */
export async function getConfiguredGroups() {
  try {
    const { data, error } = await supabase
      .from('setup_sessions')
      .select('group_id')
      .eq('setup_complete', true)
    if (error) throw error
    return (data ?? []).map(r => r.group_id)
  } catch (err) {
    logger.error(`getConfiguredGroups error: ${err.message}`)
    return []
  }
}

/**
 * Returns today's published schedule assignments for a group,
 * joined with shift name/start_time and staff name.
 * The caller filters by isShiftStartingSoon.
 */
export async function getUpcomingShifts(groupId) {
  try {
    // Get current week start (Monday)
    const now = new Date()
    const day = now.getDay()
    const diff = day === 0 ? -6 : 1 - day
    const monday = new Date(now)
    monday.setDate(now.getDate() + diff)
    const weekStart = monday.toISOString().split('T')[0]

    // Check if schedule is published
    const { data: schedule } = await supabase
      .from('schedules')
      .select('id')
      .eq('group_id', groupId)
      .eq('week_start', weekStart)
      .eq('status', 'published')
      .maybeSingle()
    if (!schedule) return []

    const { data, error } = await supabase
      .from('schedule_assignments')
      .select(`
        id,
        group_id,
        staff_id,
        shift_id,
        week_start,
        staff:staff(name),
        shift:shifts(name, start_time)
      `)
      .eq('group_id', groupId)
      .eq('week_start', weekStart)
    if (error) throw error

    return (data ?? []).map(row => ({
      id: row.id,
      group_id: row.group_id,
      staff_id: row.staff_id,
      staff_name: row.staff?.name ?? 'Unknown',
      shift_name: row.shift?.name ?? 'Unknown',
      start_time: row.shift?.start_time ?? '',
    }))
  } catch (err) {
    logger.error(`getUpcomingShifts error: ${err.message}`)
    return []
  }
}

/**
 * Returns true if a warning was already sent for this assignment.
 */
export async function wasWarned(assignmentId) {
  try {
    const { data, error } = await supabase
      .from('noshow_warnings')
      .select('id')
      .eq('assignment_id', assignmentId)
      .maybeSingle()
    if (error) throw error
    return !!data
  } catch (err) {
    logger.error(`wasWarned error: ${err.message}`)
    return false
  }
}

/**
 * Records that a warning was sent for this assignment.
 */
export async function markWarned(assignmentId, groupId) {
  try {
    const { error } = await supabase
      .from('noshow_warnings')
      .upsert({ assignment_id: assignmentId, group_id: groupId }, { onConflict: 'assignment_id' })
    if (error) throw error
  } catch (err) {
    logger.error(`markWarned error: ${err.message}`)
  }
}
