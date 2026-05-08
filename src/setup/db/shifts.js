import { getDb } from '../../db.js'
import { logger } from '../../logger.js'

export async function saveShift(groupId, name, dayOfWeek, startTime, endTime) {
  try {
    const { data, error } = await getDb()
      .from('shifts')
      .insert({ group_id: groupId, name, day_of_week: dayOfWeek, start_time: startTime, end_time: endTime })
      .select()
      .single()
    if (error) throw error
    logger.db(`Saved shift: ${name} (${dayOfWeek} ${startTime}–${endTime})`)
    return data
  } catch (err) {
    logger.error(`saveShift failed: ${err.message}`)
    return null
  }
}

export async function deleteShiftsForGroup(groupId) {
  try {
    const { error } = await getDb().from('shifts').delete().eq('group_id', groupId)
    if (error) throw error
    logger.db(`Deleted all shifts for group ${groupId}`)
    return true
  } catch (err) {
    logger.error(`deleteShiftsForGroup failed: ${err.message}`)
    return false
  }
}

export async function deleteShiftRequirementsForGroup(groupId) {
  try {
    const { data: shifts, error: sErr } = await getDb()
      .from('shifts').select('id').eq('group_id', groupId)
    if (sErr) throw sErr
    if (!shifts || shifts.length === 0) return true
    const shiftIds = shifts.map(s => s.id)
    const { error } = await getDb()
      .from('shift_requirements').delete().in('shift_id', shiftIds)
    if (error) throw error
    logger.db(`Deleted all shift requirements for group ${groupId}`)
    return true
  } catch (err) {
    logger.error(`deleteShiftRequirementsForGroup failed: ${err.message}`)
    return false
  }
}

export async function getShiftsForGroup(groupId) {
  try {
    const { data, error } = await getDb()
      .from('shifts')
      .select('*')
      .eq('group_id', groupId)
      .order('created_at', { ascending: true })
    if (error) throw error
    return data ?? []
  } catch (err) {
    logger.error(`getShiftsForGroup failed: ${err.message}`)
    return []
  }
}

export async function getShiftById(shiftId) {
  try {
    const { data, error } = await getDb()
      .from('shifts')
      .select('*')
      .eq('id', shiftId)
      .single()
    if (error) throw error
    return data
  } catch (err) {
    logger.error(`getShiftById failed: ${err.message}`)
    return null
  }
}

export async function saveShiftRequirement(shiftId, role, count) {
  try {
    const { data, error } = await getDb()
      .from('shift_requirements')
      .insert({ shift_id: shiftId, role, count })
      .select()
      .single()
    if (error) throw error
    return data
  } catch (err) {
    logger.error(`saveShiftRequirement failed: ${err.message}`)
    return null
  }
}

export async function getShiftRequirements(shiftId) {
  try {
    const { data, error } = await getDb()
      .from('shift_requirements')
      .select('role, count')
      .eq('shift_id', shiftId)
      .order('created_at', { ascending: true })
    if (error) throw error
    return data ?? []
  } catch (err) {
    logger.error(`getShiftRequirements failed: ${err.message}`)
    return []
  }
}
