import { createClient } from '@supabase/supabase-js'
import { logger } from '../logger.js'
import { computeScore, getReliabilityLabel } from './reliabilityScore.js'

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY)

/**
 * Records a reliability event for a staff member.
 * Silently logs on error — never throws (callers must not crash on failure).
 */
export async function recordEvent(staffId, groupId, eventType, metadata = {}) {
  try {
    const { error } = await supabase
      .from('staff_reliability_events')
      .insert({ staff_id: staffId, group_id: groupId, event_type: eventType, metadata })
    if (error) throw error
  } catch (err) {
    logger.error(`recordEvent error [${eventType}]: ${err.message}`)
  }
}

/**
 * Returns all reliability events for a staff member in the last N days.
 */
export async function getReliabilityEvents(staffId, groupId, dayLimit = 90) {
  try {
    const since = new Date(Date.now() - dayLimit * 24 * 60 * 60 * 1000).toISOString()
    const { data, error } = await supabase
      .from('staff_reliability_events')
      .select('event_type, recorded_at')
      .eq('staff_id', staffId)
      .eq('group_id', groupId)
      .gte('recorded_at', since)
      .order('recorded_at', { ascending: false })
    if (error) throw error
    return data ?? []
  } catch (err) {
    logger.error(`getReliabilityEvents error: ${err.message}`)
    return []
  }
}

/**
 * Returns computed reliability scores for all staff in a group.
 * @returns {Array<{staffId, staffName, score, label, eventCount}>}
 */
export async function getReliabilityScores(groupId) {
  try {
    const { data: staffRows, error } = await supabase
      .from('staff')
      .select('id, name')
      .eq('group_id', groupId)
    if (error) throw error

    const results = await Promise.all(
      (staffRows ?? []).map(async (s) => {
        const events = await getReliabilityEvents(s.id, groupId)
        const score = computeScore(events)
        return {
          staffId: s.id,
          staffName: s.name,
          score,
          label: getReliabilityLabel(score),
          eventCount: events.length,
        }
      })
    )
    return results.sort((a, b) => b.score - a.score)
  } catch (err) {
    logger.error(`getReliabilityScores error: ${err.message}`)
    return []
  }
}
