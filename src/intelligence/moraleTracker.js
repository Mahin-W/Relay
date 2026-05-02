import { getMoraleEvents } from './moraleDb.js'

const POSITIVE_KEYWORDS = ['bet', 'fasho', 'say less', 'happy', 'love', 'great', 'absolutely', 'for sure', 'of course', 'no problem', 'totally', 'excited']
const NEGATIVE_KEYWORDS = ['ugh', 'hate', 'again', 'always me', 'whatever', 'fine', 'i guess', 'if i have to', 'forced', 'last minute', 'ridiculous', 'ridic', 'absurd', 'unacceptable', 'fed up', 'had it', 'sick of', 'done with']

// BUG D1: when a positive intensifier is followed within 2 words by a negative adjective, classify negative
const NEGATIVE_ADJECTIVES = ['awful', 'terrible', 'bad', 'horrible', 'worst', 'shit', 'sucks', 'miserable', 'exhausting']

// BUG D3: distress phrases
const DISTRESS_PHRASES = [
  "hard time", "burned out", "burnt out", "overwhelmed",
  "can't keep", "cant keep", "not sure i can", "breaking point",
  "at my limit", "done", "hate this job", "miserable here",
  // Additional distress patterns
  "making me miserable", "making me crazy", "fed up",
  "had enough", "checked out", "checking out",
  "this job is making", "i'm miserable", "im miserable",
]

function _intensifierFollowedByNegativeAdj(lower) {
  const words = lower.split(/\s+/)
  for (let i = 0; i < words.length; i++) {
    const word = words[i].replace(/[^a-z]/g, '')
    if (POSITIVE_KEYWORDS.includes(word)) {
      // Check the next 2 words
      for (let j = i + 1; j <= i + 2 && j < words.length; j++) {
        const next = words[j].replace(/[^a-z]/g, '')
        if (NEGATIVE_ADJECTIVES.includes(next)) return true
      }
    }
  }
  return false
}

export function detectDistressSignal(text) {
  if (!text) return false
  const lower = text.toLowerCase()
  return DISTRESS_PHRASES.some(phrase => lower.includes(phrase))
}

export function detectResignationIntent(text) {
  if (!text) return false
  // Hard signals — explicit resignation language
  const hard = /\b(two\s*weeks?|2\s*weeks?|putting?\s+in\s+my\s+notice|last\s+day|quit(ting)?\s*(tomorrow|next|soon|today)?|moving\s+on|handing\s+in\s+my\s+notice|final\s+shift)\b/i
  // Soft signals — manager should be warned
  const soft = /\b(thinking\s+about\s+(leaving|quitting)|considering\s+(leaving|quitting)|might\s+(quit|leave)|need\s+to\s+(leave|move\s+on)|done\s+with\s+this\s+(job|place))\b/i
  return hard.test(text) || soft.test(text)
}

export function detectRemovalIntent(text) {
  if (!text) return null
  const match = text.match(/\b(fire|terminate|let\s+go|remove|get\s+rid\s+of)\s+(\w+)/i)
  if (!match) return null
  const verbRaw = match[1].toLowerCase()
  let intent
  if (verbRaw === 'fire') intent = 'fire'
  else if (verbRaw === 'terminate') intent = 'terminate'
  else intent = 'remove'
  return { intent, targetName: match[2].toLowerCase() }
}

export function classifySentiment(text) {
  if (!text || text.trim() === '') return 'neutral'
  const lower = text.toLowerCase()

  // BUG D4: resignation → negative
  if (detectResignationIntent(text)) return 'negative'

  // BUG D3: distress phrases → negative
  if (detectDistressSignal(text)) return 'negative'

  // Check negative FIRST
  for (const kw of NEGATIVE_KEYWORDS) {
    if (lower.includes(kw)) return 'negative'
  }

  // BUG D1: intensifier + negative adjective → negative
  if (_intensifierFollowedByNegativeAdj(lower)) return 'negative'

  for (const kw of POSITIVE_KEYWORDS) {
    if (lower.includes(kw)) return 'positive'
  }

  // Exclamation mark at end → positive
  if (text.trim().endsWith('!')) return 'positive'

  return 'neutral'
}

