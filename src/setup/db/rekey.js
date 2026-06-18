import { getDb } from '../../db.js'
import { logger } from '../../logger.js'

// Rewrite group_id from oldGroupId to newGroupId across every table that has a
// group_id column (via the rekey_group Postgres function). Atomic + idempotent.
export async function rekeyGroup(oldGroupId, newGroupId, db = null) {
  try {
    const client = db || getDb()
    const { error } = await client.rpc('rekey_group', { old_group: oldGroupId, new_group: newGroupId })
    if (error) throw error
    logger.bot(`Rekeyed group ${oldGroupId} → ${newGroupId}`)
    return true
  } catch (err) {
    logger.error(`rekeyGroup failed: ${err.message}`)
    return false
  }
}
