import { getDb } from '../db.js'
import { logger } from '../logger.js'

// ── FOH / BOH role classification ─────────────────────────────────────────────

const FOH_ROLES = new Set([
  'server', 'waiter', 'waitress', 'bartender', 'bar',
  'host', 'hostess', 'runner', 'busser', 'barback',
])

const BOH_ROLES = new Set([
  'cook', 'chef', 'prep', 'dishwasher', 'dish',
  'line', 'kitchen', 'expo',
])

const ROLE_POINTS = {
  server: 3, waiter: 3, waitress: 3,
  bartender: 3, bar: 3,
  runner: 1.5, busser: 1.5, barback: 1.5,
  host: 1, hostess: 1,
  cook: 2, chef: 2, prep: 2,
  dishwasher: 1, dish: 1,
  line: 2, kitchen: 2, expo: 1.5,
}

const DEFAULT_POINTS = 1

// ── parseTipMessage (pure, no LLM) ───────────────────────────────────────────

export function parseTipMessage(text) {
  if (!text || typeof text !== 'string') return null
  const t = text.trim()
  if (!t) return null

  // Match dollar amounts with optional comma separators or k suffix
  // Patterns: $840, $1,200, $1.2k, 840 tips, tips: 650, tips were $840
  let totalTips = null
  let shiftReference = null

  // BH.11: reject if a minus/negative sign appears directly before the number
  if (/[-−]\s*\$?\d/.test(t)) return null

  // Try $Nk pattern first: $1.2k, $2.5k
  const kMatch = t.match(/\$(\d+(?:\.\d+)?)k\b/i)
  if (kMatch) {
    totalTips = parseFloat(kMatch[1]) * 1000
  }

  // Try $N,NNN (with commas) or $NNNN (plain digits) pattern.
  // Formatted variant first so "$1,140" captures the full number instead of "$1".
  if (totalTips === null) {
    const dollarMatch = t.match(/\$(\d{1,3}(?:,\d{3})+(?:\.\d{1,2})?|\d+(?:\.\d{1,2})?)/)
    if (dollarMatch) {
      totalTips = parseFloat(dollarMatch[1].replace(/,/g, ''))
    }
  }

  // Try "N tips" or "tips: N" or "tips N"
  if (totalTips === null) {
    const numPat = '(\\d{1,3}(?:,\\d{3})+(?:\\.\\d{1,2})?|\\d+(?:\\.\\d{1,2})?)'
    const tipsMatch = t.match(new RegExp(`${numPat}\\s*tips\\b`, 'i'))
      || t.match(new RegExp(`tips\\s*[:]\\s*${numPat}`, 'i'))
    if (tipsMatch) {
      totalTips = parseFloat(tipsMatch[1].replace(/,/g, ''))
    }
  }

  if (totalTips === null || totalTips <= 0) return null

  // Extract shift reference: "from Friday dinner", "for lunch shift"
  const refMatch = t.match(/(?:from|for)\s+(.+?)$/i)
  if (refMatch) {
    shiftReference = refMatch[1].trim()
  }

  return { totalTips, ...(shiftReference ? { shiftReference } : {}) }
}

// ── calculateTipSplit (pure) ─────────────────────────────────────────────────

export function calculateTipSplit(totalTips, staff, splitMethod) {
  // BH.11: guard against invalid or negative totals
  if (!Number.isFinite(totalTips) || totalTips <= 0) return []
  if (!staff || staff.length === 0) return []
  if (staff.length === 1) {
    return [{ ...staff[0], amount: totalTips }]
  }

  let rawAmounts

  if (splitMethod === 'equal') {
    const base = totalTips / staff.length
    rawAmounts = staff.map(() => base)
  } else if (splitMethod === 'points') {
    const points = staff.map(s => {
      const key = (s.roleName || '').toLowerCase()
      const pts = ROLE_POINTS[key] ?? DEFAULT_POINTS
      return pts * (s.hoursWorked || 0)
    })
    const totalPoints = points.reduce((a, b) => a + b, 0)
    if (totalPoints === 0) {
      rawAmounts = staff.map(() => totalTips / staff.length)
    } else {
      rawAmounts = points.map(p => (p / totalPoints) * totalTips)
    }
  } else {
    // 'hours' (default)
    // E.01: clamp negative hoursWorked to 0 before computing weights
    const clampedHours = staff.map(s => Math.max(0, s.hoursWorked || 0))
    const totalHours = clampedHours.reduce((a, b) => a + b, 0)
    if (totalHours === 0) {
      // BH.11 / E.01: zero-hour fallback → equal split to avoid NaN/Infinity
      rawAmounts = staff.map(() => totalTips / staff.length)
    } else {
      rawAmounts = clampedHours.map(h => (h / totalHours) * totalTips)
    }
  }

  // Round each to 2 decimals
  const rounded = rawAmounts.map(a => Math.round(a * 100) / 100)

  // Fix rounding remainder: adjust highest earner (integer cents to avoid float errors)
  const sumCents = rounded.reduce((a, b) => a + Math.round(b * 100), 0)
  const totalCents = Math.round(totalTips * 100)
  const diff = (totalCents - sumCents) / 100

  if (diff !== 0) {
    // Find highest earner index
    let maxIdx = 0
    for (let i = 1; i < rounded.length; i++) {
      if (rounded[i] > rounded[maxIdx]) maxIdx = i
    }
    rounded[maxIdx] = Math.round((rounded[maxIdx] + diff) * 100) / 100
  }

  return staff.map((s, i) => ({ ...s, amount: rounded[i] }))
}

