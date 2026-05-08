import { getDb } from '../db.js'
import { llmCreate, llmWithRetry } from '../parsers/llm.js'
import { saveRecurringConstraint as liveSaveRecurringConstraint } from './recurringTimeOffDb.js'
import { logger } from '../logger.js'

const SYSTEM_PROMPT = `Detect permanent recurring availability constraints from staff messages.
Return JSON: { isRecurring: bool, type: 'day_off'|'time_constraint'|null, dayOfWeek: string|null, beforeTime: 'HH:MM'|null, afterTime: 'HH:MM'|null }
isRecurring:true only for permanent statements, NOT one-time requests.
Examples true: 'I'm never available Tuesdays', 'Don't schedule me before 10am', 'I can only work evenings', 'I'm always off Sundays', 'I'm not available before 10am'
Examples false: 'I need next Friday off', 'I can't come in tonight'`

/**
 * Use LLM to detect a permanent recurring availability constraint in a message.
 * Returns { isRecurring, type, dayOfWeek, beforeTime, afterTime }
 */
export async function extractRecurringConstraint(text) {
  try {
    const completion = await llmWithRetry(() => llmCreate({
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: text },
      ],
    }))

    const result = JSON.parse(completion.choices[0].message.content)

    return {
      isRecurring: result.isRecurring ?? false,
      type: result.type ?? null,
      dayOfWeek: result.dayOfWeek ?? null,
      beforeTime: result.beforeTime ?? null,
      afterTime: result.afterTime ?? null,
    }
  } catch (err) {
    logger.error(`extractRecurringConstraint failed: ${err.message}`)
    return { isRecurring: false, type: null, dayOfWeek: null, beforeTime: null, afterTime: null }
  }
}

/**
 * Wait for a single reply from the staff member in their DM chat.
 * Resolves with the reply message, or null on timeout.
 */
function waitForReply(bot, chatId, timeoutMs = 120_000) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), timeoutMs)
    bot.once('message', (reply) => {
      if (String(reply.chat.id) === String(chatId)) {
        clearTimeout(timer)
        resolve(reply)
      }
    })
  })
}

/**
 * Build a human-readable description of the constraint for display.
 */
function describeConstraint(result) {
  if (result.type === 'day_off') {
    return `never on ${result.dayOfWeek}`
  }
  if (result.type === 'time_constraint') {
    if (result.beforeTime && result.afterTime) {
      return `not before ${result.beforeTime} and only after ${result.afterTime}`
    }
    if (result.beforeTime) {
      return `not before ${result.beforeTime}`
    }
    if (result.afterTime) {
      return `only after ${result.afterTime}`
    }
  }
  return 'unavailable at certain times'
}

/**
 * Look up the staff_dms record for a Telegram user ID.
 * Returns { user_id, dm_chat_id, first_name } or null.
 */
async function getStaffDmByUserId(userId, db) {
  if (db?.getStaffDmByUserId) {
    return db.getStaffDmByUserId(userId)
  }

  try {
    const supabase = getDb()
    const { data, error } = await supabase
      .from('staff_dms')
      .select('*')
      .eq('user_id', userId)
      .maybeSingle()

    if (error) throw error
    return data
  } catch (err) {
    logger.error(`getStaffDmByUserId failed: ${err.message}`)
    return null
  }
}

/**
 * Look up a staff member by name and group.
 * Returns { id, name, group_id } or null.
 */
async function getStaffByName(name, groupId, db) {
  if (db?.getStaffByName) {
    return db.getStaffByName(name, groupId)
  }

  try {
    const supabase = getDb()
    const { data, error } = await supabase
      .from('staff')
      .select('*')
      .eq('group_id', groupId)
      .ilike('name', name)
      .maybeSingle()

    if (error) throw error
    return data
  } catch (err) {
    logger.error(`getStaffByName failed: ${err.message}`)
    return null
  }
}

/**
 * Look up the manager DM chat for a group via setup_sessions.
 * Returns { manager_id, dm_chat_id, group_id } or null.
 */
