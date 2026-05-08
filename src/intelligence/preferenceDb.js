import { getDb } from '../db.js'

export async function saveEditEvent(groupId, edit, db = null) {
  if (db?.saveEditEvent) return db.saveEditEvent(groupId, edit)
  const { data, error } = await getDb()
    .from('schedule_edit_events')
    .insert({
      group_id: groupId,
      type: edit.type,
      staff_id: edit.staffId,
      staff_name: edit.staffName,
      from_shift_id: edit.fromShiftId,
      to_shift_id: edit.toShiftId,
      day_of_week: edit.dayOfWeek,
      reason: edit.reason,
      week_start: edit.weekStart
    })
    .select()
    .single()
  if (error) throw error
  return data
}

export async function getEditHistory(groupId, weeksBack = 8, db = null) {
  if (db?.getEditHistory) return db.getEditHistory(groupId, weeksBack)
  const cutoff = new Date(Date.now() - weeksBack * 7 * 24 * 60 * 60 * 1000).toISOString()
  const { data, error } = await getDb()
    .from('schedule_edit_events')
    .select('*')
    .eq('group_id', groupId)
    .gte('created_at', cutoff)
    .order('created_at', { ascending: false })
  if (error) throw error
  return data
}

export async function savePreference(groupId, preference, db = null) {
  if (db?.savePreference) return db.savePreference(groupId, preference)
  const { data, error } = await getDb()
    .from('learned_preferences')
    .upsert({
      group_id: groupId,
      type: preference.type,
      staff_id: preference.staffId,
      staff_name: preference.staffName,
      day_of_week: preference.dayOfWeek,
      shift_id: preference.shiftId,
      confidence: preference.confidence,
      sample_size: preference.sampleSize,
      auto_apply: preference.autoApply
    }, { onConflict: 'group_id,type,staff_id,shift_id,day_of_week' })
    .select()
    .single()
  if (error) throw error
  return data
}

export async function getPreferences(groupId, db = null) {
  if (db?.getPreferences) return db.getPreferences(groupId)
  const { data, error } = await getDb()
    .from('learned_preferences')
    .select('*')
    .eq('group_id', groupId)
    .gte('confidence', 0.6)
    .order('confidence', { ascending: false })
  if (error) throw error
  return data
}
