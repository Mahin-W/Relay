import { createClient } from '@supabase/supabase-js'

const supabase = (process.env.SUPABASE_URL && process.env.SUPABASE_ANON_KEY)
  ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY)
  : null

// ── Trigger phrases (case-insensitive, phrase-based matching) ────────────────

const TRIGGER_PHRASES = [
  'shoutout', 'shout out', 'shout-out',
  'great job', 'good job',
  'well done', 'nicely done',
  'kudos', 'props to',
  'big thanks', 'thank you', 'thanks to',
  'appreciate',
  'killed it', 'crushed it',
  'mvp', 'stepped up', 'came through', 'clutch',
]

// Single-word triggers that need staff/team context to fire
const CONTEXT_TRIGGERS = ['star', 'legend']

const TEAM_WORDS = ['everyone', 'team', 'crew', "y'all", 'yall', 'all']
const ROLE_WORDS = ['servers', 'kitchen', 'cooks', 'bartenders', 'hosts', 'bussers']

// Negation patterns — if any of these prefixes a trigger phrase, the message
// is NOT a recognition event. e.g. "no shoutouts tonight", "stop thanking me".
const NEGATION_RE = /\b(no|not|stop|never|don'?t|didn'?t|hardly|barely)\b/i

// Cap on the `reason` field — guards against runaway DB inserts when a
// noisy/garbage message gets matched.
const MAX_REASON_LEN = 200

// Levenshtein distance — used for fuzzy-matching staff names so "Mark"
// matches "Marc" but "Sebastian" doesn't match "Sam".
function levenshtein(a, b) {
  if (a === b) return 0
  if (!a.length) return b.length
  if (!b.length) return a.length
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i])
  for (let j = 1; j <= b.length; j++) dp[0][j] = j
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + cost)
    }
  }
  return dp[a.length][b.length]
}

/**
 * detectRecognition — pure function, keyword matching, NO LLM.
 * Returns null if no trigger phrase found OR if message is negated.
 * Returns { recipientType, recipientName, recipientStaffId, role, reason, originalText }
 */