// ── getTipEligibleStaff ──────────────────────────────────────────────────────

export async function getTipEligibleStaff(groupId, shiftId, shiftDate, bohIncluded, db = null) {
  const _getRoster = db?.getShiftRosterWithHours
    ? (sid, sd) => db.getShiftRosterWithHours(sid, sd)
    : (sid, sd) => getShiftRosterWithHours(sid, sd)

  const roster = await _getRoster(shiftId, shiftDate)

  return roster.filter(s => {
    const role = (s.roleName || '').toLowerCase()
    if (FOH_ROLES.has(role)) return true
    if (BOH_ROLES.has(role)) return bohIncluded
    // Unknown role: included always
    return true
  })
}

// Supabase fallback for roster lookup
async function getShiftRosterWithHours(shiftId, shiftDate) {
  try {
    const { data, error } = await getDb()
      .from('schedule_assignments')
      .select('staff_id, staff:staff_id(id, name, role)')
      .eq('shift_id', shiftId)
      .eq('week_start', shiftDate)
    if (error) throw error
    return (data || []).map(a => ({
      staffId: a.staff?.id,
      staffName: a.staff?.name || 'Unknown',
      roleName: a.staff?.role || 'Staff',
      hoursWorked: 0, // will be enriched from time entries
    }))
  } catch (err) {
    logger.error(`getShiftRosterWithHours failed: ${err.message}`)
    return []
  }
}

// ── Tip settings DB ──────────────────────────────────────────────────────────

const TIP_DEFAULTS = { mode: 'pool', splitMethod: 'hours', bohIncluded: false }

export async function saveTipSettings(groupId, settings, db = null) {
  if (db?.saveTipSettings) return db.saveTipSettings(groupId, settings)
  try {
    const { data, error } = await getDb()
      .from('restaurant_tip_settings')
      .upsert(
        {
          group_id: groupId,
          mode: settings.mode,
          split_method: settings.splitMethod,
          boh_included: settings.bohIncluded,
          updated_at: new Date().toISOString(),
        },
        { onConflict: 'group_id' }
      )
      .select()
      .single()
    if (error) throw error
    logger.db(`Tip settings saved for group ${groupId}`)
    return data
  } catch (err) {
    logger.error(`saveTipSettings failed: ${err.message}`)
    return null
  }
}

export async function getTipSettings(groupId, db = null) {
  if (db?.getTipSettings) {
    const result = await db.getTipSettings(groupId)
    return result ?? { ...TIP_DEFAULTS }
  }
  try {
    const { data, error } = await getDb()
      .from('restaurant_tip_settings')
      .select('*')
      .eq('group_id', groupId)
      .maybeSingle()
    if (error) throw error
    if (!data) return { ...TIP_DEFAULTS }
    return {
      mode: data.mode ?? TIP_DEFAULTS.mode,
      splitMethod: data.split_method ?? TIP_DEFAULTS.splitMethod,
      bohIncluded: data.boh_included ?? TIP_DEFAULTS.bohIncluded,
    }
  } catch (err) {
    logger.error(`getTipSettings failed: ${err.message}`)
    return { ...TIP_DEFAULTS }
  }
}

// ── Tip records DB ───────────────────────────────────────────────────────────

export async function saveTipRecord(groupId, shiftId, shiftDate, totalTips, splits, splitMethod, mode, db = null) {
  if (db?.saveTipRecord) return db.saveTipRecord(groupId, shiftId, shiftDate, totalTips, splits, splitMethod, mode)
  try {
    const { data, error } = await getDb()
      .from('tip_records')
      .insert({
        group_id: groupId,
        shift_id: shiftId,
        shift_date: shiftDate,
        total_tips: totalTips,
        splits: JSON.stringify(splits),
        split_method: splitMethod,
        mode,
        created_at: new Date().toISOString(),
      })
      .select()
      .single()
    if (error) throw error
    logger.db(`Tip record saved for group ${groupId}: $${totalTips}`)
    return data
  } catch (err) {
    logger.error(`saveTipRecord failed: ${err.message}`)
    return null
  }
}

