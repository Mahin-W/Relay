import { createClient } from '@supabase/supabase-js'
import { logger } from '../../logger.js'

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY)

export async function updateRoleRate(groupId, roleName, hourlyRate, db = null) {
  if (db?.updateRoleRate) return db.updateRoleRate(groupId, roleName, hourlyRate)
  try {
    const { data, error } = await supabase
      .from('role_rates')
      .upsert(
        { group_id: groupId, role_name: roleName, hourly_rate: hourlyRate },
        { onConflict: 'group_id,role_name' }
      )
      .select()
      .single()
    if (error) throw error
    logger.db(`Rate saved: ${roleName} → $${hourlyRate}/hr`)
    return data
  } catch (err) {
    logger.error(`updateRoleRate failed: ${err.message}`)
    return null
  }
}

export async function getRoleRate(groupId, roleName, db = null) {
  if (db?.getRoleRate) return db.getRoleRate(groupId, roleName)
  try {
    const { data, error } = await supabase
      .from('role_rates')
      .select('hourly_rate')
      .eq('group_id', groupId)
      .eq('role_name', roleName)
      .maybeSingle()
    if (error) throw error
    return data?.hourly_rate ?? 0
  } catch (err) {
    logger.error(`getRoleRate failed: ${err.message}`)
    return 0
  }
}

export async function getRatesForGroup(groupId, db = null) {
  if (db?.getRatesForGroup) {
    const rows = await db.getRatesForGroup(groupId)
    return rows.map(r => ({ roleName: r.role_name, hourlyRate: r.hourly_rate }))
  }
  try {
    const { data, error } = await supabase
      .from('role_rates')
      .select('role_name, hourly_rate')
      .eq('group_id', groupId)
      .order('role_name', { ascending: true })
    if (error) throw error
    return (data ?? []).map(r => ({ roleName: r.role_name, hourlyRate: r.hourly_rate }))
  } catch (err) {
    logger.error(`getRatesForGroup failed: ${err.message}`)
    return []
  }
}

export async function getUniqueRolesForGroup(groupId, db = null) {
  if (db?.getUniqueRolesForGroup) return db.getUniqueRolesForGroup(groupId)
  try {
    // Get all unique role names from shift_requirements for this group's shifts
    const { data: shifts, error: shiftErr } = await supabase
      .from('shifts')
      .select('id')
      .eq('group_id', groupId)
    if (shiftErr) throw shiftErr
    if (!shifts || shifts.length === 0) return []

    const shiftIds = shifts.map(s => s.id)
    const { data: reqs, error: reqErr } = await supabase
      .from('shift_requirements')
      .select('role')
      .in('shift_id', shiftIds)
    if (reqErr) throw reqErr

    const unique = [...new Set((reqs ?? []).map(r => r.role).filter(Boolean))]
    return unique.sort()
  } catch (err) {
    logger.error(`getUniqueRolesForGroup failed: ${err.message}`)
    return []
  }
}
