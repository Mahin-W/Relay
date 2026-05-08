/**
 * managerCoverage.js
 *
 * Handles manager-initiated coverage requests:
 *  - detectManagerCoverageRequest  — LLM intent detection
 *  - handleManagerCoveragePost     — full flow: verify admin, match shift, broadcast
 *  - handleCoverageCommand         — /coverage command entry point
 *
 * SQL migration required:
 *   ALTER TABLE coverage_requests ADD COLUMN IF NOT EXISTS initiated_by TEXT DEFAULT 'staff';
 */

import { getDb } from '../db.js'
import { llmCreate, llmWithRetry } from '../parsers/llm.js'
import { logger } from '../logger.js'

// ── Live DB functions ─────────────────────────────────────────────────────────

async function getShiftsForGroup(groupId) {
  try {
    const supabase = getDb()
    const { data, error } = await supabase
      .from('shifts')
      .select('*')
      .eq('group_id', groupId)
      .order('day_of_week')
      .order('start_time')
    if (error) throw error
    return data ?? []
  } catch (err) {
    logger.error(`getShiftsForGroup failed: ${err.message}`)
    return []
  }
}

async function saveCoverageRequest(groupId, groupName, shiftDescription, initiatedBy = 'manager') {
  try {
    const supabase = getDb()
    const { data, error } = await supabase
      .from('coverage_requests')
      .insert({
        group_id: groupId,
        group_name: groupName,
        shift_description: shiftDescription,
        requested_by: 'manager',
        initiated_by: initiatedBy,
      })
      .select()
      .single()
    if (error) throw error
    return data
  } catch (err) {
    logger.error(`saveCoverageRequest failed: ${err.message}`)
    return null
  }
}

async function getGroupMembersWithDm(groupId) {
  try {
    const supabase = getDb()
    const { data, error } = await supabase
      .from('group_members')
      .select('user_id, first_name, staff_dms!inner(dm_chat_id)')
      .eq('group_id', groupId)
      .not('staff_dms.dm_chat_id', 'is', null)
    if (error) throw error
    return (data ?? []).map(row => ({
      userId: row.user_id,
      firstName: row.first_name,
      dmChatId: row.staff_dms?.dm_chat_id ?? null,
    }))
  } catch (err) {
    logger.error(`getGroupMembersWithDm failed: ${err.message}`)
    return []
  }
}

// ── LLM system prompt ─────────────────────────────────────────────────────────

const MANAGER_COVERAGE_SYSTEM_PROMPT = `You are an intent classifier for a restaurant staff management bot.

Determine if the manager's message is explicitly seeking to post a coverage request for a shift — i.e., the manager wants to find someone to cover a shift.

Return a JSON object with these exact fields:
{
  "isManagerCoverage": boolean,
  "shiftName": string | null,
  "dayOfWeek": string | null
}

"isManagerCoverage" must be TRUE when the manager is clearly looking for someone to cover a specific shift, e.g.:
- "post coverage for Friday dinner"
- "we need someone for Saturday lunch"
- "looking for coverage tomorrow night"
- "need a server for tonight"

"isManagerCoverage" must be FALSE when:
- The message is from a staff member calling out (e.g. "I can't come in tonight")
- The message is ambiguous with no explicit manager intent (e.g. "can anyone cover" alone)
- The message is about something else entirely

"shiftName": match against the provided shift list if possible, or return the best match from the message text. Return null if no shift is identifiable.
"dayOfWeek": the day of week if mentioned (e.g. "Friday"), or null.

Only set isManagerCoverage to true when the MANAGER is explicitly seeking coverage from staff — not when staff are initiating.`

// ── detectManagerCoverageRequest ──────────────────────────────────────────────

export async function detectManagerCoverageRequest(text, shiftNames) {
  try {
    const shiftList = shiftNames.length > 0
      ? `Available shifts: ${shiftNames.join(', ')}`
      : 'No shifts provided.'

    const completion = await llmWithRetry(() =>
      llmCreate({
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: MANAGER_COVERAGE_SYSTEM_PROMPT },
          { role: 'user', content: `${shiftList}\n\nMessage: "${text}"` },
        ],
      })
    )

    const result = JSON.parse(completion.choices[0].message.content)
    return {
      isManagerCoverage: result.isManagerCoverage === true,
      shiftName: result.shiftName ?? null,
      dayOfWeek: result.dayOfWeek ?? null,
    }
  } catch (err) {
    logger.error(`detectManagerCoverageRequest failed: ${err.message}`)
    return { isManagerCoverage: false, shiftName: null, dayOfWeek: null }
  }
}

// ── Shift matching helpers ────────────────────────────────────────────────────

/**
 * Returns shifts whose name matches shiftName (case-insensitive, partial).
 * Falls back to dayOfWeek matching if shiftName is very short.
 */
function matchShifts(shifts, shiftName, dayOfWeek) {
  if (!shiftName && !dayOfWeek) return []

  const nameLower = shiftName?.toLowerCase() ?? ''
  const dayLower = dayOfWeek?.toLowerCase() ?? ''

  // Score each shift — higher = better match
  const scored = shifts.map(s => {
    const sName = s.name.toLowerCase()
    const sDay = (s.day_of_week ?? '').toLowerCase()
    let score = 0

    if (nameLower && sName.includes(nameLower)) score += 2
    if (nameLower && nameLower.includes(sName)) score += 1
    if (dayLower && sDay === dayLower) score += 1

    // Check individual words in the intent shiftName against shift name
    if (nameLower) {
      const words = nameLower.split(/\s+/).filter(w => w.length > 2)
      for (const w of words) {
        if (sName.includes(w)) score += 1
      }
    }

    return { shift: s, score }
  })

  const maxScore = Math.max(...scored.map(s => s.score))
  if (maxScore === 0) return []

  return scored.filter(s => s.score === maxScore).map(s => s.shift)
}

