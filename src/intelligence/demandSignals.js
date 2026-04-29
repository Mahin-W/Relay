import { createClient } from '@supabase/supabase-js'

const supabase = (process.env.SUPABASE_URL && process.env.SUPABASE_ANON_KEY)
  ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY)
  : null

const HIGH_KEYWORDS = [
  'big event', 'full house', 'packed', 'large party', 'reservation',
  'expecting a crowd', 'game day', 'holiday', 'festival', 'graduation',
  'birthday party', 'special event', 'sold out', 'fully booked', 'rush',
]

const LOW_KEYWORDS = [
  'slow week', 'light week', 'probably slow', 'not much going on',
  'slow night', 'light covers', 'off season', 'quiet week',
]

const SINGLE_HIGH = ['busy']
const SINGLE_LOW = ['slow', 'quiet', 'dead']

const FALSE_POSITIVE_PATTERNS = [
  'busy work',
  'dead tired',
  'dead serious',
  'dead set',
  'deadline',
  'quiet down',
  'rush hour',
]

const DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']

export function extractDemandSignal(text) {
  if (typeof text !== 'string' || text.trim() === '') return null
  const lower = text.toLowerCase()

  // Check false positives first
  for (const fp of FALSE_POSITIVE_PATTERNS) {
    if (lower.includes(fp)) return null
  }

  let type = null
  let rawMention = null

  // Check multi-word keywords first
  for (const kw of HIGH_KEYWORDS) {
    if (lower.includes(kw)) {
      type = 'high'
      rawMention = kw
      break
    }
  }

  if (!type) {
    for (const kw of LOW_KEYWORDS) {
      if (lower.includes(kw)) {
        type = 'low'
        rawMention = kw
        break
      }
    }
  }

  // Single-word triggers only if no multi-word match
  if (!type) {
    for (const kw of SINGLE_HIGH) {
      // Match as whole word to avoid false positives
      const re = new RegExp(`\\b${kw}\\b`, 'i')
      if (re.test(text)) {
        type = 'high'
        rawMention = kw
        break
      }
    }
  }

  if (!type) {
    for (const kw of SINGLE_LOW) {
      const re = new RegExp(`\\b${kw}\\b`, 'i')
      if (re.test(text)) {
        type = 'low'
        rawMention = kw
        break
      }
    }
  }

  if (!type) return null

  // Extract day of week
  let dayOfWeek = null
  for (const day of DAYS) {
    if (lower.includes(day.toLowerCase())) {
      dayOfWeek = day
      break
    }
  }

  // "tonight" → week-level (can't know what day)
  const isWeekLevel = dayOfWeek === null

  return { type, dayOfWeek, isWeekLevel, rawMention }
}

export async function saveDemandSignal(groupId, weekStart, signal, sourceMessage, sourceUserId, db = null) {
  if (db?.saveDemandSignal) return db.saveDemandSignal(groupId, weekStart, signal, sourceMessage, sourceUserId)
  const { data, error } = await supabase
    .from('demand_signals')
    .upsert({
      group_id: groupId,
      week_start: weekStart,
      type: signal.type,
      day_of_week: signal.dayOfWeek,
      is_week_level: signal.isWeekLevel,
      raw_mention: signal.rawMention,
      source_message: sourceMessage,
      source_user_id: sourceUserId,
    })
    .select()
    .single()
  if (error) throw error
  return data
}

export async function getDemandSignals(groupId, weekStart, db = null) {
  if (db?.getDemandSignals) return db.getDemandSignals(groupId, weekStart)
  const { data, error } = await supabase
    .from('demand_signals')
    .select('*')
    .eq('group_id', groupId)
    .eq('week_start', weekStart)
    .order('created_at', { ascending: false })
  if (error) throw error
  return data ?? []
}

export async function generateDemandRecommendations(groupId, weekStart, assignments, db = null) {
  const _getDemandSignals = db?.getDemandSignals ? (g, w) => db.getDemandSignals(g, w) : (g, w) => getDemandSignals(g, w)
  const _getHistorical = db?.getHistoricalStaffCount ? (g, d) => db.getHistoricalStaffCount(g, d) : null

  const signals = await _getDemandSignals(groupId, weekStart)
  if (!signals || signals.length === 0) return []

  const recommendations = []

  for (const signal of signals) {
    if (!signal.dayOfWeek) continue

    const currentCount = assignments.filter(a => a.day_of_week === signal.dayOfWeek).length
    const historical = _getHistorical ? await _getHistorical(groupId, signal.dayOfWeek) : { avg: 0, weekCount: 0 }

    if (historical.weekCount === 0) {
      recommendations.push({
        type: 'fyi',
        dayOfWeek: signal.dayOfWeek,
        currentCount,
        signal,
        message: `${signal.type} demand signal for ${signal.dayOfWeek} ("${signal.rawMention}") but no historical data to compare.`,
      })
      continue
    }

    if (signal.type === 'high' && currentCount < historical.avg * 1.2) {
      recommendations.push({
        type: 'add_staff',
        dayOfWeek: signal.dayOfWeek,
        currentCount,
        historicalAvg: historical.avg,
        signal,
      })
    } else if (signal.type === 'low' && currentCount > historical.avg * 0.8) {
      recommendations.push({
        type: 'reduce_staff',
        dayOfWeek: signal.dayOfWeek,
        currentCount,
        historicalAvg: historical.avg,
        signal,
      })
    }
  }

  return recommendations
}

export function formatDemandRecommendations(recommendations) {
  if (!recommendations || recommendations.length === 0) return null

  let lines = ['\u{1F4E3} *Demand-Aware Staffing Notes*\n']

  for (const rec of recommendations) {
    if (rec.type === 'add_staff') {
      lines.push(`\u2022 *${rec.dayOfWeek}*: "${rec.signal.rawMention}" detected \u2014 currently ${rec.currentCount} staff, historical avg ${rec.historicalAvg}. Consider adding staff.`)
    } else if (rec.type === 'reduce_staff') {
      lines.push(`\u2022 *${rec.dayOfWeek}*: "${rec.signal.rawMention}" detected \u2014 currently ${rec.currentCount} staff, historical avg ${rec.historicalAvg}. Could reduce.`)
    } else if (rec.type === 'fyi') {
      lines.push(`\u2022 *${rec.dayOfWeek}*: ${rec.message}`)
    }
  }

  return lines.join('\n')
}
