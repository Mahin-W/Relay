import { getDb } from '../db.js'
import { logger } from '../logger.js'

// Coverage-fill escalation cron.
//
// When a coverage request stays open with no volunteer, this sweep walks all
// open requests and advances them up a tier ladder, taking the appropriate
// action at each step:
//
//   tier 0  →  initial DMs (handled at request-creation time, not here)
//   tier 1  →  30-min reminder to everyone already outreached but unresponded
//   tier 2  →  60-min manager alert ("still uncovered after 1h")
//   tier 3  →  120-min urgent manager alert
//
// Tier state lives on `coverage_requests.escalation_tier` (default 0).
// Concurrency safety: each tier advance is a compare-and-swap UPDATE — if
// two cron instances race, only one sees its UPDATE return a row.

const TIER_THRESHOLDS_MIN = { 1: 30, 2: 60, 3: 120 }

function targetTierForAge(ageMin) {
  if (ageMin >= TIER_THRESHOLDS_MIN[3]) return 3
  if (ageMin >= TIER_THRESHOLDS_MIN[2]) return 2
  if (ageMin >= TIER_THRESHOLDS_MIN[1]) return 1
  return 0
}

// Exported for unit testing.
export { targetTierForAge }

// Detect whether `db` is the Supabase client or an abstract test store.
// Test stores expose mutable arrays directly (coverageRequests, etc.); supabase
// only exposes `.from()`/`.auth`/`.realtime`. We check for the array directly
// because Proxy-backed mock DBs may also resolve `db.from` as a function.
function isSupabase(db) {
  if (!db) return false
  if (Array.isArray(db.coverageRequests)) return false  // test store
  if (Array.isArray(db.scheduleAssignments)) return false  // test store
  return typeof db.from === 'function'
}

async function getOutreachedUsers(db, requestId) {
  if (!isSupabase(db)) {
    const rows = (db.coverageOutreach || []).filter(r => r.request_id === requestId)
    return [...new Set(rows.map(r => r.user_id).filter(Boolean))]
  }
  const { data, error } = await db
    .from('coverage_outreach')
    .select('user_id')
    .eq('request_id', requestId)
  if (error) {
    logger.error(`escalation: getOutreachedUsers(${requestId}) failed: ${error.message}`)
    return []
  }
  return [...new Set((data || []).map(r => r.user_id).filter(Boolean))]
}

async function getManagerDm(db, groupId) {
  if (!isSupabase(db)) {
    const row = (db.setupSessions || []).find(s => String(s.group_id) === String(groupId))
    if (!row) return null
    return { managerId: row.manager_id, dmChatId: row.dm_chat_id, groupName: row.group_name }
  }
  const { data, error } = await db
    .from('setup_sessions')
    .select('manager_id, dm_chat_id, group_name')
    .eq('group_id', groupId)
    .maybeSingle()
  if (error || !data) return null
  return { managerId: data.manager_id, dmChatId: data.dm_chat_id, groupName: data.group_name }
}

async function getStaffDmsByUserIds(db, userIds) {
  if (userIds.length === 0) return []
  if (!isSupabase(db)) {
    const idSet = new Set(userIds)
    return (db.staff || [])
      .filter(s => idSet.has(s.user_id) && s.dm_chat_id)
      .map(s => ({ user_id: s.user_id, first_name: s.name, dm_chat_id: s.dm_chat_id }))
  }
  const { data, error } = await db
    .from('staff_dms')
    .select('user_id, first_name, dm_chat_id')
    .in('user_id', userIds)
  if (error) {
    logger.error(`escalation: getStaffDmsByUserIds failed: ${error.message}`)
    return []
  }
  return data || []
}

function buildShiftLabel(req) {
  if (req.shift_description) return req.shift_description
  return 'shift'
}

async function recordOutreach(db, requestId, userId) {
  if (!isSupabase(db)) {
    db.coverageOutreach = db.coverageOutreach || []
    db.coverageOutreach.push({ request_id: requestId, user_id: userId, asked_at: new Date().toISOString() })
    return
  }
  await db.from('coverage_outreach').insert({ request_id: requestId, user_id: userId })
}

async function sendTier1Reminder(bot, req, db) {
  const outreachedUserIds = await getOutreachedUsers(db, req.id)
  // Don't ping the original requester back.
  const targets = outreachedUserIds.filter(uid => uid !== req.requester_telegram_id)
  if (targets.length === 0) {
    logger.bot(`escalation tier 1: no outreached users to remind for request ${req.id}`)
    return
  }
  const dms = await getStaffDmsByUserIds(db, targets)
  const shiftLabel = buildShiftLabel(req)
  const text =
    `⏰ *Reminder — coverage still needed*\n\n` +
    `*Shift:* ${shiftLabel}\n` +
    `*Requested by:* ${req.requested_by}\n\n` +
    `It's been 30 minutes and nobody has volunteered yet. Can you help?\n` +
    `Reply *yes* to cover ✋`
  for (const m of dms) {
    if (!m.dm_chat_id) continue
    try {
      await bot.sendMessage(m.dm_chat_id, text, { parse_mode: 'Markdown' })
      await recordOutreach(db, req.id, m.user_id)
    } catch (err) {
      logger.error(`escalation tier 1: DM to ${m.first_name} failed: ${err.message}`)
    }
  }
  logger.bot(`escalation tier 1: re-DMed ${dms.length} unresponsive staff for request ${req.id}`)
}

