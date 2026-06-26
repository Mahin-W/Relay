// Per-employee payroll settings (Epic 2 / WP-2.6).
//
// Tax classification per employee. DEFAULT = W-2; the owner can switch an
// employee to 1099. Changing tax_type is compliance-sensitive, so every change
// is written to the audit log. Owner-only access is enforced at the command
// layer (commandRegistry role check) — this module is pure data + audit.

import { getDb } from '../db.js'
import { logger } from '../logger.js'
import { logEvent } from '../lib/audit.js'

export const VALID_TAX_TYPES = new Set(['w2', '1099'])
export const DEFAULT_TAX_TYPE = 'w2'

export async function getPayrollSettings(groupId, staffId, db = null) {
  if (db?.getPayrollSettings) return db.getPayrollSettings(groupId, staffId)
  try {
    const { data, error } = await getDb()
      .from('employee_payroll_settings')
      .select('*')
      .eq('group_id', String(groupId))
      .eq('staff_id', staffId)
      .maybeSingle()
    if (error) { logger.error(`getPayrollSettings failed: ${error.message}`); return null }
    return data ?? null
  } catch (err) {
    logger.error(`getPayrollSettings error: ${err.message}`)
    return null
  }
}

/** Tax type for an employee, defaulting to W-2 when unset. */
export async function getTaxType(groupId, staffId, db = null) {
  const s = await getPayrollSettings(groupId, staffId, db)
  return s?.tax_type ?? DEFAULT_TAX_TYPE
}

/**
 * Change an employee's tax type (w2 ⇄ 1099) and audit the change.
 * @returns saved row, or null on invalid input / failure
 */
export async function setTaxType(groupId, staffId, taxType, actorId = null, db = null) {
  if (!VALID_TAX_TYPES.has(taxType)) {
    logger.error(`setTaxType: invalid tax type '${taxType}'`)
    return null
  }
  const prev = await getTaxType(groupId, staffId, db)
  const row = {
    group_id: String(groupId),
    staff_id: staffId,
    tax_type: taxType,
    updated_by: actorId != null ? String(actorId) : null,
    updated_at: new Date().toISOString(),
  }

  let saved
  if (db?.upsertPayrollSettings) {
    saved = await db.upsertPayrollSettings(row)
  } else {
    try {
      const { data, error } = await getDb()
        .from('employee_payroll_settings')
        .upsert(row, { onConflict: 'group_id,staff_id' })
        .select()
        .single()
      if (error) { logger.error(`setTaxType failed: ${error.message}`); return null }
      saved = data
    } catch (err) {
      logger.error(`setTaxType error: ${err.message}`)
      return null
    }
  }

  if (prev !== taxType) {
    await logEvent({
      groupId, actorId, actorType: 'owner',
      action: 'payroll.tax_type.change', target: staffId,
      meta: { from: prev, to: taxType },
    }, db)
  }
  return saved
}
