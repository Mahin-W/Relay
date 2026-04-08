import { createClient } from '@supabase/supabase-js'
import { logger } from '../../logger.js'

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY)

export async function createAvailabilitySession(userId, groupId, dmChatId, weekStart, shiftMap) {
  try {
    const { data, error } = await supabase
      .from('availability_sessions')
      .upsert(
        {
          user_id: userId,
          group_id: groupId,
          dm_chat_id: dmChatId,
          week_start: weekStart,
          shift_map: shiftMap ?? {},
          status: 'pending',
        },
        { onConflict: 'user_id,week_start,group_id' }
      )
      .select()
      .single()
    if (error) throw error
    return data
  } catch (err) {
    logger.error(`createAvailabilitySession failed: ${err.message}`)
    return null
  }
}

export async function getAvailabilitySessionByDm(dmChatId) {
  try {
    const today = new Date().toISOString().split('T')[0]
    const { data, error } = await supabase
      .from('availability_sessions')
      .select('*')
      .eq('dm_chat_id', dmChatId)
      .eq('status', 'pending')
      .gte('week_start', today)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle()
    if (error) throw error
    return data
  } catch (err) {
    logger.error(`getAvailabilitySessionByDm failed: ${err.message}`)
    return null
  }
}

export async function getAvailabilitySessionForUserWeek(userId, weekStart) {
  try {
    const { data, error } = await supabase
      .from('availability_sessions')
      .select('*')
      .eq('user_id', userId)
      .eq('week_start', weekStart)
      .maybeSingle()
    if (error) throw error
    return data
  } catch (err) {
    logger.error(`getAvailabilitySessionForUserWeek failed: ${err.message}`)
    return null
  }
}

export async function updateAvailabilitySessionStatus(userId, weekStart, status) {
  try {
    const { error } = await supabase
      .from('availability_sessions')
      .update({ status })
      .eq('user_id', userId)
      .eq('week_start', weekStart)
    if (error) throw error
  } catch (err) {
    logger.error(`updateAvailabilitySessionStatus failed: ${err.message}`)
  }
}

export async function getPendingSessionsForGroup(groupId, weekStart) {
  try {
    const { data, error } = await supabase
      .from('availability_sessions')
      .select('*')
      .eq('group_id', groupId)
      .eq('week_start', weekStart)
      .eq('status', 'pending')
    if (error) throw error
    return data ?? []
  } catch (err) {
    logger.error(`getPendingSessionsForGroup failed: ${err.message}`)
    return []
  }
}

export async function getAllSessionsForGroup(groupId, weekStart) {
  try {
    const { data, error } = await supabase
      .from('availability_sessions')
      .select('*')
      .eq('group_id', groupId)
      .eq('week_start', weekStart)
    if (error) throw error
    return data ?? []
  } catch (err) {
    logger.error(`getAllSessionsForGroup failed: ${err.message}`)
    return []
  }
}

export async function resetAvailabilityForGroup(groupId, weekStart) {
  try {
    await supabase.from('availability_sessions').delete().eq('group_id', groupId).eq('week_start', weekStart)
    await supabase.from('availability').delete().eq('group_id', groupId).eq('week_start', weekStart)
    logger.db(`Reset availability for group ${groupId} week ${weekStart}`)
  } catch (err) {
    logger.error(`resetAvailabilityForGroup failed: ${err.message}`)
  }
}