export function detectRecognition(text, staff = []) {
  if (typeof text !== 'string' || !text.trim()) return null
  const lower = text.toLowerCase()

  // Negation guard — "no shoutouts tonight", "not a shoutout", "stop thanking me"
  // Apply only if the negation appears within the first 25 characters AND
  // before the trigger phrase. (We don't want to drop "shoutout to Marco who
  // never let us down".)
  const negMatch = lower.match(NEGATION_RE)
  if (negMatch && negMatch.index <= 25) {
    return null
  }

  // Check for trigger phrase match
  let matched = false
  for (const phrase of TRIGGER_PHRASES) {
    if (lower.includes(phrase)) {
      matched = true
      break
    }
  }

  // Check context triggers (star, legend) — only match if staff name or team word is also present
  if (!matched) {
    for (const trigger of CONTEXT_TRIGGERS) {
      // Match as whole word using word boundary check
      const regex = new RegExp(`\\b${trigger}\\b`, 'i')
      if (regex.test(lower)) {
        const hasStaffRef = staff.some(s => lower.includes(s.name.toLowerCase()))
        const hasTeamRef = TEAM_WORDS.some(w => lower.includes(w)) || ROLE_WORDS.some(w => lower.includes(w))
        if (hasStaffRef || hasTeamRef) {
          matched = true
          break
        }
      }
    }
  }

  if (!matched) return null

  // Determine recipient
  const result = {
    recipientType: 'team',
    recipientName: null,
    recipientStaffId: null,
    role: null,
    reason: null,
    originalText: text,
  }

  // Check for individual staff name (exact substring first)
  for (const s of staff) {
    if (lower.includes(s.name.toLowerCase())) {
      result.recipientType = 'individual'
      result.recipientName = s.name
      result.recipientStaffId = s.id
      break
    }
  }

  // Fuzzy match — "Mark" → "Marc", "Tonyy" → "Tony". Only fires if no exact
  // match was found. Uses tokens of length 3+ from the message and compares
  // against staff names with a Levenshtein cap of 1 for short names (3-4 chars)
  // or 2 for longer ones.
  if (result.recipientType !== 'individual' && staff.length > 0) {
    const tokens = text
      .replace(/[^\w\s'-]/g, ' ')
      .split(/\s+/)
      .filter(t => t.length >= 3 && t.length <= 30)
    let bestStaff = null
    let bestDist = Infinity
    for (const tok of tokens) {
      const tl = tok.toLowerCase()
      for (const s of staff) {
        const sn = s.name.toLowerCase()
        // Skip if the token IS the staff name (already handled above)
        if (sn === tl) continue
        const maxDist = sn.length <= 4 ? 1 : 2
        const dist = levenshtein(sn, tl)
        if (dist <= maxDist && dist < bestDist) {
          bestDist = dist
          bestStaff = s
        }
      }
    }
    if (bestStaff) {
      result.recipientType = 'individual'
      result.recipientName = bestStaff.name
      result.recipientStaffId = bestStaff.id
    }
  }

  // If not individual, check for role words
  if (result.recipientType !== 'individual') {
    for (const role of ROLE_WORDS) {
      if (lower.includes(role)) {
        result.recipientType = 'role'
        result.role = role
        break
      }
    }
  }

  // Extract reason — text after "for" or after the trigger phrase
  const forMatch = text.match(/\bfor\s+(.+)/i)
  if (forMatch) {
    result.reason = forMatch[1].trim()
  } else {
    // Use text after the trigger phrase as reason
    for (const phrase of [...TRIGGER_PHRASES, ...CONTEXT_TRIGGERS]) {
      const idx = lower.indexOf(phrase)
      if (idx !== -1) {
        const afterTrigger = text.slice(idx + phrase.length).trim()
        // Remove leading staff name if present
        let reason = afterTrigger
        if (result.recipientName) {
          const nameIdx = reason.toLowerCase().indexOf(result.recipientName.toLowerCase())
          if (nameIdx !== -1) {
            reason = reason.slice(nameIdx + result.recipientName.length).trim()
          }
        }
        // Remove leading "to" if present
        reason = reason.replace(/^to\s+/i, '').trim()
        if (reason.length > 2) {
          result.reason = reason.slice(0, MAX_REASON_LEN)
        }
        break
      }
    }
  }
  if (result.reason && result.reason.length > MAX_REASON_LEN) {
    result.reason = result.reason.slice(0, MAX_REASON_LEN)
  }

  return result
}

// ── DB operations ────────────────────────────────────────────────────────────

export async function saveRecognitionEvent(groupId, managerId, recognition, db = null) {
  if (db?.saveRecognitionEvent) return db.saveRecognitionEvent(groupId, managerId, recognition)

  const { data, error } = await supabase
    .from('recognition_events')
    .insert({
      group_id: groupId,
      manager_id: managerId,
      recipient_type: recognition.recipientType,
      recipient_name: recognition.recipientName,
      recipient_staff_id: recognition.recipientStaffId,
      role: recognition.role,
      reason: recognition.reason,
      original_text: recognition.originalText,
    })
    .select()
    .single()
  if (error) throw error
  return data
}

export async function getRecognitionHistory(groupId, staffId = null, weeksBack = 8, db = null) {
  if (db?.getRecognitionHistory) return db.getRecognitionHistory(groupId, staffId, weeksBack)

  const cutoff = new Date()
  cutoff.setDate(cutoff.getDate() - weeksBack * 7)

  let query = supabase
    .from('recognition_events')
    .select('*')
    .eq('group_id', groupId)
    .gte('created_at', cutoff.toISOString())
    .order('created_at', { ascending: false })

  if (staffId) {
    query = query.eq('recipient_staff_id', staffId)
  }

  const { data, error } = await query
  if (error) throw error
  return data ?? []
}

export async function getRecognitionLeaderboard(groupId, weeksBack = 4, db = null) {
  if (db?.getRecognitionLeaderboard) return db.getRecognitionLeaderboard(groupId, weeksBack)

  const cutoff = new Date()
  cutoff.setDate(cutoff.getDate() - weeksBack * 7)

  const { data, error } = await supabase
    .from('recognition_events')
    .select('*')
    .eq('group_id', groupId)
    .not('recipient_staff_id', 'is', null)
    .gte('created_at', cutoff.toISOString())
  if (error) throw error

  const counts = {}
  for (const e of (data ?? [])) {
    const key = e.recipient_staff_id
    if (!counts[key]) {
      counts[key] = { staffId: key, staffName: e.recipient_name, count: 0, lastRecognized: e.created_at }
    }
    counts[key].count++
    if (e.created_at > counts[key].lastRecognized) counts[key].lastRecognized = e.created_at
  }

  return Object.values(counts).sort((a, b) => b.count - a.count)
}

// ── Formatting ───────────────────────────────────────────────────────────────

export function formatGroupShoutout(recognition, managerName) {
  if (recognition.recipientType === 'individual') {
    const reason = recognition.reason || recognition.originalText
    return `\u{1F31F} *${managerName} says:*\n\n${recognition.recipientName} \u2014 ${reason}\n\nKeep it up! \u{1F4AA}`
  }
  // team or role
  return `\u{1F31F} *${managerName} says:*\n\n${recognition.originalText}\n\nGreat work, team! \u{1F64C}`
}

// ── Handler ──────────────────────────────────────────────────────────────────

function getWeekStart() {
  const now = new Date()
  const day = now.getDay()
  const diff = now.getDate() - day + (day === 0 ? -6 : 1) // Monday
  const monday = new Date(now)
  monday.setDate(diff)
  return monday.toISOString().slice(0, 10)
}

export async function handleRecognition(bot, msg, groupId, db = null) {
  if (!msg.text) return

  // Get staff list
  const staff = db?.getStaffByGroupId
    ? await db.getStaffByGroupId(groupId)
    : await getStaffForGroup(groupId)

  const staffList = (staff || []).map(s => ({ id: s.id, name: s.name }))
  const recognition = detectRecognition(msg.text, staffList)
  if (!recognition) return

  // Resolve name to staffId if individual
  if (recognition.recipientType === 'individual' && !recognition.recipientStaffId) {
    const match = staffList.find(s => s.name.toLowerCase() === recognition.recipientName?.toLowerCase())
    if (match) {
      recognition.recipientStaffId = match.id
      recognition.recipientName = match.name
    }
  }

  // Save recognition event
  const managerId = msg.from?.id
  await saveRecognitionEvent(groupId, managerId, recognition, db)

  // Format and send shoutout
  const managerName = msg.from?.first_name || 'Manager'
  const text = formatGroupShoutout(recognition, managerName)
  await bot.sendMessage(groupId, text, {
    parse_mode: 'Markdown',
    reply_to_message_id: msg.message_id,
  })

  // Save morale event for individual recipients
  if (recognition.recipientType === 'individual' && recognition.recipientStaffId) {
    const weekStart = getWeekStart()
    const moraleEvent = {
      type: 'recognition_received',
      sentiment: 'positive',
      weekStart,
    }
    if (db?.saveMoraleEvent) {
      await db.saveMoraleEvent(groupId, recognition.recipientStaffId, moraleEvent)
    } else {
      // Dynamic import to avoid circular dependencies
      const { saveMoraleEvent } = await import('../intelligence/moraleDb.js')
      await saveMoraleEvent(groupId, recognition.recipientStaffId, moraleEvent, db)
    }
  }
}

async function getStaffForGroup(groupId) {
  if (!supabase) return []
  const { data, error } = await supabase
    .from('staff')
    .select('id, name')
    .eq('group_id', groupId)
    .eq('active', true)
  if (error) throw error
  return data ?? []
}

// ── /kudos command handler ───────────────────────────────────────────────────

export async function handleRecognitionHistory(bot, msg, name, db = null) {
  const groupId = msg.chat.id

  if (!name || name.trim() === '') {
    // Show leaderboard
    const leaderboard = await getRecognitionLeaderboard(groupId, 4, db)
    if (leaderboard.length === 0) {
      await bot.sendMessage(groupId, 'No recognition events yet. Start giving shoutouts!')
      return
    }
    const lines = leaderboard.map((r, i) => `${i + 1}. ${r.staffName} \u2014 ${r.count} recognition${r.count > 1 ? 's' : ''}`)
    const text = `\u{1F3C6} *Recognition Leaderboard (last 4 weeks)*\n\n${lines.join('\n')}`
    await bot.sendMessage(groupId, text, { parse_mode: 'Markdown' })
  } else {
    // Show history for specific person
    const history = await getRecognitionHistory(groupId, null, 8, db)
    const filtered = history.filter(e => e.recipient_name?.toLowerCase() === name.trim().toLowerCase())
    if (filtered.length === 0) {
      await bot.sendMessage(groupId, `No recognition found for "${name.trim()}" in the last 8 weeks.`)
      return
    }
    const lines = filtered.map(e => {
      const date = new Date(e.created_at).toLocaleDateString()
      return `\u2022 ${date}: ${e.reason || e.original_text || 'Recognition'}`
    })
    const text = `\u{1F31F} *${name.trim()}'s Recognition History*\n\n${lines.join('\n')}`
    await bot.sendMessage(groupId, text, { parse_mode: 'Markdown' })
  }
}
