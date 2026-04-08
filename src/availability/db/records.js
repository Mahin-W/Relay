import { createClient } from '@supabase/supabase-js'
import { logger } from '../../logger.js'

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY)

export async function saveAvailability(userId, groupId, weekStart, availableShiftIds, availableAll, unavailable, rawResponse) {
  try {
    const { data, error } = await supabase
      .from('availability')
      .upsert(
        {
          user_id: userId,
          group_id: groupId,
          week_start: weekStart,
          available_shift_ids: availableShiftIds ?? [],
          available_all: availableAll ?? false,
          unavailable: unavailable ?? false,
          raw_response: rawResponse,
          collected_at: new Date().toISOString(),
        },
        { onConflict: 'user_id,week_start,group_id' }
      )
      .select()
      .single()
    if (error) throw error
    logger.db(`Saved availability for user ${userId} (week ${weekStart})`)
    return data
  } catch (err) {
    logger.error(`saveAvailability failed: ${err.message}`)
    return null
  }
}

export async function getAvailabilityForGroup(groupId, weekStart) {
  try {
    const { data, error } = await supabase
      .from('availability')
      .select('*')
      .eq('group_id', groupId)
      .eq('week_start', weekStart)
    if (error) throw error
    return data ?? []
  } catch (err) {
    logger.error(`getAvailabilityForGroup failed: ${err.message}`)
    return []
  }
}
