import { getDb } from '../db.js'
import { logger } from '../logger.js'

/**
 * Upserts weekly quality score on (group_id, week_start).
 * Accepts a Supabase-shaped client OR a SimulationDb-style object that exposes
 * a `saveQualityScore(groupId, weekStart, scoreData)` named method.
 */
export async function saveWeeklyQualityScore(groupId, weekStart, scoreData, db = null) {
  const _db = db ?? getDb()
  try {
    if (typeof _db?.saveQualityScore === 'function') {
      return await _db.saveQualityScore(String(groupId), weekStart, scoreData)
    }
    if (typeof _db?.from !== 'function') return null

    const row = {
      group_id: String(groupId),
      week_start: weekStart,
      score: scoreData.score,
      grade: scoreData.grade,
      draft_edits: scoreData.draftEdits,
      coverage_requests: scoreData.coverageRequests,
      no_shows: scoreData.noShows,
      avg_fill_minutes: scoreData.avgFillMinutes,
      unconfirmed_count: scoreData.unconfirmedCount,
      weeks_of_data: scoreData.weeksOfData,
    }

    const { data, error } = await _db
      .from('weekly_quality_scores')
      .upsert(row, { onConflict: 'group_id,week_start' })
      .select()

    if (error) throw error
    logger?.db?.(`Saved quality score for ${groupId} week ${weekStart}: ${scoreData.score}`)
    return data
  } catch (err) {
    logger?.error?.(`saveWeeklyQualityScore failed: ${err.message}`)
    return null
  }
}

/**
 * Returns quality history ordered ASC by weekStart (chronological for trend).
 * Tolerates SimulationDb-style stubs that expose `getQualityHistory`.
 */
export async function getQualityHistory(groupId, weeksBack = 12, db = null) {
  const _db = db ?? getDb()
  try {
    if (typeof _db?.getQualityHistory === 'function') {
      return await _db.getQualityHistory(String(groupId), weeksBack)
    }
    if (typeof _db?.from !== 'function') return []

    const cutoff = new Date()
    cutoff.setDate(cutoff.getDate() - weeksBack * 7)
    const cutoffStr = cutoff.toISOString().slice(0, 10)

    const { data, error } = await _db
      .from('weekly_quality_scores')
      .select('*')
      .eq('group_id', String(groupId))
      .gte('week_start', cutoffStr)
      .order('week_start', { ascending: true })

    if (error) throw error

    return (data || []).map(row => ({
      weekStart: row.week_start,
      score: row.score,
      grade: row.grade,
      draftEdits: row.draft_edits,
      coverageRequests: row.coverage_requests,
      noShows: row.no_shows,
      avgFillMinutes: row.avg_fill_minutes,
      unconfirmedCount: row.unconfirmed_count,
    }))
  } catch (err) {
    logger?.error?.(`getQualityHistory failed: ${err.message}`)
    return []
  }
}