function formatShiftLabel(shift) {
  return `${shift.name} (${shift.day_of_week}, ${shift.start_time}–${shift.end_time})`
}

// ── handleManagerCoveragePost ─────────────────────────────────────────────────

export async function handleManagerCoveragePost(bot, msg, intent, db = null) {
  try {
    const _getShiftsForGroup = db?.getShiftsForGroup ?? getShiftsForGroup
    const _saveCoverageRequest = db?.saveCoverageRequest ?? saveCoverageRequest
    const _getGroupMembersWithDm = db?.getGroupMembersWithDm ?? getGroupMembersWithDm

    const groupId = String(msg.chat.id)
    const groupName = msg.chat.title || 'Unknown Group'
    const userId = msg.from?.id
    const managerChatId = String(userId)

    // 1. Verify admin status
    try {
      const member = await bot.getChatMember(groupId, userId)
      if (!['administrator', 'creator'].includes(member?.status)) {
        // Non-admin — return silently
        return
      }
    } catch (err) {
      logger.error(`getChatMember failed: ${err.message}`)
      return
    }

    // 2. Load shifts for group
    const shifts = await _getShiftsForGroup(groupId)

    // 3. Match shifts
    const shiftName = intent.shiftName ?? null
    const dayOfWeek = intent.dayOfWeek ?? null
    const matches = matchShifts(shifts, shiftName, dayOfWeek)

    if (matches.length === 0) {
      // No match — DM manager with error
      const shiftList = shifts.length > 0
        ? shifts.map(s => `• ${s.name}`).join('\n')
        : '(no shifts configured)'
      await bot.sendMessage(
        managerChatId,
        `Couldn't find that shift. Your shifts:\n${shiftList}\n\nTry /coverage [name]`,
        { parse_mode: 'Markdown' }
      )
      return
    }

    if (matches.length > 1) {
      // Multiple matches — send disambiguation
      const list = matches
        .map((s, i) => `${i + 1}. ${s.name} (${s.start_time}–${s.end_time})`)
        .join('\n')
      await bot.sendMessage(
        managerChatId,
        `Which shift?\n${list}\nReply 1 or ${matches.length}.`,
        { parse_mode: 'Markdown' }
      )
      return
    }

    // 5. Single match — insert coverage_request with initiated_by='manager'
    const shift = matches[0]
    const shiftDesc = `${shift.name} — ${shift.day_of_week}, ${shift.start_time}–${shift.end_time}`

    await _saveCoverageRequest(groupId, groupName, shiftDesc, 'manager')

    // 6. Post to group
    const groupText =
      `📢 *Coverage needed*\n` +
      `${shift.name} — ${shift.day_of_week}, ${shift.start_time}–${shift.end_time}\n` +
      `Can you cover? Reply here or DM me.`
    await bot.sendMessage(groupId, groupText, { parse_mode: 'Markdown' })
    logger.bot(`Manager coverage request posted in ${groupName}: ${shift.name}`)

    // 7. Broadcast to eligible staff via DMs
    const staff = await _getGroupMembersWithDm(groupId)
    for (const member of staff) {
      if (!member.dmChatId) continue
      try {
        const dmText =
          `🔔 *Coverage Needed — ${groupName}*\n\n` +
          `*Shift:* ${formatShiftLabel(shift)}\n\n` +
          `Can you cover it? Reply *yes* to volunteer ✋`
        await bot.sendMessage(member.dmChatId, dmText, { parse_mode: 'Markdown' })
        logger.bot(`Staff DM sent to ${member.firstName}`)
      } catch (err) {
        logger.error(`Failed to DM staff ${member.firstName}: ${err.message}`)
      }
    }

    // 8. Notify manager DM
    await bot.sendMessage(
      managerChatId,
      `Coverage request posted for *${shift.name}*. I'll let you know when someone confirms.`,
      { parse_mode: 'Markdown' }
    )
  } catch (err) {
    logger.error(`handleManagerCoveragePost failed: ${err.message}`)
  }
}

// ── handleCoverageCommand ─────────────────────────────────────────────────────

export async function handleCoverageCommand(bot, msg, match, db = null) {
  try {
    const userId = msg.from?.id
    const managerChatId = String(userId)
    const shiftText = (match[1] ?? '').trim()

    if (!shiftText) {
      // Empty match — prompt manager
      await bot.sendMessage(
        managerChatId,
        `Which shift needs coverage?\n/coverage Friday dinner`,
        { parse_mode: 'Markdown' }
      )
      return
    }

    // Build intent from the text — use basic word extraction, no LLM needed here
    const intent = {
      shiftName: shiftText,
      dayOfWeek: null,
    }

    await handleManagerCoveragePost(bot, msg, intent, db)
  } catch (err) {
    logger.error(`handleCoverageCommand failed: ${err.message}`)
  }
}
