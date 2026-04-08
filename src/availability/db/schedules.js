import { createClient } from '@supabase/supabase-js'
import { logger } from '../../logger.js'

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY)

export async function saveGeneratedSchedule(groupId, weekStart, assignments, gaps) {
  try {
    await supabase
      .from('generated_schedules')
      .update({ status: 'rejected' })
      .eq('group_id', groupId)
      .eq('status', 'draft')

    const { data, error } = await supabase
      .from('generated_schedules')
      .insert({
        group_id: groupId,
        week_start: weekStart,
        status: 'draft',
        assignments,
        gaps,
      })
      .select()
      .single()
    if (error) throw error
    logger.db(`Saved schedule draft id=${data.id} for group ${groupId}`)
    return data
  } catch (err) {
    logger.error(`saveGeneratedSchedule failed: ${err.message}`)
    return null
  }
}

export async function getPublishedSchedule(groupId) {
  try {
    const { data, error } = await supabase
      .from('generated_schedules')
      .select('*')
      .eq('group_id', groupId)
      .eq('status', 'published')
      .order('published_at', { ascending: false })
      .limit(1)
      .maybeSingle()
    if (error) throw error
    return data
  } catch (err) {
    logger.error(`getPublishedSchedule failed: ${err.message}`)
    return null
  }
}

export async function getPendingSchedule(groupId) {
  try {
    const { data, error } = await supabase
      .from('generated_schedules')
      .select('*')
      .eq('group_id', groupId)
      .eq('status', 'draft')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle()
    if (error) throw error
    return data
  } catch (err) {
    logger.error(`getPendingSchedule failed: ${err.message}`)
    return null
  }
}

export async function swapPublishedScheduleAssignment(groupId, shiftId, fromStaffId, toStaffName, toStaffId) {
  try {
    const { data: schedule, error: fetchErr } = await supabase
      .from('generated_schedules')
      .select('id, assignments')
      .eq('group_id', groupId)
      .eq('status', 'published')
      .order('published_at', { ascending: false })
      .limit(1)
      .maybeSingle()
    if (fetchErr) throw fetchErr
    if (!schedule) return

    const updated = (schedule.assignments ?? []).map(a => {
      if (a.shiftId === shiftId && a.staffId === fromStaffId) {
        return { ...a, staffName: toStaffName, staffId: toStaffId }
      }
      return a
    })

    const { error } = await supabase
      .from('generated_schedules')
      .update({ assignments: updated })
      .eq('id', schedule.id)
    if (error) throw error
    logger.db(`Updated published schedule JSONB: staff ${fromStaffId} → ${toStaffName} on shift ${shiftId}`)
  } catch (err) {
    logger.error(`swapPublishedScheduleAssignment failed: ${err.message}`)
  }
}

export async function updateScheduleStatus(scheduleId, status) {
  try {
    const updates = { status }
    if (status === 'published') updates.published_at = new Date().toISOString()
    if (status === 'approved') updates.approved_at = new Date().toISOString()
    const { error } = await supabase
      .from('generated_schedules')
      .update(updates)
      .eq('id', scheduleId)
    if (error) throw error
  } catch (err) {
    logger.error(`updateScheduleStatus failed: ${err.message}`)
  }
}