function isRecent(event, weeksThreshold = 2) {
  const now = new Date()
  const eventDate = new Date(event.created_at)
  const diffMs = now - eventDate
  const diffWeeks = diffMs / (7 * 24 * 60 * 60 * 1000)
  return diffWeeks <= weeksThreshold
}

function scoreEvent(event) {
  const { type, sentiment, response_minutes } = event
  switch (type) {
    case 'coverage_accept':
      if (sentiment === 'positive') return 3
      if (sentiment === 'negative') return 1
      return 2 // neutral
    case 'schedule_confirm':
      return (response_minutes != null && response_minutes < 60) ? 1 : 0
    case 'availability_response':
      if (response_minutes != null && response_minutes > 1440) return -1
      return (response_minutes != null && response_minutes < 120) ? 1 : 0
    case 'coverage_decline':
      return -1
    case 'no_response':
      return -2
    case 'late_confirm':
      return (response_minutes != null && response_minutes > 1440) ? -1 : 0
    default:
      return 0
  }
}

function countConsecutiveDeclines(events) {
  // events are ordered DESC by created_at — consecutive means the N most recent
  let count = 0
  for (const e of events) {
    if (e.type === 'coverage_decline') {
      count++
    } else {
      break
    }
  }
  return count
}

function buildSignals(events) {
  const counts = {}
  for (const e of events) {
    counts[e.type] = (counts[e.type] || 0) + 1
  }
  const signals = []
  if (counts.coverage_accept) signals.push(`${counts.coverage_accept} coverage accept${counts.coverage_accept > 1 ? 's' : ''}`)
  if (counts.coverage_decline) signals.push(`${counts.coverage_decline} coverage decline${counts.coverage_decline > 1 ? 's' : ''}`)
  if (counts.no_response) signals.push(`${counts.no_response} no-response${counts.no_response > 1 ? 's' : ''}`)
  if (counts.schedule_confirm) signals.push(`${counts.schedule_confirm} schedule confirm${counts.schedule_confirm > 1 ? 's' : ''}`)
  if (counts.availability_response) signals.push(`${counts.availability_response} availability response${counts.availability_response > 1 ? 's' : ''}`)
  if (counts.late_confirm) signals.push(`${counts.late_confirm} late confirm${counts.late_confirm > 1 ? 's' : ''}`)
  return signals
}

export function calculateMoraleScore(events) {
  if (!events || events.length === 0) return { score: 50, trend: 'stable', signals: [] }

  let rawScore = 0
  let recentScore = 0
  let previousScore = 0

  const consecutiveDeclines = countConsecutiveDeclines(events)
  const streakPenalty = consecutiveDeclines >= 3 ? -2 : 0

  for (const e of events) {
    const pts = scoreEvent(e)
    const weight = isRecent(e, 2) ? 2 : 1
    rawScore += pts * weight

    // For trend: recent = last 2 weeks, previous = 2-4 weeks ago
    if (isRecent(e, 2)) {
      recentScore += pts
    } else if (isRecent(e, 4) && !isRecent(e, 2)) {
      previousScore += pts
    }
  }

  rawScore += streakPenalty

  // Normalize: baseline 50, scale rawScore
  let score = 50 + rawScore * 3
  score = Math.max(0, Math.min(100, score))

  // Trend
  let trend = 'stable'
  if (recentScore - previousScore >= 5) trend = 'improving'
  else if (previousScore - recentScore >= 5) trend = 'declining'

  const signals = buildSignals(events)

  return { score: Math.round(score), trend, signals }
}

