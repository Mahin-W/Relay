const SCORES = {
  covered_someone: 5,
  confirmed_schedule: 3,
  trade_completed: 2,
  called_out: -10,
  no_call_no_show: -20,
  late_arrival: -3,
  showed_up: 0,
  trade_requested: 0,
}

/**
 * Computes reliability score 0-100 from an array of event objects.
 * Events with recorded_at within last 30 days count 2x.
 * Events without recorded_at (or >30 days old) count 1x.
 * Baseline is 70.
 */
export function computeScore(events) {
  if (!events.length) return 70

  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)

  let delta = 0
  for (const event of events) {
    const base = SCORES[event.event_type] ?? 0
    const isRecent = event.recorded_at && new Date(event.recorded_at) > thirtyDaysAgo
    delta += base * (isRecent ? 2 : 1)
  }

  return Math.max(0, Math.min(100, 70 + delta))
}

/**
 * Returns a human label for a reliability score.
 */
export function getReliabilityLabel(score) {
  if (score >= 85) return 'excellent'
  if (score >= 70) return 'good'
  if (score >= 50) return 'fair'
  return 'poor'
}

const LABEL_ICON = {
  excellent: '🟢',
  good: '🟢',
  fair: '🟡',
  poor: '🔴',
}

/**
 * Formats a manager-only reliability report.
 * @param {Array<{staffName, score, label, eventCount}>} staffScores
 * @returns {string}
 */
export function formatReliabilityReport(staffScores) {
  const header = '📊 *Staff reliability (internal — last 90 days)*'
  if (!staffScores.length) return `${header}\n\n_No data yet._`

  const lines = staffScores.map(({ staffName, score, label }) => {
    const icon = LABEL_ICON[label] ?? '⚪'
    return `${icon} ${staffName}: ${score}/100 (${label})`
  })

  return [header, '', ...lines].join('\n')
}
