import { createClient } from '@supabase/supabase-js'
import { logger } from '../logger.js'

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY)

export async function getRotationScores(groupId, shiftId, weeksBack = 4) {
  try {
    const cutoff = new Date()
    cutoff.setDate(cutoff.getDate() - weeksBack * 7)
    const cutoffStr = cutoff.toISOString().split('T')[0]

    const { data, error } = await supabase
      .from('schedule_assignments')
      .select('staff_id')
      .eq('group_id', groupId)
      .eq('shift_id', shiftId)
      .gte('week_start', cutoffStr)
    if (error) throw error

    const counts = {}
    for (const row of data ?? []) {
      counts[row.staff_id] = (counts[row.staff_id] ?? 0) + 1
    }
    const staffIds = Object.keys(counts).map(Number)
    if (!staffIds.length) return []

    const { data: staffRows, error: sErr } = await supabase
      .from('staff').select('id, name').in('id', staffIds)
    if (sErr) throw sErr

    const nameMap = Object.fromEntries((staffRows ?? []).map(s => [s.id, s.name]))
    return staffIds
      .map(id => ({ staffId: id, staffName: nameMap[id] ?? 'Unknown', recentCount: counts[id] }))
      .sort((a, b) => a.recentCount - b.recentCount)
  } catch (err) {
    logger.error(`getRotationScores failed: ${err.message}`)
    return []
  }
}

export async function getGroupShiftHistory(groupId, weeksBack = 4) {
  try {
    const cutoff = new Date()
    cutoff.setDate(cutoff.getDate() - weeksBack * 7)
    const cutoffStr = cutoff.toISOString().split('T')[0]

    const { data: assignments, error } = await supabase
      .from('schedule_assignments')
      .select('staff_id, shift_id, week_start')
      .eq('group_id', groupId)
      .gte('week_start', cutoffStr)
    if (error) throw error
    if (!assignments?.length) return []

    const shiftIds = [...new Set(assignments.map(a => a.shift_id))]
    const staffIds = [...new Set(assignments.map(a => a.staff_id))]

    const [{ data: shifts }, { data: staffRows }] = await Promise.all([
      supabase.from('shifts').select('id, name, day_of_week, end_time').in('id', shiftIds),
      supabase.from('staff').select('id, name').in('id', staffIds),
    ])

    const shiftMap = Object.fromEntries((shifts ?? []).map(s => [String(s.id), s]))
    const nameMap = Object.fromEntries((staffRows ?? []).map(s => [s.id, s.name]))

    return assignments.map(a => ({
      staffId: a.staff_id,
      staffName: nameMap[a.staff_id] ?? 'Unknown',
      shiftId: a.shift_id,
      shiftName: shiftMap[String(a.shift_id)]?.name ?? '',
      dayOfWeek: shiftMap[String(a.shift_id)]?.day_of_week ?? '',
      endTime: shiftMap[String(a.shift_id)]?.end_time ?? '',
      weekStart: a.week_start,
    }))
  } catch (err) {
    logger.error(`getGroupShiftHistory failed: ${err.message}`)
    return []
  }
}
