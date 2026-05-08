import { getDb } from '../db.js'

export async function saveMoraleEvent(groupId, staffId, event, db = null) {
  if (db?.saveMoraleEvent) return db.saveMoraleEvent(groupId, staffId, event)
  const { data, error } = await getDb()
    .from('morale_events')
    .insert({
      group_id: groupId,
      staff_id: staffId,
      type: event.type,
      response_minutes: event.responseMinutes,
      sentiment: event.sentiment,
      week_start: event.weekStart,
    })
    .select()
    .single()
  if (error) throw error
  return data
}

export async function getMoraleEvents(groupId, staffId, weeksBack = 8, db = null) {
  if (db?.getMoraleEvents) return db.getMoraleEvents(groupId, staffId)
  const cutoff = new Date()
  cutoff.setDate(cutoff.getDate() - weeksBack * 7)
  const { data, error } = await getDb()
    .from('morale_events')
    .select('*')
    .eq('group_id', groupId)
    .eq('staff_id', staffId)
    .gte('created_at', cutoff.toISOString())
    .order('created_at', { ascending: false })
  if (error) throw error
  return data ?? []
}

export async function getMoraleSnapshot(groupId, db = null) {
  if (db?.getMoraleSnapshot) return db.getMoraleSnapshot(groupId)
  const cutoff = new Date()
  cutoff.setDate(cutoff.getDate() - 8 * 7)
  const { data, error } = await getDb()
    .from('morale_events')
    .select('*')
    .eq('group_id', groupId)
    .gte('created_at', cutoff.toISOString())
    .order('created_at', { ascending: false })
  if (error) throw error
  // Group by staff_id
  const grouped = {}
  for (const row of (data ?? [])) {
    if (!grouped[row.staff_id]) grouped[row.staff_id] = []
    grouped[row.staff_id].push(row)
  }
  return grouped
}
