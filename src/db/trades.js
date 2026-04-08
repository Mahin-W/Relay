import { createClient } from '@supabase/supabase-js'
import { logger } from '../logger.js'

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY)

export async function saveTradeRequest(groupId, groupName, requesterId, requesterName, shiftId, shiftDescription, weekStart) {
  try {
    const { data, error } = await supabase
      .from('trade_requests')
      .insert({ group_id: groupId, group_name: groupName, requester_id: requesterId, requester_name: requesterName, shift_id: shiftId, shift_description: shiftDescription, week_start: weekStart })
      .select()
      .single()
    if (error) throw error
    logger.db(`Saved trade request id=${data.id}`)
    return data
  } catch (err) {
    logger.error(`saveTradeRequest failed: ${err.message}`)
    return null
  }
}

export async function getOpenTradeRequest(groupId) {
  try {
    const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
    const { data, error } = await supabase
      .from('trade_requests')
      .select('*')
      .eq('group_id', groupId)
      .eq('status', 'open')
      .gte('created_at', cutoff)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle()
    if (error) throw error
    return data
  } catch (err) {
    logger.error(`getOpenTradeRequest failed: ${err.message}`)
    return null
  }
}

export async function markTradeCompleted(tradeId, acceptedById, acceptedByName, acceptedShiftId, acceptedShiftDescription) {
  try {
    const { error } = await supabase
      .from('trade_requests')
      .update({ status: 'completed', accepted_by_id: acceptedById, accepted_by_name: acceptedByName, accepted_shift_id: acceptedShiftId, accepted_shift_description: acceptedShiftDescription })
      .eq('id', tradeId)
    if (error) throw error
  } catch (err) {
    logger.error(`markTradeCompleted failed: ${err.message}`)
  }
}

export async function getGroupMemberName(userId, groupId) {
  try {
    const { data, error } = await supabase
      .from('group_members')
      .select('first_name')
      .eq('user_id', userId)
      .eq('group_id', groupId)
      .maybeSingle()
    if (error) throw error
    return data?.first_name || 'Manager'
  } catch (err) {
    logger.error(`getGroupMemberName failed: ${err.message}`)
    return 'Manager'
  }
}
