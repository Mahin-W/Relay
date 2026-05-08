import { getDb } from '../db.js'
import { logger } from '../logger.js'

export async function saveTimeOffRequest(groupId, staffTelegramId, staffName, requestedDate, weekStart) {
  try {
    const { data, error } = await getDb()
      .from('time_off_requests')
      .insert({
        group_id: groupId,
        staff_telegram_id: staffTelegramId,
        staff_name: staffName,
        requested_date: requestedDate,
        week_start: weekStart ?? null,
        status: 'pending',
      })
      .select()
      .single()
    if (error) throw error
    logger.db(`Saved time-off request for ${staffName} on ${requestedDate}`)
    return data
  } catch (err) {
    logger.error(`saveTimeOffRequest failed: ${err.message}`)
    return null
  }
}

export async function getPendingTimeOffByName(groupId, staffName) {
  try {
    const { data, error } = await getDb()
      .from('time_off_requests')
      .select('*')
      .eq('group_id', groupId)
      .eq('status', 'pending')
      .ilike('staff_name', staffName)
      .order('requested_at', { ascending: false })
      .limit(1)
      .maybeSingle()
    if (error) throw error
    return data
  } catch (err) {
    logger.error(`getPendingTimeOffByName failed: ${err.message}`)
    return null
  }
}

export async function updateTimeOffStatus(requestId, status) {
  try {
    const { data, error } = await getDb()
      .from('time_off_requests')
      .update({ status })
      .eq('id', requestId)
      .select()
      .single()
    if (error) throw error
    return data
  } catch (err) {
    logger.error(`updateTimeOffStatus failed: ${err.message}`)
    return null
  }
}

export async function getStaffDmChatId(telegramUserId) {
  try {
    const { data, error } = await getDb()
      .from('staff_dms')
      .select('dm_chat_id, first_name')
      .eq('user_id', telegramUserId)
      .maybeSingle()
    if (error) throw error
    return data
  } catch (err) {
    logger.error(`getStaffDmChatId failed: ${err.message}`)
    return null
  }
}
