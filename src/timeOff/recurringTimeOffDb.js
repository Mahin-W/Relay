import { getDb } from '../db.js'
import { logger } from '../logger.js'

/**
 * Upsert a recurring constraint for a staff member.
 * constraint = { type, dayOfWeek, beforeTime, afterTime, note }
 */
export async function saveRecurringConstraint(staffId, groupId, constraint, db = null) {
  const _save = db?.saveRecurringConstraint ?? null

  if (_save) {
    return _save(staffId, groupId, constraint)
  }

  try {
    const supabase = getDb()
    const { data, error } = await supabase
      .from('recurring_constraints')
      .upsert(
        {
          staff_id: staffId,
          group_id: groupId,
          type: constraint.type,
          day_of_week: constraint.dayOfWeek ?? null,
          before_time: constraint.beforeTime ?? null,
          after_time: constraint.afterTime ?? null,
          note: constraint.note ?? null,
          active: true,
        },
        {
          onConflict: 'staff_id,group_id,day_of_week,type',
          ignoreDuplicates: false,
        }
      )
      .select()
      .single()

    if (error) throw error
    logger.db(`saveRecurringConstraint: saved for staffId=${staffId} groupId=${groupId} type=${constraint.type}`)
    return data
  } catch (err) {
    logger.error(`saveRecurringConstraint failed: ${err.message}`)
    return null
  }
}

/**
 * Get all active recurring constraints for a specific staff member in a group.
 */
export async function getRecurringConstraints(staffId, groupId, db = null) {
  const _get = db?.getRecurringConstraints ?? null

  if (_get) {
    return _get(staffId, groupId)
  }

  try {
    const supabase = getDb()
    const { data, error } = await supabase
      .from('recurring_constraints')
      .select('*')
      .eq('staff_id', staffId)
      .eq('group_id', groupId)
      .eq('active', true)

    if (error) throw error
    return data ?? []
  } catch (err) {
    logger.error(`getRecurringConstraints failed: ${err.message}`)
    return []
  }
}

/**
 * Get all active recurring constraints for a group (across all staff).
 * Returns [{ staffId, type, dayOfWeek, beforeTime, afterTime }]
 */
export async function getGroupRecurringConstraints(groupId, db = null) {
  const _get = db?.getGroupRecurringConstraints ?? null

  if (_get) {
    return _get(groupId)
  }

  try {
    const supabase = getDb()
    const { data, error } = await supabase
      .from('recurring_constraints')
      .select('*')
      .eq('group_id', groupId)
      .eq('active', true)

    if (error) throw error

    return (data ?? []).map(row => ({
      staffId: row.staff_id,
      type: row.type,
      dayOfWeek: row.day_of_week,
      beforeTime: row.before_time,
      afterTime: row.after_time,
    }))
  } catch (err) {
    logger.error(`getGroupRecurringConstraints failed: ${err.message}`)
    return []
  }
}

/**
 * Soft-delete a constraint by setting active=false.
 */
export async function deactivateConstraint(constraintId, groupId, db = null) {
  const _deactivate = db?.deactivateConstraint ?? null

  if (_deactivate) {
    return _deactivate(constraintId, groupId)
  }

  try {
    const supabase = getDb()
    const { data, error } = await supabase
      .from('recurring_constraints')
      .update({ active: false })
      .eq('id', constraintId)
      .eq('group_id', groupId)
      .select()
      .single()

    if (error) throw error
    logger.db(`deactivateConstraint: id=${constraintId} in group=${groupId}`)
    return data
  } catch (err) {
    logger.error(`deactivateConstraint failed: ${err.message}`)
    return null
  }
}
