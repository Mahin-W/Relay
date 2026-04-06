import { createClient } from '@supabase/supabase-js'
import { logger } from '../logger.js'

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY)

// ── Setup sessions ────────────────────────────────────────────────────────────

export async function getSetupSession(groupId) {
  try {
    const { data, error } = await supabase
      .from('setup_sessions')
      .select('*')
      .eq('group_id', groupId)
      .maybeSingle()
    if (error) throw error
    return data
  } catch (err) {
    logger.error(`getSetupSession failed: ${err.message}`)
    return null
  }
}

// Find an in-progress setup session by the manager's Telegram user ID
export async function getSetupSessionByManager(managerId) {
  try {
    const { data, error } = await supabase
      .from('setup_sessions')
      .select('*')
      .eq('manager_id', managerId)
      .eq('setup_complete', false)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle()
    if (error) throw error
    return data
  } catch (err) {
    logger.error(`getSetupSessionByManager failed: ${err.message}`)
    return null
  }
}

export async function createSetupSession(groupId, groupName, managerId, dmChatId) {
  try {
    const { data, error } = await supabase
      .from('setup_sessions')
      .upsert(
        {
          group_id: groupId,
          group_name: groupName,
          manager_id: managerId,
          dm_chat_id: dmChatId,
          step: 'welcome',
          setup_data: {},
          setup_complete: false,
          updated_at: new Date().toISOString(),
        },
        { onConflict: 'group_id' }
      )
      .select()
      .single()
    if (error) throw error
    return data
  } catch (err) {
    logger.error(`createSetupSession failed: ${err.message}`)
    return null
  }
}

export async function updateSetupSession(groupId, updates) {
  try {
    const { data, error } = await supabase
      .from('setup_sessions')
      .update({ ...updates, updated_at: new Date().toISOString() })
      .eq('group_id', groupId)
      .select()
      .single()
    if (error) throw error
    return data
  } catch (err) {
    logger.error(`updateSetupSession failed: ${err.message}`)
    return null
  }
}

// Returns the completed setup session for a manager (used to find their group)
export async function getManagerGroup(managerId) {
  try {
    const { data, error } = await supabase
      .from('setup_sessions')
      .select('group_id, dm_chat_id, setup_data, group_name, manager_id')
      .eq('manager_id', managerId)
      .eq('setup_complete', true)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle()
    if (error) throw error
    return data
  } catch (err) {
    logger.error(`getManagerGroup failed: ${err.message}`)
    return null
  }
}

export async function isSetupComplete(groupId) {
  try {
    const { data, error } = await supabase
      .from('setup_sessions')
      .select('setup_complete')
      .eq('group_id', groupId)
      .maybeSingle()
    if (error) throw error
    return data?.setup_complete === true
  } catch (err) {
    logger.error(`isSetupComplete failed: ${err.message}`)
    return false
  }
}

// ── Shifts ────────────────────────────────────────────────────────────────────