async function sendManagerAlert(bot, req, db, kind /* 'hour' | 'urgent' */) {
  const mgr = await getManagerDm(db, req.group_id)
  if (!mgr?.dmChatId) {
    logger.warn(`escalation: no manager DM on file for group ${req.group_id}; skipping alert`)
    return
  }
  const outreachedUserIds = await getOutreachedUsers(db, req.id)
  const askedCount = outreachedUserIds.length
  const shiftLabel = buildShiftLabel(req)
  const text = kind === 'urgent'
    ? `🚨 *URGENT — coverage still uncovered after 2 hours*\n\n` +
      `*Shift:* ${shiftLabel}\n` +
      `*Requested by:* ${req.requested_by}\n` +
      `*Staff asked:* ${askedCount}, none volunteered.\n\n` +
      `This shift starts soon and is unfilled. You may need to step in or assign someone manually.`
    : `🔔 *Coverage still uncovered after 1 hour*\n\n` +
      `*Shift:* ${shiftLabel}\n` +
      `*Requested by:* ${req.requested_by}\n` +
      `*Staff asked:* ${askedCount}, none volunteered.\n\n` +
      `If nobody responds in the next hour, I'll ping you again with a more urgent reminder.`
  try {
    await bot.sendMessage(mgr.dmChatId, text, { parse_mode: 'Markdown' })
    // Mark the manager-alert as an outreach row too, so visibility is consistent.
    if (mgr.managerId) {
      await recordOutreach(db, req.id, mgr.managerId)
    }
    logger.bot(`escalation tier ${kind === 'urgent' ? 3 : 2}: alerted manager for request ${req.id}`)
  } catch (err) {
    logger.error(`escalation: manager alert failed for request ${req.id}: ${err.message}`)
  }
}

// Compare-and-swap advance of the tier column. Returns true iff this caller
// won the race and should perform the tier action.
async function casAdvanceTier(database, requestId, fromTier, toTier) {
  if (!isSupabase(database)) {
    const row = (database.coverageRequests || []).find(r =>
      r.id === requestId && r.status === 'open' && (r.escalation_tier || 0) === fromTier)
    if (!row) return false
    row.escalation_tier = toTier
    return true
  }
  const { data, error } = await database
    .from('coverage_requests')
    .update({ escalation_tier: toTier })
    .eq('id', requestId)
    .eq('escalation_tier', fromTier)
    .eq('status', 'open')
    .select('id')
  if (error) {
    logger.error(`escalation: CAS advance ${requestId} ${fromTier}→${toTier} failed: ${error.message}`)
    return false
  }
  return Array.isArray(data) && data.length === 1
}

async function fetchOpenStale(database, cutoffIso) {
  if (!isSupabase(database)) {
    const cutoffMs = new Date(cutoffIso).getTime()
    return (database.coverageRequests || []).filter(r =>
      r.status === 'open' && new Date(r.created_at).getTime() < cutoffMs)
  }
  const { data, error } = await database
    .from('coverage_requests')
    .select('id, group_id, group_name, shift_description, requested_by, requester_telegram_id, matched_shift_id, week_start, created_at, escalation_tier')
    .eq('status', 'open')
    .lt('created_at', cutoffIso)
  if (error) {
    logger.error(`escalation sweep query failed: ${error.message}`)
    return null
  }
  return data || []
}

export async function runEscalationSweep(bot, opts = {}) {
  const database = opts.db || getDb()
  const cutoff = new Date(Date.now() - TIER_THRESHOLDS_MIN[1] * 60 * 1000).toISOString()
  const open = await fetchOpenStale(database, cutoff)
  if (open === null) return { processed: 0, advanced: 0 }

  let advanced = 0
  for (const req of open) {
    const ageMin = (Date.now() - new Date(req.created_at).getTime()) / 60000
    const target = targetTierForAge(ageMin)
    const current = req.escalation_tier || 0
    if (target <= current) continue

    // Advance one tier at a time so each tier gets its action even if the
    // sweep was offline through multiple thresholds.
    const next = current + 1
    const won = await casAdvanceTier(database, req.id, current, next)
    if (!won) continue
    advanced++

    try {
      if (next === 1) await sendTier1Reminder(bot, req, database)
      else if (next === 2) await sendManagerAlert(bot, req, database, 'hour')
      else if (next === 3) await sendManagerAlert(bot, req, database, 'urgent')
    } catch (err) {
      logger.error(`escalation: tier ${next} action failed for request ${req.id}: ${err.message}`)
    }
  }

  return { processed: open.length, advanced }
}