export async function getTipHistory(groupId, weeksBack = 4, db = null) {
  if (db?.getTipHistory) return db.getTipHistory(groupId, weeksBack)
  try {
    const since = new Date()
    since.setDate(since.getDate() - weeksBack * 7)
    const { data, error } = await getDb()
      .from('tip_records')
      .select('*')
      .eq('group_id', groupId)
      .gte('shift_date', since.toISOString().slice(0, 10))
      .order('shift_date', { ascending: false })
    if (error) throw error
    return data || []
  } catch (err) {
    logger.error(`getTipHistory failed: ${err.message}`)
    return []
  }
}

// ── formatTipSplit (pure) ────────────────────────────────────────────────────

export function formatTipSplit(totalTips, splits, tipSettings) {
  if (tipSettings.mode === 'cash') {
    return `💰 *Cash tips logged:* $${totalTips.toLocaleString()}\nTip amount recorded for tracking purposes.`
  }

  if (tipSettings.mode === 'individual') {
    return `💰 *Individual tips:* $${totalTips.toLocaleString()}\nStaff keep their own tips — amount recorded for tracking.`
  }

  // Pool mode
  const methodLabel = tipSettings.splitMethod === 'hours' ? 'by hours worked'
    : tipSettings.splitMethod === 'equal' ? 'split equally'
    : 'by role points'

  let text = `💰 *Tip Pool Split* (${methodLabel})\n`
  text += `Total: $${totalTips.toLocaleString()}\n\n`

  for (const s of splits) {
    text += `• ${s.staffName} (${s.roleName}, ${s.hoursWorked}h): *$${s.amount.toFixed(2)}*\n`
  }

  const sum = splits.reduce((a, x) => a + x.amount, 0)
  text += `\n✅ Sum: $${sum.toFixed(2)}`
  return text
}

// ── Manager group lookup ─────────────────────────────────────────────────────

async function getManagerGroup(userId, db = null) {
  if (db?.getManagerGroup) return db.getManagerGroup(userId)
  try {
    const { data, error } = await getDb()
      .from('setup_sessions')
      .select('group_id, group_name')
      .eq('manager_id', userId)
      .eq('setup_complete', true)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle()
    if (error) throw error
    return data
  } catch (err) {
    logger.error(`getManagerGroup failed: ${err.message}`)
    return null
  }
}

// ── handleTipMessage (DM handler) ────────────────────────────────────────────

export async function handleTipMessage(bot, msg, db = null) {
  const parsed = parseTipMessage(msg.text)
  if (!parsed) return false

  const chatId = msg.chat.id
  const userId = msg.from.id

  const _getManagerGroup = db?.getManagerGroup
    ? (uid) => db.getManagerGroup(uid)
    : (uid) => getManagerGroup(uid, db)

  const group = await _getManagerGroup(userId)
  if (!group) {
    await bot.sendMessage(chatId, `No setup found for your account. Run /setup first.`)
    return true
  }

  const _getTipSettings = db?.getTipSettings
    ? (gid) => db.getTipSettings(gid)
    : (gid) => getTipSettings(gid, db)

  const tipSettings = await _getTipSettings(group.group_id)

  const _saveTipRecord = db?.saveTipRecord
    ? (gid, sid, sd, t, sp, m, mo) => db.saveTipRecord(gid, sid, sd, t, sp, m, mo)
    : (gid, sid, sd, t, sp, m, mo) => saveTipRecord(gid, sid, sd, t, sp, m, mo, db)

  if (tipSettings.mode === 'individual') {
    await bot.sendMessage(chatId,
      formatTipSplit(parsed.totalTips, [], tipSettings),
      { parse_mode: 'Markdown' })
    return true
  }

  if (tipSettings.mode === 'cash') {
    await _saveTipRecord(group.group_id, null, new Date().toISOString().slice(0, 10),
      parsed.totalTips, [], 'cash', 'cash')
    await bot.sendMessage(chatId,
      formatTipSplit(parsed.totalTips, [], tipSettings),
      { parse_mode: 'Markdown' })
    return true
  }

  // Pool mode
  const _getEligibleStaff = db?.getTipEligibleStaff
    ? (gid, sid, sd, boh) => db.getTipEligibleStaff(gid, sid, sd, boh)
    : (gid, sid, sd, boh) => getTipEligibleStaff(gid, sid, sd, boh, db)

  const eligible = await _getEligibleStaff(
    group.group_id, null, new Date().toISOString().slice(0, 10), tipSettings.bohIncluded
  )

  if (eligible.length === 0) {
    await bot.sendMessage(chatId,
      `No staff found for tip split. Make sure your schedule is set up.`)
    return true
  }

  const splits = calculateTipSplit(parsed.totalTips, eligible, tipSettings.splitMethod)

  await _saveTipRecord(group.group_id, null, new Date().toISOString().slice(0, 10),
    parsed.totalTips, splits, tipSettings.splitMethod, 'pool')

  await bot.sendMessage(chatId,
    formatTipSplit(parsed.totalTips, splits, tipSettings),
    { parse_mode: 'Markdown' })

  return true
}