export function detectDisengagement(staffId, events) {
  if (!events || events.length === 0) return { flagged: false, reasons: [] }

  const reasons = []
  const { score, trend } = calculateMoraleScore(events)

  // Score < 40 AND declining
  if (score < 40 && trend === 'declining') {
    reasons.push(`Low engagement score (${score}/100) and declining trend`)
  }

  // 3+ consecutive coverage_decline
  const consecutiveDeclines = countConsecutiveDeclines(events)
  if (consecutiveDeclines >= 3) {
    reasons.push(`${consecutiveDeclines} consecutive declines`)
  }

  // No schedule_confirm in most recent 2 weeks
  const recentEvents = events.filter(e => isRecent(e, 2))
  if (recentEvents.length > 0 && !recentEvents.some(e => e.type === 'schedule_confirm')) {
    reasons.push('No schedule confirmation in last 2 weeks')
  }

  // 3+ no_response in last 4 weeks
  const last4Weeks = events.filter(e => isRecent(e, 4))
  const noResponseCount = last4Weeks.filter(e => e.type === 'no_response').length
  if (noResponseCount >= 3) {
    reasons.push(`${noResponseCount} no-responses in last 4 weeks`)
  }

  return { flagged: reasons.length > 0, reasons }
}

export async function generateMoraleReport(groupId, staffList, db = null) {
  if (!staffList || staffList.length === 0) {
    return { alerts: [], topPerformer: null, teamAverage: 50, snapshots: [] }
  }

  const snapshots = []
  const alerts = []
  let totalScore = 0

  for (const staff of staffList) {
    const events = await getMoraleEvents(groupId, staff.id, 8, db)
    const { score, trend, signals } = calculateMoraleScore(events)
    const { flagged, reasons } = detectDisengagement(staff.id, events)

    snapshots.push({ staffId: staff.id, staffName: staff.name, score, trend })

    if (flagged) {
      alerts.push({ staffId: staff.id, staffName: staff.name, score, trend, reasons })
    }

    totalScore += score
  }

  const teamAverage = Math.round(totalScore / staffList.length)

  // Top performer = highest score
  let topPerformer = null
  if (snapshots.length > 0) {
    const top = snapshots.reduce((a, b) => a.score >= b.score ? a : b)
    topPerformer = { staffId: top.staffId, staffName: top.staffName, score: top.score }
  }

  return { alerts, topPerformer, teamAverage, snapshots }
}

export function formatMoraleAlert(alerts) {
  if (!alerts || alerts.length === 0) return null
  const lines = alerts.map(a => `${a.staffName}: ${a.reasons[0]}. Consider checking in.`)
  return `\u{1F440} *Staff engagement \u2014 heads up:*\n\n${lines.join('\n')}`
}

function trendArrow(trend) {
  if (trend === 'improving') return '\u2191 improving'
  if (trend === 'declining') return '\u2193 declining'
  return '\u2192 stable'
}

function scoreEmoji(score) {
  if (score >= 65) return '\u{1F7E2}'
  if (score >= 40) return '\u{1F7E1}'
  return '\u{1F534}'
}

function scoreLabel(score) {
  if (score >= 65) return 'Strong'
  if (score >= 40) return 'OK'
  return 'Flagged'
}

export function formatMoraleReport(report) {
  if (!report || (!report.snapshots?.length)) {
    return '\u{1F4CA} *Team engagement \u2014 last 8 weeks*\n(Internal \u2014 not shared with staff)\n\nNo data yet.'
  }

  const alertMap = {}
  for (const a of (report.alerts || [])) {
    alertMap[a.staffId] = a.reasons
  }

  const lines = report.snapshots.map(s => {
    const emoji = scoreEmoji(s.score)
    const label = scoreLabel(s.score)
    let line = `${emoji} ${s.staffName}: ${label} (${s.score}/100, ${trendArrow(s.trend)})`
    if (alertMap[s.staffId]) {
      line += `\n   \u2192 ${alertMap[s.staffId].join('; ')}`
    }
    return line
  })

  let out = `\u{1F4CA} *Team engagement \u2014 last 8 weeks*\n(Internal \u2014 not shared with staff)\n\n`
  out += lines.join('\n')
  out += `\n\nTeam average: ${report.teamAverage}/100`
  if (report.topPerformer) {
    out += `\nTop this month: ${report.topPerformer.staffName}`
  }

  return out
}
