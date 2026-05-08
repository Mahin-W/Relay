import { getDb } from '../db.js'

// ── Pure helpers ──────────────────────────────────────────────────────────────

/**
 * Fuzzy match a query against an array of staff name strings.
 * Case-insensitive partial match. Returns first match or null.
 */
export function fuzzyMatchStaffName(query, staffNames) {
  if (!query || !staffNames?.length) return null
  const q = query.toLowerCase()
  return staffNames.find(name => name.toLowerCase().includes(q)) ?? null
}

/**
 * Extract a time token from text (e.g. "11pm", "10:30", "5pm", "9am").
 * Returns the matched string or null.
 */
function extractTime(text) {
  const m = text.match(/\b(\d{1,2}:\d{2}(?:\s*[ap]m)?|\d{1,2}\s*[ap]m)\b/i)
  return m ? m[0].trim() : null
}

/**
 * Detect a manager override intent from plain text.
 * Returns { action, staffName, time } or null.
 * Pure function — no LLM.
 */
export function detectClockOverride(text, staffNames) {
  if (!text || !staffNames?.length) return null

  const lower = text.toLowerCase()

  // ── adjust: "fix [name]'s clock out to [time]" or "change [name]'s clock out to [time]"
  const adjustMatch = lower.match(/(?:fix|change)\s+(\w+)'?s?\s+clock\s+out\s+to\s+/i)
  if (adjustMatch) {
    const nameToken = adjustMatch[1]
    const staffName = fuzzyMatchStaffName(nameToken, staffNames)
    if (staffName) {
      return { action: 'adjust', staffName, time: extractTime(text) }
    }
  }

  // ── clock_in: "clock in [name] at [time]" or "[name] clocked in at [time]"
  const clockInAt = lower.match(/clock\s+in\s+(\w+)\s+at\s+/i)
  if (clockInAt) {
    const nameToken = clockInAt[1]
    const staffName = fuzzyMatchStaffName(nameToken, staffNames)
    if (staffName) {
      return { action: 'clock_in', staffName, time: extractTime(text) }
    }
  }

  const clockedInAt = lower.match(/(\w+)\s+clocked\s+in\s+at\s+/i)
  if (clockedInAt) {
    const nameToken = clockedInAt[1]
    const staffName = fuzzyMatchStaffName(nameToken, staffNames)
    if (staffName) {
      return { action: 'clock_in', staffName, time: extractTime(text) }
    }
  }

  // ── clock_out: "clock out [name]" or "[name] forgot to clock out" or "clock out [name] now"
  const clockOutExplicit = lower.match(/clock\s+out\s+(\w+)/i)
  if (clockOutExplicit) {
    const nameToken = clockOutExplicit[1]
    const staffName = fuzzyMatchStaffName(nameToken, staffNames)
    if (staffName) {
      return { action: 'clock_out', staffName, time: extractTime(text) }
    }
  }

  const forgotMatch = lower.match(/(\w+)\s+forgot\s+to\s+clock\s+out/i)
  if (forgotMatch) {
    const nameToken = forgotMatch[1]
    const staffName = fuzzyMatchStaffName(nameToken, staffNames)
    if (staffName) {
      return { action: 'clock_out', staffName, time: extractTime(text) }
    }
  }

  return null
}

// ── DB operations ─────────────────────────────────────────────────────────────

/**
 * Update the most recent open time_entry for a staff member (clock_out IS NULL).
 */
export async function manualClockOut(staffId, groupId, time, db = null) {
  try {
    if (db?.manualClockOut) return db.manualClockOut(staffId, groupId, time)

    const supabase = getDb()
    // Find most recent open entry
    const { data: entry, error: findErr } = await supabase
      .from('time_entries')
      .select('id')
      .eq('staff_id', staffId)
      .eq('group_id', groupId)
      .is('clock_out', null)
      .order('clock_in', { ascending: false })
      .limit(1)
      .maybeSingle()

    if (findErr) throw findErr
    if (!entry) return null

    const { data, error } = await supabase
      .from('time_entries')
      .update({ clock_out: new Date(time).toISOString() })
      .eq('id', entry.id)
      .select()
      .single()

    if (error) throw error
    return data
  } catch (err) {
    console.error(`manualClockOut failed: ${err.message}`)
    return null
  }
}

/**
 * Insert a new time_entry with is_manual=true.
 */
export async function manualClockIn(staffId, groupId, time, db = null) {
  try {
    if (db?.manualClockIn) return db.manualClockIn(staffId, groupId, time)

    const supabase = getDb()
    const { data, error } = await supabase
      .from('time_entries')
      .insert({
        staff_id: staffId,
        group_id: groupId,
        clock_in: new Date(time).toISOString(),
        is_manual: true,
      })
      .select()
      .single()

    if (error) throw error
    return data
  } catch (err) {
    console.error(`manualClockIn failed: ${err.message}`)
    return null
  }
}

/**
 * Insert a row into manager_log_entries.
 */
export async function logManagerAction(groupId, managerId, entryText, db = null) {
  try {
    if (db?.logManagerAction) return db.logManagerAction(groupId, managerId, entryText)

    const supabase = getDb()
    const { error } = await supabase
      .from('manager_log_entries')
      .insert({ group_id: groupId, manager_id: managerId, entry_text: entryText })

    if (error) throw error
  } catch (err) {
    console.error(`logManagerAction failed: ${err.message}`)
  }
}

// ── handleClockOverride ───────────────────────────────────────────────────────

/**
 * Find open time_entry for a staff member (clock_out IS NULL).
 * Uses db injection when provided.
 */
async function getOpenClockEntry(staffId, groupId, db) {
  if (db?.getOpenClockEntry) return db.getOpenClockEntry(staffId, groupId)

  try {
    const supabase = getDb()
    const { data, error } = await supabase
      .from('time_entries')
      .select('*')
      .eq('staff_id', staffId)
      .eq('group_id', groupId)
      .is('clock_out', null)
      .order('clock_in', { ascending: false })
      .limit(1)
      .maybeSingle()
    if (error) throw error
    return data
  } catch (err) {
    console.error(`getOpenClockEntry failed: ${err.message}`)
    return null
  }
}

/**
 * Get most recent time entry for a staff member.
 */
async function getMostRecentEntry(staffId, groupId, db) {
  if (db?.getMostRecentEntry) return db.getMostRecentEntry(staffId, groupId)

  try {
    const supabase = getDb()
    const { data, error } = await supabase
      .from('time_entries')
      .select('*')
      .eq('staff_id', staffId)
      .eq('group_id', groupId)
      .order('clock_in', { ascending: false })
      .limit(1)
      .maybeSingle()
    if (error) throw error
    return data
  } catch (err) {
    console.error(`getMostRecentEntry failed: ${err.message}`)
    return null
  }
}

/**
 * Format hours from two Date objects.
 */
function calcHours(clockIn, clockOut) {
  const ms = new Date(clockOut) - new Date(clockIn)
  return (ms / 3600000).toFixed(1)
}

/**
 * Handle a clock override command from a manager.
 *
 * @param {object} bot - Telegram bot instance
 * @param {object} msg - Telegram message object
 * @param {object} intent - { action, staffName, time } from detectClockOverride
 * @param {Array}  staff - Array of { id, name, role } staff objects
 * @param {object|null} db - Optional injected db for testing
 */
export async function handleClockOverride(bot, msg, intent, staff, db = null) {
  const _getOpenClockEntry = db?.getOpenClockEntry != null
    ? (staffId, groupId) => db.getOpenClockEntry(staffId, groupId)
    : (staffId, groupId) => getOpenClockEntry(staffId, groupId, null)

  const _manualClockOut = db?.manualClockOut != null
    ? (staffId, groupId, time) => db.manualClockOut(staffId, groupId, time)
    : (staffId, groupId, time) => manualClockOut(staffId, groupId, time, null)

  const _manualClockIn = db?.manualClockIn != null
    ? (staffId, groupId, time) => db.manualClockIn(staffId, groupId, time)
    : (staffId, groupId, time) => manualClockIn(staffId, groupId, time, null)

  const _logManagerAction = db?.logManagerAction != null
    ? (groupId, managerId, text) => db.logManagerAction(groupId, managerId, text)
    : (groupId, managerId, text) => logManagerAction(groupId, managerId, text, null)

  const _getMostRecentEntry = db?.getMostRecentEntry != null
    ? (staffId, groupId) => db.getMostRecentEntry(staffId, groupId)
    : (staffId, groupId) => getMostRecentEntry(staffId, groupId, null)

  try {
    const chatId = msg.chat.id
    const userId = msg.from.id

    // 1. Check admin
    const member = await bot.getChatMember(chatId, userId)
    if (member.status !== 'administrator' && member.status !== 'creator') {
      return
    }

    // 2. Find matching staff
    const matches = staff.filter(s =>
      s.name.toLowerCase().includes(intent.staffName.toLowerCase())
    )

    // 3. 0 matches
    if (matches.length === 0) {
      await bot.sendMessage(chatId, `Couldn't find ${intent.staffName}.`)
      return
    }

    // 4. >1 matches — disambiguation
    if (matches.length > 1) {
      const list = matches.map((s, i) => `${i + 1}. ${s.name} (${s.role})`).join('\n')
      await bot.sendMessage(chatId, `Which ${intent.staffName}?\n${list}\nReply 1 or 2.`)
      return
    }

    // 5. Exactly 1 match
    const matched = matches[0]
    const groupId = String(chatId)
    const now = new Date().toISOString()

    if (intent.action === 'clock_out') {
      const entry = await _getOpenClockEntry(matched.id, groupId)
      if (!entry) {
        await bot.sendMessage(chatId, `${matched.name} isn't currently clocked in.`)
        return
      }

      const clockOutTime = intent.time ? new Date(intent.time).toISOString() : now
      await _manualClockOut(matched.id, groupId, clockOutTime)

      const hours = calcHours(entry.clock_in, clockOutTime)
      const displayTime = intent.time ?? 'now'
      await bot.sendMessage(chatId, `✅ Clocked out ${matched.name} at ${displayTime}. (${hours}hrs logged)`)
      await _logManagerAction(groupId, userId, `Clocked out ${matched.name} at ${displayTime}`)

    } else if (intent.action === 'adjust') {
      const entry = await _getMostRecentEntry(matched.id, groupId)
      if (!entry) {
        await bot.sendMessage(chatId, `No time entries found for ${matched.name}.`)
        return
      }

      const inTime = new Date(entry.clock_in).toLocaleTimeString()
      const outTime = entry.clock_out
        ? new Date(entry.clock_out).toLocaleTimeString()
        : 'still in'

      await bot.sendMessage(
        chatId,
        `${matched.name}: clocked in ${inTime}, out ${outTime}\n` +
        `Adjust clock out to ${intent.time}?\nReply yes to confirm.`
      )
      // Note: confirmation flow requires conversation state management
      // which is handled by the broader bot infrastructure.

    } else if (intent.action === 'clock_in') {
      const clockInTime = intent.time ? intent.time : now
      await _manualClockIn(matched.id, groupId, clockInTime)
      await bot.sendMessage(chatId, `✅ Created clock-in for ${matched.name} at ${clockInTime}.`)
      await _logManagerAction(groupId, userId, `Manual clock-in for ${matched.name} at ${clockInTime}`)
    }

  } catch (err) {
    console.error(`handleClockOverride failed: ${err.message}`)
  }
}
