import { createClient } from '@supabase/supabase-js'
import { groq, groqWithRetry, GROQ_MODEL } from '../parsers/groq.js'
import { logger } from '../logger.js'

const getSupabase = () =>
  createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY)

const SYSTEM_PROMPT = `Detect when staff are telling you their general permanent availability window.
Return JSON: { isWindowUpdate: bool, daysAvailable: string[]|null, beforeTime: "HH:MM"|null, afterTime: "HH:MM"|null }
isWindowUpdate:true only for permanent general availability statements, not one-time requests.
Examples true: "I'm not available before 10am", "I can only work weekends",
"available Mon-Fri only", "I can work any time after 2pm"
Examples false: "I can cover tonight", "my pay", "I need Friday off"
For daysAvailable, use full day names: Monday, Tuesday, Wednesday, Thursday, Friday, Saturday, Sunday.
For times use 24-hour HH:MM format.`

// ── extractAvailabilityWindow ─────────────────────────────────────────────────

export async function extractAvailabilityWindow(text) {
  try {
    const completion = await groqWithRetry(() => groq.chat.completions.create({
      model: GROQ_MODEL,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: text },
      ],
    }))
    const result = JSON.parse(completion.choices[0].message.content)
    return {
      isWindowUpdate: Boolean(result.isWindowUpdate),
      daysAvailable: result.daysAvailable ?? null,
      beforeTime: result.beforeTime ?? null,
      afterTime: result.afterTime ?? null,
    }
  } catch (err) {
    logger.error(`extractAvailabilityWindow failed: ${err.message}`)
    return { isWindowUpdate: false, daysAvailable: null, beforeTime: null, afterTime: null }
  }
}

// ── formatWindowDescription ───────────────────────────────────────────────────

const WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday']
const WEEKEND_DAYS = ['Saturday', 'Sunday']

function to12h(timeStr) {
  if (!timeStr) return null
  const [hStr, mStr] = timeStr.split(':')
  const h = parseInt(hStr, 10)
  const m = parseInt(mStr, 10)
  const suffix = h < 12 ? 'am' : 'pm'
  const hour12 = h === 0 ? 12 : h > 12 ? h - 12 : h
  const minutePart = m === 0 ? '' : `:${String(m).padStart(2, '0')}`
  return `${hour12}${minutePart}${suffix}`
}

function shortDayName(day) {
  return day.slice(0, 3)
}

export function formatWindowDescription(window) {
  const { daysAvailable, beforeTime, afterTime } = window ?? {}
  const parts = []

  if (daysAvailable && daysAvailable.length > 0) {
    const sorted = [...daysAvailable].sort((a, b) => {
      const order = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']
      return order.indexOf(a) - order.indexOf(b)
    })

    const isWeekend =
      sorted.length === 2 &&
      sorted.includes('Saturday') &&
      sorted.includes('Sunday')

    const isMonFri =
      sorted.length === 5 &&
      WEEKDAYS.every(d => sorted.includes(d))

    if (isWeekend) {
      parts.push('weekends only (Sat\u2013Sun)')
    } else if (isMonFri) {
      parts.push('Mon\u2013Fri only')
    } else {
      const names = sorted.map(shortDayName)
      if (names.length === 1) {
        parts.push(`${sorted[0]} only`)
      } else {
        parts.push(`${names.join(', ')} only`)
      }
    }
  }

  if (afterTime) {
    parts.push(`available after ${to12h(afterTime)}`)
  }

  if (beforeTime) {
    parts.push(`not available before ${to12h(beforeTime)}`)
  }

  return parts.join(', ')
}

// ── saveAvailabilityWindow ────────────────────────────────────────────────────

export async function saveAvailabilityWindow(staffId, groupId, window, db = null) {
  const _save = db?.saveAvailabilityWindow ?? _saveAvailabilityWindowReal
  try {
    return await _save(staffId, groupId, window)
  } catch (err) {
    logger.error(`saveAvailabilityWindow failed: ${err.message}`)
    return null
  }
}

async function _saveAvailabilityWindowReal(staffId, groupId, window) {
  const supabase = getSupabase()
  const { daysAvailable, beforeTime, afterTime } = window ?? {}
  const { data, error } = await supabase
    .from('staff_availability_windows')
    .upsert(
      {
        staff_id: staffId,
        group_id: groupId,
        days_available: daysAvailable ?? null,
        before_time: beforeTime ?? null,
        after_time: afterTime ?? null,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'staff_id' }
    )
    .select()
    .single()
  if (error) throw error
  return data
}

// ── getAvailabilityWindow ─────────────────────────────────────────────────────

export async function getAvailabilityWindow(staffId, db = null) {
  const _get = db?.getAvailabilityWindow ?? _getAvailabilityWindowReal
  try {
    return await _get(staffId)
  } catch (err) {
    logger.error(`getAvailabilityWindow failed: ${err.message}`)
    return null
  }
}

async function _getAvailabilityWindowReal(staffId) {
  const supabase = getSupabase()
  const { data, error } = await supabase
    .from('staff_availability_windows')
    .select('*')
    .eq('staff_id', staffId)
    .maybeSingle()
  if (error) throw error
  return data ?? null
}

