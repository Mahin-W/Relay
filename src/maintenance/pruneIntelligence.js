import { getDb } from '../db.js'
import { logger } from '../logger.js'

// P1-18: the intelligence tables accumulate forever (reads only ever look back
// 8–12 weeks). Prune anything older than the retention window so they don't grow
// unbounded and degrade query performance over time. Indexed on created_at.
export const RETENTION_DAYS = 730 // 2 years
const TABLES = ['morale_events', 'weekly_quality_scores', 'schedule_edit_events', 'discovered_patterns']

export async function pruneOldIntelligence(db = null) {
  const client = db || getDb()
  const cutoff = new Date(Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString()
  const results = {}
  for (const table of TABLES) {
    try {
      const { error } = await client.from(table).delete().lt('created_at', cutoff)
      if (error) throw error
      results[table] = 'ok'
    } catch (err) {
      logger.error(`pruneOldIntelligence ${table} failed: ${err.message}`)
      results[table] = 'error'
    }
  }
  logger.bot(`Pruned intelligence rows older than ${RETENTION_DAYS}d (cutoff ${cutoff.slice(0, 10)})`)
  return results
}
