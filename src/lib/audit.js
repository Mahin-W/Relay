// Immutable audit trail (Epic 0 / WP-0.4).
//
// Every compliance-sensitive or money-moving mutation should call logEvent().
// Writes are append-only: this module never UPDATEs or DELETEs a row.
//
// Convention (matches the rest of the codebase): an optional `db` mock can be
// passed last to bypass Supabase in unit tests. The mock implements
// insertAuditEvent(row) / getAuditLog(groupId, opts).

import { getDb } from '../db.js'
import { logger } from '../logger.js'

const VALID_ACTOR_TYPES = new Set(['system', 'owner', 'manager', 'staff', 'provider'])

/**
 * Append an immutable audit event.
 * @param {object} event
 * @param {string|number} event.groupId      - tenant id (required)
 * @param {string} event.action              - dotted action name, e.g. 'payroll.run' (required)
 * @param {string|number|null} [event.actorId]   - who did it (telegram id, account id, ...)
 * @param {string} [event.actorType]         - system|owner|manager|staff|provider
 * @param {string|number|null} [event.target]    - affected entity id
 * @param {object} [event.meta]              - structured context (amounts, before/after, refs)
 * @param {object|null} [db]                 - mock for tests
 * @returns {Promise<object|null>} the saved row, or null on failure
 */
export async function logEvent(event = {}, db = null) {
  const { groupId, action } = event
  if (!groupId || !action) {
    logger.error('logEvent: groupId and action are required')
    return null
  }
  const actorType = VALID_ACTOR_TYPES.has(event.actorType) ? event.actorType : 'system'
  const row = {
    group_id: String(groupId),
    actor_id: event.actorId != null ? String(event.actorId) : null,
    actor_type: actorType,
    action: String(action),
    target: event.target != null ? String(event.target) : null,
    meta: event.meta ?? {},
  }

  if (db?.insertAuditEvent) return db.insertAuditEvent(row)

  try {
    const { data, error } = await getDb()
      .from('audit_log')
      .insert([row])
      .select()
      .single()
    if (error) { logger.error(`logEvent failed: ${error.message}`); return null }
    return data
  } catch (err) {
    logger.error(`logEvent error: ${err.message}`)
    return null
  }
}

/**
 * Read recent audit events for a tenant.
 * @param {string|number} groupId
 * @param {object} [opts]
 * @param {number} [opts.limit=50]
 * @param {string|null} [opts.action]  - filter by exact action
 * @param {object|null} [db]
 * @returns {Promise<object[]>}
 */
export async function getAuditLog(groupId, opts = {}, db = null) {
  const { limit = 50, action = null } = opts
  if (!groupId) { logger.error('getAuditLog: groupId required'); return [] }

  if (db?.getAuditLog) return db.getAuditLog(groupId, { limit, action })

  try {
    let q = getDb().from('audit_log').select('*').eq('group_id', String(groupId))
    if (action) q = q.eq('action', action)
    const { data, error } = await q.order('created_at', { ascending: false }).limit(limit)
    if (error) { logger.error(`getAuditLog failed: ${error.message}`); return [] }
    return data ?? []
  } catch (err) {
    logger.error(`getAuditLog error: ${err.message}`)
    return []
  }
}