// ── handleAvailabilityWindowUpdate ────────────────────────────────────────────
// Called from DM router. Returns bool (true = handled).

export async function handleAvailabilityWindowUpdate(bot, msg, db = null) {
  const _extract = db?.extractAvailabilityWindow ?? extractAvailabilityWindow
  const _getStaff = db?.getStaffByUserId ?? _getStaffByUserIdReal
  const _getSession = db?.getSetupSession ?? _getSetupSessionReal
  const _save = db?.saveAvailabilityWindow
    ? (staffId, groupId, window) => db.saveAvailabilityWindow(staffId, groupId, window)
    : (staffId, groupId, window) => saveAvailabilityWindow(staffId, groupId, window)

  try {
    const result = await _extract(msg.text)
    if (!result.isWindowUpdate) return false

    // Look up staff by telegram user ID in staff_dms
    const staffRow = await _getStaff(msg.from.id, db)
    if (!staffRow) {
      logger.bot(`handleAvailabilityWindowUpdate: no staff found for user ${msg.from.id}`)
      return false
    }

    const desc = formatWindowDescription(result)
    const dmChatId = String(msg.chat.id)

    // Prompt staff to confirm
    await bot.sendMessage(
      dmChatId,
      `Got it \u2014 I'll remember you're available ${desc}. This affects future schedule requests.\nReply yes to save or no to cancel.`
    )

    // Wait for yes/no reply by registering a one-shot listener via oncePending pattern.
    // Since this runs in a request/response handler (not streaming), we set up a pending
    // state that the router will check on the next DM from this chat.
    if (db?.pendingWindow !== undefined) {
      // In tests, db.pendingWindow is an object we can write to
      db.pendingWindow[dmChatId] = { staffRow, groupId: staffRow.group_id, window: result }
    } else {
      // Production: store in a module-level pending map
      _pendingWindows.set(dmChatId, { staffRow, groupId: staffRow.group_id, window: result })
    }

    return true
  } catch (err) {
    logger.error(`handleAvailabilityWindowUpdate failed: ${err.message}`)
    return false
  }
}

// Module-level map for production use (stores pending confirmations)
const _pendingWindows = new Map()

// Called from DM router after a yes/no reply
export async function handleWindowConfirmReply(bot, msg, db = null) {
  const _getSession = db?.getSetupSession ?? _getSetupSessionReal
  const _save = db?.saveAvailabilityWindow
    ? (staffId, groupId, window) => db.saveAvailabilityWindow(staffId, groupId, window)
    : (staffId, groupId, window) => saveAvailabilityWindow(staffId, groupId, window)

  const dmChatId = String(msg.chat.id)

  let pending
  if (db?.pendingWindow !== undefined) {
    pending = db.pendingWindow[dmChatId]
  } else {
    pending = _pendingWindows.get(dmChatId)
  }

  if (!pending) return false

  try {
    const reply = (msg.text ?? '').trim().toLowerCase()

    if (reply === 'yes' || reply === 'y') {
      await _save(pending.staffRow.id, pending.groupId, pending.window)
      await bot.sendMessage(dmChatId, '\u2705 Saved.')

      // DM manager
      const session = await _getSession(pending.groupId)
      if (session?.dm_chat_id) {
        const desc = formatWindowDescription(pending.window)
        await bot.sendMessage(
          session.dm_chat_id,
          `${pending.staffRow.name} updated availability: ${desc}`
        )
      }

      if (db?.pendingWindow !== undefined) {
        delete db.pendingWindow[dmChatId]
      } else {
        _pendingWindows.delete(dmChatId)
      }
      return true
    }

    if (reply === 'no' || reply === 'n') {
      await bot.sendMessage(dmChatId, 'No problem.')
      if (db?.pendingWindow !== undefined) {
        delete db.pendingWindow[dmChatId]
      } else {
        _pendingWindows.delete(dmChatId)
      }
      return true
    }

    return false
  } catch (err) {
    logger.error(`handleWindowConfirmReply failed: ${err.message}`)
    return false
  }
}

// ── Real DB helpers (production only) ────────────────────────────────────────

async function _getStaffByUserIdReal(telegramUserId) {
  const supabase = getSupabase()
  try {
    // Look up in staff_dms to get user info, then join to staff
    const { data: dmRow } = await supabase
      .from('staff_dms')
      .select('user_id, first_name, dm_chat_id')
      .eq('user_id', telegramUserId)
      .maybeSingle()
    if (!dmRow) return null

    // Find the staff row linked to this telegram user
    const { data: staffRow } = await supabase
      .from('staff')
      .select('id, group_id, name, role')
      .eq('name', dmRow.first_name)
      .maybeSingle()
    return staffRow ?? null
  } catch (err) {
    logger.error(`_getStaffByUserIdReal failed: ${err.message}`)
    return null
  }
}

async function _getSetupSessionReal(groupId) {
  const supabase = getSupabase()
  try {
    const { data } = await supabase
      .from('setup_sessions')
      .select('group_id, manager_id, dm_chat_id')
      .eq('group_id', groupId)
      .maybeSingle()
    return data ?? null
  } catch (err) {
    logger.error(`_getSetupSessionReal failed: ${err.message}`)
    return null
  }
}
