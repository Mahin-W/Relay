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

/** Returns true if the given event type has a negative impact on the score. */
export function isNegativeEvent(eventType) {
  return (SCORES[eventType] ?? 0) < 0
}

const NEW_HIRE_GRACE_MS = 14 * 24 * 60 * 60 * 1000 // 14 days

/**
 * Returns true when a negative reliability event should be skipped because the
 * staff member is still within the 14-day new-hire grace period.
 * Positive events are always recorded regardless.
 *
 * @param {string|null|undefined} staffCreatedAt — ISO timestamp of staff.created_at
 * @returns {boolean} true → skip the event; false → record it normally
 */
export function shouldSkipNegativeEvent(staffCreatedAt) {
  if (!staffCreatedAt) return false
  const createdAt = new Date(staffCreatedAt)
  if (isNaN(createdAt.getTime())) return false
  return Date.now() - createdAt.getTime() < NEW_HIRE_GRACE_MS
}

const SCORE_LABEL_EXPLANATION = {
  excellent: 'You\'ve been very reliable — keep it up!',
  good: 'You\'re in good standing with your team.',
  fair: 'Some missed or late shifts are affecting your score — consistency helps.',
  poor: 'Several missed shifts are pulling your score down. Talk to your manager if you need support.',
}

/**
 * Formats a staff-facing one-line reliability score message.
 * @param {number} score
 * @param {string} label
 * @returns {string}
 */
export function formatMyScore(score, label) {
  const icon = LABEL_ICON[label] ?? '⚪'
  const explanation = SCORE_LABEL_EXPLANATION[label] ?? ''
  return `${icon} Your reliability score: *${score}/100* (${label})\n${explanation}`
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
