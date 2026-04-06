import { createClient } from '@supabase/supabase-js'
import { logger } from './logger.js'

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
)

export async function saveRequest(groupId, groupName, shiftDescription, requestedBy) {
  try {
    logger.db(`Saving coverage request for group ${groupId}: "${shiftDescription}"`)
    const { data, error } = await supabase
      .from('coverage_requests')
      .insert({ group_id: groupId, group_name: groupName, shift_description: shiftDescription, requested_by: requestedBy })
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
    // Only consider requests created within the last 24 hours
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

// Get the most recent request in this group (any status) within the last hour
// Used to infer "that one" / "this shift" references
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

// Register a staff member's DM chat when they send /start
export async function upsertStaffDm(userId, firstName, username, dmChatId) {
  try {
    logger.db(`Registering DM for user ${userId} (${firstName})`)
    const { data, error } = await supabase
      .from('staff_dms')
      .upsert({ user_id: userId, first_name: firstName, username: username ?? null, dm_chat_id: dmChatId })
      .select()
      .single()

    if (error) throw error
    logger.db(`Staff DM registered for ${firstName}`)
    return data
  } catch (err) {
    logger.error(`upsertStaffDm failed: ${err.message}`)
    return null
  }
}

// Track everyone who sends a message in a group
export async function upsertGroupMember(userId, groupId, firstName, username) {
  try {
    const { error } = await supabase
      .from('group_members')
      .upsert({ user_id: userId, group_id: groupId, first_name: firstName, username: username ?? null, last_seen: new Date().toISOString() })

    if (error) throw error
  } catch (err) {
    logger.error(`upsertGroupMember failed: ${err.message}`)
  }
}

// Get all registered staff (staff_dms) who are also seen in the group,
// falling back to all registered staff if group_members is empty.
export async function getGroupMembersWithDm(groupId) {
  try {
    logger.db(`Fetching registered staff for group ${groupId}`)

    // Get everyone seen in this group
    const { data: members, error: membersError } = await supabase
      .from('group_members')
      .select('user_id, first_name')
      .eq('group_id', groupId)

    if (membersError) throw membersError

    // Get all registered DMs
    const { data: dms, error: dmsError } = await supabase
      .from('staff_dms')
      .select('user_id, first_name, dm_chat_id')

    if (dmsError) throw dmsError
    if (!dms || dms.length === 0) {
      logger.db('No registered staff found in staff_dms')
      return []
    }

    const groupUserIds = new Set((members ?? []).map(m => m.user_id))

    // Use group members if we have them, otherwise fall back to all registered staff
    // (covers the case where someone registered via /start but hasn't spoken in the group yet)
    const result = groupUserIds.size > 0
      ? dms.filter(d => groupUserIds.has(d.user_id))
      : dms

    const staff = result.map(d => ({ userId: d.user_id, firstName: d.first_name, dmChatId: d.dm_chat_id }))
    logger.db(`Found ${staff.length} registered staff to DM`)
    return staff
  } catch (err) {
    logger.error(`getGroupMembersWithDm failed: ${err.message}`)
    return []
  }
}

// Record that a staff member was DM'd about a request
export async function saveOutreach(requestId, userId) {
  try {
    const { error } = await supabase
      .from('coverage_outreach')
      .insert({ request_id: requestId, user_id: userId })

    if (error) throw error
  } catch (err) {
    logger.error(`saveOutreach failed: ${err.message}`)
  }
}

// Link a coverage request to a matched shift
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

// Find the open coverage request a user was asked about (for DM replies)
export async function getOutreachByUser(userId) {
  try {
    logger.db(`Looking for pending outreach for user ${userId}`)
    const { data, error } = await supabase
      .from('coverage_outreach')
      .select('request_id, coverage_requests(id, group_id, group_name, shift_description, status)')
      .eq('user_id', userId)
      .eq('coverage_requests.status', 'open')
      .order('asked_at', { ascending: false })
      .limit(1)
      .maybeSingle()

    if (error) throw error
    if (!data?.coverage_requests) return null

    return data.coverage_requests
  } catch (err) {
    logger.error(`getOutreachByUser failed: ${err.message}`)
    return null
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