export async function saveShift(groupId, name, dayOfWeek, startTime, endTime) {
  try {
    const { data, error } = await supabase
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
    // shift_requirements cascade-delete via FK ON DELETE CASCADE
    const { error } = await supabase.from('shifts').delete().eq('group_id', groupId)
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
    // Get all shift IDs for this group, then delete their requirements
    const { data: shifts, error: sErr } = await supabase
      .from('shifts').select('id').eq('group_id', groupId)
    if (sErr) throw sErr
    if (!shifts || shifts.length === 0) return true
    const shiftIds = shifts.map(s => s.id)
    const { error } = await supabase
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
    const { data, error } = await supabase
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
    const { data, error } = await supabase
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

// ── Shift requirements ────────────────────────────────────────────────────────

export async function saveShiftRequirement(shiftId, role, count) {
  try {
    const { data, error } = await supabase
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
    const { data, error } = await supabase
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

// ── Staff ─────────────────────────────────────────────────────────────────────

export async function saveStaff(groupId, name, role) {
  try {
    const { data, error } = await supabase
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
    const { error } = await supabase
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
    const { data, error } = await supabase
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

// ── Schedule assignments ──────────────────────────────────────────────────────

export async function getScheduleAssignments(shiftId, weekStart) {
  try {
    // Two separate queries to avoid foreign key join issues
    const { data: assignments, error: aErr } = await supabase
      .from('schedule_assignments')
      .select('id, staff_id, status')
      .eq('shift_id', shiftId)
      .eq('week_start', weekStart)
    if (aErr) throw aErr
    if (!assignments || assignments.length === 0) return []

    const staffIds = assignments.map(a => a.staff_id)
    const { data: staffRows, error: sErr } = await supabase
      .from('staff')
      .select('id, name, role')
      .in('id', staffIds)
    if (sErr) throw sErr

    const staffMap = Object.fromEntries((staffRows ?? []).map(s => [s.id, s]))
    return assignments.map(a => ({
      id: a.id,
      staffName: staffMap[a.staff_id]?.name ?? 'Unknown',
      roleName: staffMap[a.staff_id]?.role ?? 'Staff',
      status: a.status,
    }))
  } catch (err) {
    logger.error(`getScheduleAssignments failed: ${err.message}`)
    return []
  }
}

export async function addScheduleAssignment(groupId, shiftId, staffId, weekStart) {
  try {
    const { data, error } = await supabase
      .from('schedule_assignments')
      .insert({ group_id: groupId, shift_id: shiftId, staff_id: staffId, week_start: weekStart })
      .select()
      .single()
    if (error) throw error
    return data
  } catch (err) {
    logger.error(`addScheduleAssignment failed: ${err.message}`)
    return null
  }
}

// Find a person's shift for a given day across any recent schedule (no week_start required).
// Returns { shift, weekStart } or null. Also returns { noShift: true } if the person exists
// but has no shift on that day — so callers can distinguish "not found" from "not scheduled".
export async function findPersonShiftForDay(groupId, staffName, dayOfWeek) {
  try {
    const { data: staffRows } = await supabase
      .from('staff').select('id').eq('group_id', groupId).ilike('name', staffName).limit(1)
    if (!staffRows?.length) return null
    const staffId = staffRows[0].id

    // Get all recent assignments for this person (last 60 days)
    const cutoff = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString().split('T')[0]
    const { data: assignments } = await supabase
      .from('schedule_assignments')
      .select('id, shift_id, week_start, status')
      .eq('staff_id', staffId)
      .gte('week_start', cutoff)
      .order('week_start', { ascending: false })
    if (!assignments?.length) return { noShift: true }

    const shiftIds = [...new Set(assignments.map(a => a.shift_id))]
    const { data: shifts } = await supabase
      .from('shifts').select('*').in('id', shiftIds).eq('day_of_week', dayOfWeek)

    if (!shifts?.length) return { noShift: true }

    // Pick the most recent assignment that matches the day
    const match = assignments.find(a => shifts.some(s => s.id === a.shift_id))
    const shift = shifts.find(s => s.id === match?.shift_id)
    return shift ? { shift: { ...shift, assignmentId: match.id, staffId }, weekStart: match.week_start } : { noShift: true }
  } catch (err) {
    logger.error(`findPersonShiftForDay failed: ${err.message}`)
    return null
  }
}

// Find a scheduled shift for a person (by name) on a given day this week
export async function getScheduledShiftForPerson(groupId, staffName, dayOfWeek, weekStart) {
  try {
    // Find staff record by name
    const { data: staffRows } = await supabase
      .from('staff').select('id').eq('group_id', groupId).ilike('name', staffName).limit(1)
    if (!staffRows?.length) return null
    const staffId = staffRows[0].id

    // Find their assignment for this day+week
    const { data: assignments } = await supabase
      .from('schedule_assignments')
      .select('id, shift_id, status')
      .eq('staff_id', staffId)
      .eq('week_start', weekStart)
    if (!assignments?.length) return null

    // Match by shift day_of_week
    const shiftIds = assignments.map(a => a.shift_id)
    const { data: shifts } = await supabase
      .from('shifts').select('*').in('id', shiftIds).eq('day_of_week', dayOfWeek)
    if (!shifts?.length) return null

    const matchedAssignment = assignments.find(a => shifts.some(s => s.id === a.shift_id))
    const matchedShift = shifts.find(s => s.id === matchedAssignment?.shift_id)
    return matchedShift ? { ...matchedShift, assignmentId: matchedAssignment.id, staffId } : null
  } catch (err) {
    logger.error(`getScheduledShiftForPerson failed: ${err.message}`)
    return null
  }
}

// Swap a schedule assignment from one staff member to another
export async function swapScheduleAssignment(groupId, shiftId, weekStart, fromStaffId, toStaffId) {
  try {
    // Update the existing assignment to the new staff member
    const { error } = await supabase
      .from('schedule_assignments')
      .update({ staff_id: toStaffId })
      .eq('group_id', groupId)
      .eq('shift_id', shiftId)
      .eq('week_start', weekStart)
      .eq('staff_id', fromStaffId)
    if (error) throw error
    logger.db(`Swapped assignment: staff ${fromStaffId} → ${toStaffId} on shift ${shiftId}`)
  } catch (err) {
    logger.error(`swapScheduleAssignment failed: ${err.message}`)
  }
}

export async function updateAssignmentStatus(assignmentId, status) {
  try {
    const { data, error } = await supabase
      .from('schedule_assignments')
      .update({ status })
      .eq('id', assignmentId)
      .select()
      .single()
    if (error) throw error
    return data
  } catch (err) {
    logger.error(`updateAssignmentStatus failed: ${err.message}`)
    return null
  }
}