// ── handleTipModeCommand ─────────────────────────────────────────────────────

const VALID_MODES = new Set(['pool', 'individual', 'cash'])
const VALID_METHODS = new Set(['hours', 'equal', 'points'])

export async function handleTipModeCommand(bot, msg, args, db = null) {
  const chatId = msg.chat.id
  const userId = msg.from.id

  const _getManagerGroup = db?.getManagerGroup
    ? (uid) => db.getManagerGroup(uid)
    : (uid) => getManagerGroup(uid, db)

  const group = await _getManagerGroup(userId)
  if (!group) {
    await bot.sendMessage(chatId, `No setup found. Run /setup first.`)
    return
  }

  const _getTipSettings = db?.getTipSettings
    ? (gid) => db.getTipSettings(gid)
    : (gid) => getTipSettings(gid, db)

  const _saveTipSettings = db?.saveTipSettings
    ? (gid, s) => db.saveTipSettings(gid, s)
    : (gid, s) => saveTipSettings(gid, s, db)

  const current = await _getTipSettings(group.group_id)

  // No args: show current settings
  if (!args || args.length === 0) {
    await bot.sendMessage(chatId,
      `💰 *Current tip settings:*\n` +
      `• Mode: ${current.mode}\n` +
      `• Split method: ${current.splitMethod}\n` +
      `• BOH included: ${current.bohIncluded ? 'yes' : 'no'}`,
      { parse_mode: 'Markdown' })
    return
  }

  const first = args[0].toLowerCase()

  // Handle "boh on/off"
  if (first === 'boh') {
    const toggle = (args[1] || '').toLowerCase()
    if (toggle === 'on' || toggle === 'off') {
      const updated = { ...current, bohIncluded: toggle === 'on' }
      await _saveTipSettings(group.group_id, updated)
      await bot.sendMessage(chatId,
        `✅ BOH staff ${toggle === 'on' ? 'included in' : 'excluded from'} tip pool.`)
      return
    }
  }

  // Handle mode change
  if (VALID_MODES.has(first)) {
    const updated = { ...current, mode: first }
    await _saveTipSettings(group.group_id, updated)
    await bot.sendMessage(chatId, `✅ Tip mode updated to *${first}*.`, { parse_mode: 'Markdown' })
    return
  }

  // Handle split method change
  if (VALID_METHODS.has(first)) {
    const updated = { ...current, splitMethod: first }
    await _saveTipSettings(group.group_id, updated)
    await bot.sendMessage(chatId, `✅ Split method updated to *${first}*.`, { parse_mode: 'Markdown' })
    return
  }

  // Invalid
  await bot.sendMessage(chatId,
    `Usage: /tipmode [pool|individual|cash|hours|equal|points|boh on|boh off]\n\n` +
    `Options:\n` +
    `• pool / individual / cash — tip mode\n` +
    `• hours / equal / points — split method\n` +
    `• boh on / boh off — include back-of-house`)
}

// ── handleTipHistory ─────────────────────────────────────────────────────────

export async function handleTipHistory(bot, msg, db = null) {
  const chatId = msg.chat.id
  const userId = msg.from.id

  const _getManagerGroup = db?.getManagerGroup
    ? (uid) => db.getManagerGroup(uid)
    : (uid) => getManagerGroup(uid, db)

  const group = await _getManagerGroup(userId)
  if (!group) {
    await bot.sendMessage(chatId, `No setup found. Run /setup first.`)
    return
  }

  const _getTipHistory = db?.getTipHistory
    ? (gid, w) => db.getTipHistory(gid, w)
    : (gid, w) => getTipHistory(gid, w, db)

  const records = await _getTipHistory(group.group_id, 4)

  if (!records || records.length === 0) {
    await bot.sendMessage(chatId, `No tip records found in the last 4 weeks.`)
    return
  }

  let text = `💰 *Tip History (last 4 weeks):*\n\n`
  for (const r of records) {
    const date = r.shift_date || 'Unknown'
    text += `• ${date}: $${r.total_tips} (${r.split_method})\n`
  }

  await bot.sendMessage(chatId, text, { parse_mode: 'Markdown' })
}
