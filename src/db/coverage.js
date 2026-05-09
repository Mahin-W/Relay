import { getDb } from './client.js'
import { logger } from '../logger.js'

export async function saveRequest(groupId, groupName, shiftDescription, requestedBy, requesterTelegramId = null) {
  try {
    logger.db(`Saving coverage request for group ${groupId}: "${shiftDescription}"`)
    const { data, error } = await getDb()
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
    const { data, error } = await getDb()
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
    const { data, error } = await getDb()
      .from('coverage_requests')
      .update({ status: 'covered', covered_by: coveredBy, covered_at: new Date().toISOString() })
      .eq('id', requestId)
      .eq('status', 'open')   // only update if still open — atomic first-writer-wins
      .select()
      .single()

    if (error && error.code === 'PGRST116') {
      // PGRST116 = no rows matched — someone else already covered it
      logger.db(`Request id=${requestId} already covered by someone else`)
      return null
    }
    if (error) throw error
    logger.db(`Request id=${requestId} marked covered by ${coveredBy}`)
    return data
  } catch (err) {
    logger.error(`markCovered failed: ${err.message}`)
    return null
  }
}

// Compensation for a failed schedule swap after markCovered succeeded.
// Reverts a coverage_requests row from 'covered' back to 'open' atomically,
// gated on the current covered_by matching what we set, so we never undo a
// later, successful claim by someone else.
export async function revertCovered(requestId, expectedCoveredBy) {
  try {
    const { data, error } = await getDb()
      .from('coverage_requests')
      .update({ status: 'open', covered_by: null, covered_at: null })
      .eq('id', requestId)
      .eq('status', 'covered')
      .eq('covered_by', expectedCoveredBy)
      .select()
      .single()
    if (error && error.code === 'PGRST116') {
      logger.db(`revertCovered no-op for id=${requestId} (state changed)`)
      return null
    }
    if (error) throw error
    logger.db(`Reverted request id=${requestId} (was covered by ${expectedCoveredBy})`)
    return data
  } catch (err) {
    logger.error(`revertCovered failed: ${err.message}`)
    return null
  }
}

// Find the most recent open OR covered request for cancellation purposes.
// If requesterName is provided, restricts to requests opened by that person.
export async function getActiveRequest(groupId, requesterName = null) {
  try {
    const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
    let query = getDb()
      .from('coverage_requests')
      .select('*')
      .eq('group_id', groupId)
      .in('status', ['open', 'covered'])
      .gte('created_at', cutoff)
      .order('created_at', { ascending: false })
      .limit(1)
    if (requesterName) query = query.ilike('requested_by', requesterName)
    const { data, error } = await query.maybeSingle()
    if (error) throw error
    return data
  } catch (err) {
    logger.error(`getActiveRequest failed: ${err.message}`)
    return null
  }
}

// Cancel a coverage request by id regardless of current status (open or covered).
// Used by cancelHandler after it has performed any reverse-swap work.
export async function cancelRequestById(requestId) {
  try {
    const { data, error } = await getDb()
      .from('coverage_requests')
      .update({ status: 'cancelled' })
      .eq('id', requestId)
      .neq('status', 'cancelled')
      .select()
      .maybeSingle()
    if (error) throw error
    return !!data
  } catch (err) {
    logger.error(`cancelRequestById failed: ${err.message}`)
    return false
  }
}

// Get most recent request in this group (any status) within the last hour
export async function getMostRecentRequest(groupId) {
  try {
    const cutoff = new Date(Date.now() - 60 * 60 * 1000).toISOString()
    const { data, error } = await getDb()
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
    let query = getDb()
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
    const { data, error } = await getDb()
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
    const { data, error } = await getDb()
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
