import { getDb } from '../../db.js'
import { logger } from '../../logger.js'

export async function savePassiveAvailability(userId, groupId, weekStart, day, status, rawText = null) {
  try {
    const { data, error } = await getDb()
      .from('passive_availability')
      .upsert(
        {
          user_id: userId,
          group_id: groupId,
          week_start: weekStart,
          day_of_week: day,
          status,
          raw_text: rawText,
          updated_at: new Date().toISOString(),
        },
        { onConflict: 'user_id,group_id,week_start,day_of_week' }
      )
      .select()
      .single()
    if (error) throw error
    logger.db(`Saved passive availability: user ${userId}, ${day} → ${status}`)
    return data
  } catch (err) {
    logger.error(`savePassiveAvailability failed: ${err.message}`)
    return null
  }
}

export async function getPassiveAvailabilityForGroup(groupId, weekStart) {
  try {
    const { data, error } = await getDb()
      .from('passive_availability')
      .select('*')
      .eq('group_id', groupId)
      .eq('week_start', weekStart)
    if (error) throw error
    return data ?? []
  } catch (err) {
    logger.error(`getPassiveAvailabilityForGroup failed: ${err.message}`)
    return []
  }
}
