import { getDb } from './client.js'
import { logger } from '../logger.js'

export async function upsertStaffDm(userId, firstName, username, dmChatId) {
  try {
    logger.db(`Registering DM for user ${userId} (${firstName})`)
    const { data, error } = await getDb()
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

export async function upsertGroupMember(userId, groupId, firstName, username) {
  try {
    const { error } = await getDb()
      .from('group_members')
      .upsert({ user_id: userId, group_id: groupId, first_name: firstName, username: username ?? null, last_seen: new Date().toISOString() })

    if (error) throw error
  } catch (err) {
    logger.error(`upsertGroupMember failed: ${err.message}`)
  }
}

export async function getGroupMembersWithDm(groupId) {
  try {
    logger.db(`Fetching registered staff for group ${groupId}`)

    const { data: members, error: membersError } = await getDb()
      .from('group_members')
      .select('user_id, first_name')
      .eq('group_id', groupId)

    if (membersError) throw membersError

    const { data: dms, error: dmsError } = await getDb()
      .from('staff_dms')
      .select('user_id, first_name, dm_chat_id')

    if (dmsError) throw dmsError
    if (!dms || dms.length === 0) {
      logger.db('No registered staff found in staff_dms')
      return []
    }

    const groupUserIds = new Set((members ?? []).map(m => m.user_id))

    if (groupUserIds.size === 0) {
      logger.warn(`getGroupMembersWithDm: no registered members for group ${groupId} — returning empty list`)
      return []
    }
    const result = dms.filter(d => groupUserIds.has(d.user_id))

    const staff = result.map(d => ({ userId: d.user_id, firstName: d.first_name, dmChatId: d.dm_chat_id }))
    logger.db(`Found ${staff.length} registered staff to DM`)
    return staff
  } catch (err) {
    logger.error(`getGroupMembersWithDm failed: ${err.message}`)
    return []
  }
}

export async function saveOutreach(requestId, userId) {
  try {
    const { error } = await getDb()
      .from('coverage_outreach')
      .insert({ request_id: requestId, user_id: userId })

    if (error) throw error
  } catch (err) {
    logger.error(`saveOutreach failed: ${err.message}`)
  }
}

export async function getOutreachByUser(userId) {
  try {
    logger.db(`Looking for pending outreach for user ${userId}`)
    const { data, error } = await getDb()
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
