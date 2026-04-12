import { createClient } from '@supabase/supabase-js'

function getDb(db) {
  if (db) return db
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY)
}

/**
 * Save an availability outcome record (INSERT only, never update).
 * All historical records are kept for trend analysis.
 */
export async function saveAvailabilityOutcome(groupId, staffId, weekStart, dayOfWeek, statedAvailable, actualOutcome, db = null) {
  const client = getDb(db)
  const { data, error } = await client
    .from('availability_outcomes')
    .insert({
      group_id: groupId,
      staff_id: staffId,
      week_start: weekStart,
      day_of_week: dayOfWeek,
      stated_available: statedAvailable,
      actual_outcome: actualOutcome,
    })
  if (error) throw error
  return data
}

/**
 * Get availability history for a staff member, going back N weeks.
 * Returns [{weekStart, dayOfWeek, statedAvailable, actualOutcome, createdAt}]
 */
export async function getAvailabilityHistory(groupId, staffId, weeksBack = 8, db = null) {
  const client = getDb(db)
  const cutoff = new Date()
  cutoff.setDate(cutoff.getDate() - weeksBack * 7)
  const cutoffStr = cutoff.toISOString().split('T')[0]

  const { data, error } = await client
    .from('availability_outcomes')
    .select('*')
    .eq('group_id', groupId)
    .eq('staff_id', staffId)
    .gte('week_start', cutoffStr)
    .order('week_start', { ascending: false })

  if (error) throw error
  return (data || []).map((r) => ({
    weekStart: r.week_start,
    dayOfWeek: r.day_of_week,
    statedAvailable: r.stated_available,
    actualOutcome: r.actual_outcome,
    createdAt: r.created_at,
  }))
}