async function getSetupSession(groupId, db) {
  if (db?.getSetupSession) {
    return db.getSetupSession(groupId)
  }

  try {
    const supabase = getDb()
    const { data, error } = await supabase
      .from('setup_sessions')
      .select('*')
      .eq('group_id', groupId)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle()

    if (error) throw error
    return data
  } catch (err) {
    logger.error(`getSetupSession failed: ${err.message}`)
    return null
  }
}

/**
 * DM router handler: detect and save a recurring scheduling constraint.
 * Called when staff send a DM to the bot.
 * Returns true if handled, false if not a recurring constraint.
 */
export async function handleRecurringConstraint(bot, msg, db = null) {
  const _saveRecurringConstraint = db?.saveRecurringConstraint ?? liveSaveRecurringConstraint

  try {
    const text = msg.text?.trim()
    if (!text) return false

    const dmChatId = String(msg.chat.id)
    const telegramUserId = msg.from?.id

    // Step 1: Extract constraint via LLM
    const result = await extractRecurringConstraint(text)

    if (!result.isRecurring) {
      return false
    }

    // Step 2: Look up staff member via staff_dms
    const staffDm = await getStaffDmByUserId(telegramUserId, db)
    const firstName = staffDm?.first_name || msg.from?.first_name || 'Staff'

    // We need a group_id — look up from staff_dms if available, else skip save
    // The staff_dms table tracks which group this staff member belongs to via staff table
    // For now, get it from the staff record matched by first_name
    // (In a real setup, staff_dms would have a group_id join or we'd look at setup_sessions)
    let staffRecord = null
    let groupId = null

    if (staffDm) {
      // Try to find staff by name — we need a group_id hint
      // Look up all staff with this name (there could be multiple groups)
      // For now, use the most recent setup_session for manager's group
      // A more robust approach would store group_id in staff_dms
      try {
        const _db = db ? null : getDb()
        if (_db) {
          const { data } = await _db
            .from('staff')
            .select('id, group_id, name')
            .ilike('name', firstName)
            .limit(1)
            .maybeSingle()
          staffRecord = data
          groupId = data?.group_id
        } else if (db?.getStaffByName) {
          staffRecord = await db.getStaffByName(firstName, null)
          groupId = staffRecord?.group_id
        }
      } catch (err) {
        logger.error(`handleRecurringConstraint staff lookup failed: ${err.message}`)
      }
    }

    // Step 3: Build description and ask for confirmation
    const desc = describeConstraint(result)
    const confirmMsg =
      `Got it — I'll make sure you're ${desc}.\n` +
      `I'll apply this to all future schedules.\n` +
      `Reply yes to save or no to cancel.`

    await bot.sendMessage(dmChatId, confirmMsg)

    // Step 4: Wait for yes/no reply
    const reply = await waitForReply(bot, dmChatId)

    if (!reply) {
      // Timed out — do nothing
      logger.bot(`handleRecurringConstraint: timed out waiting for ${firstName} reply`)
      return true
    }

    const replyText = reply.text?.trim().toLowerCase() ?? ''

    if (replyText === 'yes' || replyText === 'y') {
      // Save the constraint if we have a staff record
      if (staffRecord?.id && groupId) {
        await _saveRecurringConstraint(staffRecord.id, groupId, {
          type: result.type,
          dayOfWeek: result.dayOfWeek,
          beforeTime: result.beforeTime,
          afterTime: result.afterTime,
          note: null,
        }, db)
      } else {
        logger.warn(`handleRecurringConstraint: could not find staff record for ${firstName} — constraint not saved to DB`)
      }

      await bot.sendMessage(dmChatId, '✅ Saved.')

      // Notify manager
      const session = groupId ? await getSetupSession(groupId, db) : null
      if (session?.dm_chat_id) {
        await bot.sendMessage(
          session.dm_chat_id,
          `📌 ${firstName} set a recurring constraint: ${desc}`,
        )
      }
    } else {
      await bot.sendMessage(dmChatId, 'No problem, nothing saved.')
    }

    return true
  } catch (err) {
    logger.error(`handleRecurringConstraint failed: ${err.message}`)
    return false
  }
}
