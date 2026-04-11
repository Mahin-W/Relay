import { logger } from '../logger.js'

export function calculateCoverageScore(avgResponseMinutes, actualReliability, confirmationCount) {
  const speedScore = Math.max(0, 1 - (avgResponseMinutes / 60))
  let score = (actualReliability * 0.6) + (speedScore * 0.4)
  if (confirmationCount >= 5) score += 0.05
  return Math.min(1.0, Math.max(0, score))
}

export async function getCoverageResponseStats(groupId, db = null) {
  const _getCoveredRequests = db?.getCoveredRequests
  const _getNoShowAfterConfirm = db?.getNoShowAfterConfirm

  if (!_getCoveredRequests || !_getNoShowAfterConfirm) {
    logger.warn('coverageSpeed: missing db functions')
    return []
  }

  const history = await _getCoveredRequests(groupId)
  const noShows = await _getNoShowAfterConfirm(groupId)

  // Group by covered_by
  const grouped = {}
  for (const row of history) {
    if (!row.covered_by || !row.created_at || !row.covered_at) continue
    if (!grouped[row.covered_by]) grouped[row.covered_by] = []
    const responseMin = (new Date(row.covered_at) - new Date(row.created_at)) / 60000
    grouped[row.covered_by].push(responseMin)
  }

  // Count no-shows per person
  const noShowCounts = {}
  for (const row of noShows) {
    noShowCounts[row.covered_by] = (noShowCounts[row.covered_by] || 0) + 1
  }

  const results = []
  for (const [name, responseTimes] of Object.entries(grouped)) {
    if (responseTimes.length < 2) continue
    const avgResponseMinutes = responseTimes.reduce((a, b) => a + b, 0) / responseTimes.length
    const confirmationCount = responseTimes.length
    const noShowCount = noShowCounts[name] || 0
    const actualReliability = (confirmationCount - noShowCount) / confirmationCount
    const score = calculateCoverageScore(avgResponseMinutes, actualReliability, confirmationCount)
    results.push({ name, avgResponseMinutes, confirmationCount, noShowCount, actualReliability, score })
  }

  results.sort((a, b) => b.score - a.score)
  return results
}

export async function getTopResponders(groupId, count = 3, db = null) {
  const stats = await getCoverageResponseStats(groupId, db)
  return stats.slice(0, count)
}

export function formatCoverageSpeedNotice(topResponders, avgFillTime) {
  if (!topResponders || topResponders.length < 2) return null

  const names = topResponders
    .map(r => `${r.name} (avg ${Math.round(r.avgResponseMinutes)}min)`)
    .join(', ')

  return `📬 *Notified your ${topResponders.length} fastest responders first:*\n${names}\n\nTeam avg fill time: ${Math.round(avgFillTime)}min`
}
