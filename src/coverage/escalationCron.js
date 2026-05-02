import { createClient } from '@supabase/supabase-js'
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

let _supabase
function db() {
  if (!_supabase) _supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY)
  return _supabase
}

function targetTierForAge(ageMin) {
  if (ageMin >= TIER_THRESHOLDS_MIN[3]) return 3
  if (ageMin >= TIER_THRESHOLDS_MIN[2]) return 2
  if (ageMin >= TIER_THRESHOLDS_MIN[1]) return 1
  return 0
}

// Exported for unit testing.
export { targetTierForAge }

async function getOutreachedUsers(supabase, requestId) {
  const { data, error } = await supabase
    .from('coverage_outreach')
    .select('user_id')
    .eq('request_id', requestId)
  if (error) {
    logger.error(`escalation: getOutreachedUsers(${requestId}) failed: ${error.message}`)
    return []
  }
  return [...new Set((data || []).map(r => r.user_id).filter(Boolean))]
}

async function getManagerDm(supabase, groupId) {
  const { data, error } = await supabase
    .from('setup_sessions')
    .select('manager_id, dm_chat_id, group_name')
    .eq('group_id', groupId)
    .maybeSingle()
  if (error || !data) return null
  return { managerId: data.manager_id, dmChatId: data.dm_chat_id, groupName: data.group_name }
}

async function getStaffDmsByUserIds(supabase, userIds) {
  if (userIds.length === 0) return []
  const { data, error } = await supabase
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

async function sendTier1Reminder(bot, req, supabase) {
  const outreachedUserIds = await getOutreachedUsers(supabase, req.id)
  // Don't ping the original requester back.
  const targets = outreachedUserIds.filter(uid => uid !== req.requester_telegram_id)
  if (targets.length === 0) {
    logger.bot(`escalation tier 1: no outreached users to remind for request ${req.id}`)
    return
  }
  const dms = await getStaffDmsByUserIds(supabase, targets)
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
      // Record this re-outreach so future cron runs see the timestamp.
      await supabase.from('coverage_outreach').insert({ request_id: req.id, user_id: m.user_id })
    } catch (err) {
      logger.error(`escalation tier 1: DM to ${m.first_name} failed: ${err.message}`)
    }
  }
  logger.bot(`escalation tier 1: re-DMed ${dms.length} unresponsive staff for request ${req.id}`)
}

async function sendManagerAlert(bot, req, supabase, kind /* 'hour' | 'urgent' */) {
  const mgr = await getManagerDm(supabase, req.group_id)
  if (!mgr?.dmChatId) {
    logger.warn(`escalation: no manager DM on file for group ${req.group_id}; skipping alert`)
    return
  }
  const outreachedUserIds = await getOutreachedUsers(supabase, req.id)
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
      await supabase.from('coverage_outreach').insert({ request_id: req.id, user_id: mgr.managerId })
    }
    logger.bot(`escalation tier ${kind === 'urgent' ? 3 : 2}: alerted manager for request ${req.id}`)
  } catch (err) {
    logger.error(`escalation: manager alert failed for request ${req.id}: ${err.message}`)
  }
}

// Compare-and-swap advance of the tier column. Returns true iff this caller
// won the race and should perform the tier action.
async function casAdvanceTier(supabase, requestId, fromTier, toTier) {
  const { data, error } = await supabase
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

export async function runEscalationSweep(bot, opts = {}) {
  const supabase = opts.db || db()
  const cutoff = new Date(Date.now() - TIER_THRESHOLDS_MIN[1] * 60 * 1000).toISOString()
  const { data: open, error } = await supabase
    .from('coverage_requests')
    .select('id, group_id, group_name, shift_description, requested_by, requester_telegram_id, matched_shift_id, week_start, created_at, escalation_tier')
    .eq('status', 'open')
    .lt('created_at', cutoff)
  if (error) {
    logger.error(`escalation sweep query failed: ${error.message}`)
    return { processed: 0, advanced: 0 }
  }

  let advanced = 0
  for (const req of open || []) {
    const ageMin = (Date.now() - new Date(req.created_at).getTime()) / 60000
    const target = targetTierForAge(ageMin)
    const current = req.escalation_tier || 0
    if (target <= current) continue

    // Advance one tier at a time so each tier gets its action even if the
    // sweep was offline through multiple thresholds.
    const next = current + 1
    const won = await casAdvanceTier(supabase, req.id, current, next)
    if (!won) continue
    advanced++

    try {
      if (next === 1) await sendTier1Reminder(bot, req, supabase)
      else if (next === 2) await sendManagerAlert(bot, req, supabase, 'hour')
      else if (next === 3) await sendManagerAlert(bot, req, supabase, 'urgent')
    } catch (err) {
      logger.error(`escalation: tier ${next} action failed for request ${req.id}: ${err.message}`)
    }
  }

  return { processed: (open || []).length, advanced }
}
