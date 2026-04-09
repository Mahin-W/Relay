import { createClient } from '@supabase/supabase-js'
import { logger } from '../logger.js'

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY)

export async function saveRequest(groupId, groupName, shiftDescription, requestedBy, requesterTelegramId = null) {
  try {
    logger.db(`Saving coverage request for group ${groupId}: "${shiftDescription}"`)
    const { data, error } = await supabase
      .from('coverage_requests')
      .insert({ group_id: groupId, group_name: groupName, shift_description: shiftDescription, requested_by: requestedBy, requester_telegram_id: requesterTelegramId })
      .select()
      .single()

    if (error) throw error
    logger.db(`Saved request id=${data.id}`)
    return data
  } catch (err) {
    logger.error(`saveRequest failed: ${err.message}`)
    return null
  }
}

export async function getOpenRequest(groupId) {
  try {
    logger.db(`Looking for open request in group ${groupId}`)
    const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
    const { data, error } = await supabase
      .from('coverage_requests')
      .select('*')
      .eq('group_id', groupId)
      .eq('status', 'open')
      .gte('created_at', cutoff)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle()

    if (error) throw error
    if (data) logger.db(`Found open request id=${data.id}: "${data.shift_description}"`)
    else logger.db('No open request found')
    return data
  } catch (err) {
    logger.error(`getOpenRequest failed: ${err.message}`)
    return null
  }
}

export async function markCovered(requestId, coveredBy) {
  try {
    logger.db(`Marking request id=${requestId} as covered by ${coveredBy}`)
    const { data, error } = await supabase
      .from('coverage_requests')
      .update({ status: 'covered', covered_by: coveredBy, covered_at: new Date().toISOString() })
      .eq('id', requestId)
      .select()
      .single()

    if (error) throw error
    logger.db(`Request id=${requestId} marked covered`)
    return data
  } catch (err) {
    logger.error(`markCovered failed: ${err.message}`)
    return null
  }
}

// Get most recent request in this group (any status) within the last hour
export async function getMostRecentRequest(groupId) {
  try {
    const cutoff = new Date(Date.now() - 60 * 60 * 1000).toISOString()
    const { data, error } = await supabase
      .from('coverage_requests')
      .select('*')
      .eq('group_id', groupId)
      .gte('created_at', cutoff)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle()
    if (error) throw error
    return data
  } catch (err) {
    logger.error(`getMostRecentRequest failed: ${err.message}`)
    return null
  }
}

// If requesterName provided, only cancels that person's request. Null = cancel any (manager).
export async function cancelRequest(groupId, requesterName = null) {
  try {
    let query = supabase
      .from('coverage_requests')
      .update({ status: 'cancelled' })
      .eq('group_id', groupId)
      .eq('status', 'open')
    if (requesterName) query = query.ilike('requested_by', requesterName)
    const { data, error } = await query.select()
    if (error) throw error
    return data?.length > 0
  } catch (err) {
    logger.error(`cancelRequest failed: ${err.message}`)
    return false
  }
}

export async function getRecentRequests(groupId, limit = 5) {
  try {
    logger.db(`Fetching last ${limit} requests for group ${groupId}`)
    const { data, error } = await supabase
      .from('coverage_requests')
      .select('*')
      .eq('group_id', groupId)
      .order('created_at', { ascending: false })
      .limit(limit)

    if (error) throw error
    return data ?? []
  } catch (err) {
    logger.error(`getRecentRequests failed: ${err.message}`)
    return []
  }
}

export async function updateCoverageRequestShift(requestId, shiftId, weekStart) {
  try {
    const { data, error } = await supabase
      .from('coverage_requests')
      .update({ matched_shift_id: shiftId, week_start: weekStart })
      .eq('id', requestId)
      .select()
      .single()
    if (error) throw error
    return data
  } catch (err) {
    logger.error(`updateCoverageRequestShift failed: ${err.message}`)
    return null
  }
}
