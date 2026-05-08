import { getDb } from '../db.js'

// ── Time parsing ──────────────────────────────────────────────────────────────

/**
 * Parse end_time string like "22:00", "10:30 PM", "11pm", "9:00 AM"
 * Returns { hours, minutes } in 24h format.
 */
function parseEndTime(endTimeStr) {
  if (!endTimeStr) return { hours: 0, minutes: 0 }

  const str = String(endTimeStr).trim().toLowerCase()

  // Match formats like "22:00" or "10:30 pm" or "11pm" or "9am"
  const match = str.match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/)
  if (!match) return { hours: 0, minutes: 0 }

  let hours = parseInt(match[1], 10)
  const minutes = parseInt(match[2] ?? '0', 10)
  const meridiem = match[3]

  if (meridiem === 'pm' && hours !== 12) hours += 12
  if (meridiem === 'am' && hours === 12) hours = 0

  return { hours, minutes }
}

/**
 * Build a Date for today at the shift's end_time.
 * Uses the `now` reference date for "today".
 */
function buildShiftEndDatetime(endTimeStr, now) {
  const { hours, minutes } = parseEndTime(endTimeStr)
  const d = new Date(now)
  d.setHours(hours, minutes, 0, 0)
  return d
}

// ── DB layer ──────────────────────────────────────────────────────────────────

/**
 * Real Supabase query: find open time_entries for groupId where
 * alerted_at is NULL and clock_out is NULL.
 * Returns raw rows with joined shift/staff/dm data.
 */
async function _fetchOpenEntries(groupId) {
  try {
    const supabase = getDb()
    // Supabase JS doesn't support multi-table JOINs in a single .from() call,
    // so we use PostgREST's embedded resource syntax via rpc or a view.
    // Here we use a plain select with embedded relationships (PostgREST syntax).
    const { data, error } = await supabase
      .from('time_entries')
      .select(`
        id,
        user_id,
        staff_id,
        shift_id,
        clock_in,
        alerted_at,
        shifts ( name, end_time, day_of_week ),
        staff ( name ),
        staff_dms ( dm_chat_id )
      `)
      .eq('group_id', groupId)
      .is('clock_out', null)
      .is('alerted_at', null)

    if (error) throw error
    return data ?? []
  } catch (err) {
    console.error(`_fetchOpenEntries failed: ${err.message}`)
    return []
  }
}

/**
 * Map a raw Supabase row to the standard entry shape.
 */
function _mapRow(row) {
  return {
    staffId: row.staff_id,
    staffName: row.staff?.name ?? 'Unknown',
    dmChatId: row.staff_dms?.dm_chat_id ?? null,
    shiftName: row.shifts?.name ?? 'Unknown Shift',
    shiftEndTime: row.shifts?.end_time ?? '00:00',
    clockInTime: new Date(row.clock_in),
    clockEntryId: row.id,
  }
}

// ── Exports ───────────────────────────────────────────────────────────────────

/**
 * Find open time_entries where:
 * - clock_out IS NULL
 * - alerted_at IS NULL
 * - shift end time was > 30 min ago
 *
 * Returns array of mapped entry objects.
 *
 * @param {string} groupId
 * @param {Date} now - reference time (defaults to now)
 * @param {object|null} db - injection for testing
 */
export async function getMissedClockOuts(groupId, now = new Date(), db = null) {
  try {
    if (db?.getMissedClockOuts) {
      return await db.getMissedClockOuts(groupId)
    }

    const rows = await _fetchOpenEntries(groupId)
    const THIRTY_MIN_MS = 30 * 60 * 1000

    return rows
      .map(_mapRow)
      .filter((entry) => {
        const shiftEnd = buildShiftEndDatetime(entry.shiftEndTime, now)
        return now.getTime() > shiftEnd.getTime() + THIRTY_MIN_MS
      })
  } catch (err) {
    console.error(`getMissedClockOuts failed: ${err.message}`)
    return []
  }
}

/**
 * DM the staff member about their missed clock-out.
 * Updates time_entries.alerted_at to prevent duplicate alerts.
 *
 * @param {object} bot - Telegram bot instance
 * @param {object} entry - entry from getMissedClockOuts
 * @param {object|null} db - injection for testing
 */
export async function sendMissedClockOutAlert(bot, entry, db = null) {
  try {
    if (!entry.dmChatId) return

    const message =
      `⏰ Your ${entry.shiftName} shift ended at ${entry.shiftEndTime}.\n` +
      `Did you forget to clock out?\n` +
      `Reply *clock out* to log your time,\n` +
      `or *still working* if you're still there.`

    await bot.sendMessage(entry.dmChatId, message, { parse_mode: 'Markdown' })

    if (db?.markAlerted) {
      await db.markAlerted(entry.clockEntryId)
    } else {
      try {
        const supabase = getDb()
        const { error } = await supabase
          .from('time_entries')
          .update({ alerted_at: new Date().toISOString() })
          .eq('id', entry.clockEntryId)
        if (error) throw error
      } catch (err) {
        console.error(`markAlerted failed: ${err.message}`)
      }
    }
  } catch (err) {
    console.error(`sendMissedClockOutAlert failed: ${err.message}`)
  }
}

/**
 * Get the manager's DM chat ID from setup_sessions.
 *
 * @param {string} groupId
 * @param {object|null} db - injection for testing
 */
async function _getManagerDmChatId(groupId, db = null) {
  if (db?.getManagerDmChatId) return db.getManagerDmChatId(groupId)
  try {
    const supabase = getDb()
    const { data, error } = await supabase
      .from('setup_sessions')
      .select('dm_chat_id')
      .eq('group_id', groupId)
      .maybeSingle()
    if (error) throw error
    return data?.dm_chat_id ?? null
  } catch (err) {
    console.error(`_getManagerDmChatId failed: ${err.message}`)
    return null
  }
}

/**
 * Called from a 15-min cron job.
 * 1. Gets missed clock-outs for the group.
 * 2. DMs each staff member an alert.
 * 3. Sends a summary to the manager.
 * 4. Does nothing if no missed entries.
 *
 * @param {object} bot - Telegram bot instance
 * @param {string} groupId
 * @param {object|null} db - injection for testing
 */
export async function handleMissedClockOutCheck(bot, groupId, db = null) {
  try {
    const missed = await getMissedClockOuts(groupId, new Date(), db)

    if (missed.length === 0) return

    // Alert each staff member
    for (const entry of missed) {
      await sendMissedClockOutAlert(bot, entry, db)
    }

    // Alert manager
    const managerChatId = await _getManagerDmChatId(groupId, db)
    if (!managerChatId) return

    const now = new Date()
    const lines = missed.map((entry) => {
      const shiftEnd = buildShiftEndDatetime(entry.shiftEndTime, now)
      const minsAgo = Math.round((now.getTime() - shiftEnd.getTime()) / 60000)
      return `• ${entry.staffName} — ${entry.shiftName} (ended ${minsAgo}min ago)`
    })

    const managerMsg = `⚠️ Possible missed clock-outs:\n${lines.join('\n')}`
    await bot.sendMessage(managerChatId, managerMsg)
  } catch (err) {
    console.error(`handleMissedClockOutCheck failed: ${err.message}`)
  }
}
