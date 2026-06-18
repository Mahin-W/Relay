import { getDb } from '../../db.js'
import { logger } from '../../logger.js'

export async function getScheduleAssignments(shiftId, weekStart) {
  try {
    const { data: assignments, error: aErr } = await getDb()
      .from('schedule_assignments')
      .select('id, staff_id, status')
      .eq('shift_id', shiftId)
      .eq('week_start', weekStart)
    if (aErr) throw aErr
    if (!assignments || assignments.length === 0) return []

    const staffIds = assignments.map(a => a.staff_id)
    const { data: staffRows, error: sErr } = await getDb()
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

export async function clearScheduleAssignments(groupId, weekStart) {
  try {
    const { error } = await getDb()
      .from('schedule_assignments')
      .delete()
      .eq('group_id', groupId)
      .eq('week_start', weekStart)
    if (error) throw error
    logger.db(`Cleared schedule assignments for group ${groupId} week ${weekStart}`)
  } catch (err) {
    logger.error(`clearScheduleAssignments failed: ${err.message}`)
  }
}

/**
 * P1-7: Upsert the new assignment set FIRST (using the unique constraint from
 * migration 009: group_id, shift_id, staff_id, week_start) so there is no
 * window where zero rows exist. Accepts an optional `db` override for testing.
 *
 * @param {Array<{groupId, shiftId, staffId, weekStart}>} assignments
 * @param {object} [db] - optional Supabase client override (for testing)
 */
export async function upsertScheduleAssignments(assignments, db = null) {
  try {
    if (!assignments || assignments.length === 0) return
    const client = db ?? getDb()
    const rows = assignments.map(a => ({
      group_id: a.groupId,
      shift_id: a.shiftId,
      staff_id: a.staffId,
      week_start: a.weekStart,
      status: 'scheduled',
    }))
    const { error } = await client
      .from('schedule_assignments')
      .upsert(rows, { onConflict: 'group_id,shift_id,staff_id,week_start' })
    if (error) throw error
    logger.db(`Upserted ${rows.length} schedule assignments`)
  } catch (err) {
    logger.error(`upsertScheduleAssignments failed: ${err.message}`)
    throw err
  }
}

/**
 * P1-7: After upserting the new assignment set, delete rows for this
 * group+week whose (shift_id, staff_id) key is NOT in the new set.
 * Accepts an optional `db` override for testing.
 *
 * Strategy: fetch current ids → diff against new set → delete stale ids one by one.
 * supabase-js v2 doesn't support .in() on the DELETE path cleanly without RPC,
 * so we delete each stale row individually. Stale sets are typically small
 * (schedule changes affect a handful of assignments).
 *
 * @param {string} groupId
 * @param {string} weekStart
 * @param {Array<{shiftId, staffId}>} newAssignments - the newly upserted set
 * @param {object} [db] - optional Supabase client override (for testing)
 */
export async function deleteStaleAssignments(groupId, weekStart, newAssignments, db = null) {
  try {
    const client = db ?? getDb()
    // Fetch all current rows for this group+week
    const { data: existing, error: fetchErr } = await client
      .from('schedule_assignments')
      .select('id, shift_id, staff_id')
      .eq('group_id', groupId)
      .eq('week_start', weekStart)
    if (fetchErr) throw fetchErr
    if (!existing || existing.length === 0) return

    // Build a set of "shiftId:staffId" keys from the new assignment set
    const keepKeys = new Set(newAssignments.map(a => `${a.shiftId}:${a.staffId}`))

    // Collect ids of rows that are NOT in the new set (stale)
    const staleIds = existing
      .filter(r => !keepKeys.has(`${r.shift_id}:${r.staff_id}`))
      .map(r => r.id)

    if (staleIds.length === 0) return

    // Delete each stale row by id (small set — safe to loop)
    for (const id of staleIds) {
      const { error: delErr } = await client
        .from('schedule_assignments')
        .delete()
        .eq('id', id)
      if (delErr) throw delErr
    }

    logger.db(`Deleted ${staleIds.length} stale assignments for group ${groupId} week ${weekStart}`)
  } catch (err) {
    logger.error(`deleteStaleAssignments failed: ${err.message}`)
    throw err
  }
}

export async function addScheduleAssignment(groupId, shiftId, staffId, weekStart) {
  try {
    const { data, error } = await getDb()
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

// Find all shifts a person has for a given day across any recent schedule.
// Returns { matches: [{ shift, weekStart }] } or null on error.
export async function findPersonShiftForDay(groupId, requesterId, staffName, dayOfWeek) {
  try {
    const dayLower = dayOfWeek.toLowerCase()

    // 1. Published schedule JSONB
    const { data: schedule } = await getDb()
      .from('generated_schedules')
      .select('assignments, week_start')
      .eq('group_id', groupId)
      .eq('status', 'published')
      .order('published_at', { ascending: false })
      .limit(1)
      .maybeSingle()

    if (schedule?.assignments?.length) {
      const nameLower = staffName.toLowerCase()
      const jsonMatches = schedule.assignments.filter(a => {
        if (a.dayOfWeek?.toLowerCase() !== dayLower) return false
        if (requesterId && a.userId) return a.userId === requesterId
        return a.staffName?.toLowerCase() === nameLower
      })

      if (jsonMatches.length) {
        const shiftIds = [...new Set(jsonMatches.map(a => a.shiftId).filter(Boolean))]
        const { data: shifts } = await getDb().from('shifts').select('*').in('id', shiftIds)
        const matches = (shifts ?? []).map(shift => ({ shift, weekStart: schedule.week_start }))
        if (matches.length) return { matches }
      }
    }

    // 2. schedule_assignments fallback
    const { data: staffRows } = await getDb()
      .from('staff').select('id').eq('group_id', groupId).ilike('name', staffName).limit(1)

    if (staffRows?.length) {
      const staffId = staffRows[0].id
      const cutoff = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString().split('T')[0]
      const { data: assignments } = await getDb()
        .from('schedule_assignments')
        .select('id, shift_id, week_start, status')
        .eq('staff_id', staffId)
        .gte('week_start', cutoff)
        .order('week_start', { ascending: false })

      if (assignments?.length) {
        const shiftIds = [...new Set(assignments.map(a => a.shift_id))]
        const { data: shifts } = await getDb()
          .from('shifts').select('*').in('id', shiftIds).eq('day_of_week', dayOfWeek)

        if (shifts?.length) {
          const matches = shifts.map(shift => {
            const assignment = assignments.find(a => a.shift_id === shift.id)
            return { shift: { ...shift, assignmentId: assignment.id, staffId }, weekStart: assignment.week_start }
          })
          return { matches }
        }
      }
    }

    return { matches: [] }
  } catch (err) {
    logger.error(`findPersonShiftForDay failed: ${err.message}`)
    return null
  }
}

export async function getScheduledShiftForPerson(groupId, staffName, dayOfWeek, weekStart) {
  try {
    const { data: staffRows } = await getDb()
      .from('staff').select('id').eq('group_id', groupId).ilike('name', staffName).limit(1)
    if (!staffRows?.length) return null
    const staffId = staffRows[0].id

    const { data: assignments } = await getDb()
      .from('schedule_assignments')
      .select('id, shift_id, status')
      .eq('staff_id', staffId)
      .eq('week_start', weekStart)
    if (!assignments?.length) return null

    const shiftIds = assignments.map(a => a.shift_id)
    const { data: shifts } = await getDb()
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

export async function swapScheduleAssignment(groupId, shiftId, weekStart, fromStaffId, toStaffId) {
  const { error } = await getDb()
    .from('schedule_assignments')
    .update({ staff_id: toStaffId })
    .eq('group_id', groupId)
    .eq('shift_id', shiftId)
    .eq('week_start', weekStart)
    .eq('staff_id', fromStaffId)
  if (error) throw new Error(`swapScheduleAssignment failed: ${error.message}`)
  logger.db(`Swapped assignment: staff ${fromStaffId} → ${toStaffId} on shift ${shiftId}`)
}

export async function updateAssignmentStatus(assignmentId, status) {
  try {
    const { data, error } = await getDb()
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
