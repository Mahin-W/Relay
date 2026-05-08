import { getDb } from '../db.js'
import { logger } from '../logger.js'

// Returns { id, name } if user is registered (has a DM with the bot), null otherwise.
export async function getStaffMember(userId) {
  try {
    const { data, error } = await getDb()
      .from('staff_dms')
      .select('user_id, first_name')
      .eq('user_id', userId)
      .maybeSingle()
    if (error) throw error
    if (!data) return null
    return { id: data.user_id, name: data.first_name }
  } catch (err) {
    logger.error(`getStaffMember failed: ${err.message}`)
    return null
  }
}

// Upsert an on-call record for a staff member.
export async function saveOnCall(staffId, groupId, weekStart, days = [], allWeek = true) {
  try {
    const { data, error } = await getDb()
      .from('on_call')
      .upsert(
        { staff_id: staffId, group_id: groupId, week_start: weekStart, days, all_week: allWeek },
        { onConflict: 'staff_id,week_start' }
      )
      .select()
      .maybeSingle()
    if (error) throw error
    return data
  } catch (err) {
    logger.error(`saveOnCall failed: ${err.message}`)
    return null
  }
}

// Returns array of on-call records for this group/week.
export async function getOnCallStaff(groupId, weekStart) {
  try {
    const { data, error } = await getDb()
      .from('on_call')
      .select('staff_id, all_week, days')
      .eq('group_id', groupId)
      .eq('week_start', weekStart)
    if (error) throw error
    return data ?? []
  } catch (err) {
    logger.error(`getOnCallStaff failed: ${err.message}`)
    return []
  }
}

export async function removeOnCall(staffId, groupId) {
  try {
    const { error } = await getDb()
      .from('on_call')
      .delete()
      .eq('staff_id', staffId)
      .eq('group_id', groupId)
    if (error) throw error
  } catch (err) {
    logger.error(`removeOnCall failed: ${err.message}`)
  }
}

export async function clearWeekOnCall(groupId, weekStart) {
  try {
    const { error } = await getDb()
      .from('on_call')
      .delete()
      .eq('group_id', groupId)
      .eq('week_start', weekStart)
    if (error) throw error
  } catch (err) {
    logger.error(`clearWeekOnCall failed: ${err.message}`)
  }
}
