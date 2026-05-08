import { getDb } from '../../db.js'
import { logger } from '../../logger.js'

export async function saveStaff(groupId, name, role) {
  try {
    const { data, error } = await getDb()
      .from('staff')
      .insert({ group_id: groupId, name, role: role ?? 'Staff' })
      .select()
      .single()
    if (error) throw error
    logger.db(`Saved staff: ${name} (${role})`)
    return data
  } catch (err) {
    logger.error(`saveStaff failed: ${err.message}`)
    return null
  }
}

export async function deleteStaffForGroup(groupId) {
  try {
    const { error } = await getDb()
      .from('staff')
      .delete()
      .eq('group_id', groupId)
    if (error) throw error
    logger.db(`Deleted all staff for group ${groupId}`)
    return true
  } catch (err) {
    logger.error(`deleteStaffForGroup failed: ${err.message}`)
    return false
  }
}

export async function getStaffForGroup(groupId) {
  try {
    const { data, error } = await getDb()
      .from('staff')
      .select('*')
      .eq('group_id', groupId)
      .order('created_at', { ascending: true })
    if (error) throw error
    return data ?? []
  } catch (err) {
    logger.error(`getStaffForGroup failed: ${err.message}`)
    return []
  }
}
